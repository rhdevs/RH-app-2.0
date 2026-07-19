import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { env } from "~/env";
import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
  roleManagerProcedure,
} from "../trpc";
import {
  evaluateBooking,
  getEnforcementMode,
  getFacilityRequiredRoles,
  getUserRoles,
} from "../services/access";
import {
  ADMIN_ROLE,
  BASELINE_ROLE,
  CCA_HEAD_ROLE,
  FACILITY_ROLES,
  GRANTABLE_ROLES,
  JCRC_ROLE,
  assignableBy,
  asStoredCanonicalUserID,
  canonicalUserID,
  type CanonicalUserID,
  computeCapabilities,
  isGrantableRole,
  isEFormatUserID,
  isNusStudentEmail,
  legacyMirror,
  revocableFromOthersBy,
  userIDSchema,
  type Capabilities,
  type GrantableRole,
} from "../services/roles";

/**
 * The admin / role-management router (02-backend-authz.md §§6-8).
 *
 * WHAT LIVES HERE AND WHY IT IS ONE FILE. The plan's file map splits this
 * across `roleService.ts` (guards + audit), `capabilities.ts`
 * (`requireCapability`) and `admin.ts` (procedures). They are consolidated here
 * by explicit instruction, following the same consolidation the core RBAC agent
 * applied to roles.ts/access.ts. The split was never load-bearing in this
 * direction: every caller of the guards is a procedure in this file, and
 * `requireCapability` could not live in roles.ts anyway because it needs
 * TRPCError and roles.ts is deliberately runtime-pure so client components can
 * import the vocabulary (roles.ts header). If a second router ever needs the
 * chokepoint, lift sections A/B into `services/roleService.ts` verbatim — they
 * take a `PrismaClient` and know nothing about tRPC context.
 *
 * THE ONE RULE FOR ANYONE EDITING THIS FILE: there is exactly ONE write to
 * `UserRole.roles` on the generic role path (`applyRoleChange`) and exactly one
 * on the CCA path (`writeCcaHeadString`). Both construct the written set so
 * that `resident` cannot be absent from it (I-8c). Adding a third writer, or
 * writing a client-supplied array, silently strips the booking baseline from
 * whoever it touches.
 */

/* ========================================================================== */
/* SECTION A — schemas, capability assertion, plan tokens                     */
/* ========================================================================== */

/**
 * Roles are keyed on the canonical E-format id. Re-enforced in guard G7.
 *
 * Defined in `../services/roles` so the audit-log filter UI can parse with the
 * SAME predicate instead of a hand-rolled `/^E\d{7}$/` that rejects what this
 * accepts and then silently drops the filter (I-12, 09 §2.6). Behaviour here is
 * unchanged at all 11 input sites.
 */

/**
 * z.enum, never z.string() — unknown strings die at the boundary.
 *
 * `resident` is absent because it is absent from GRANTABLE_ROLES (I-8e), so a
 * payload cannot express it in EITHER direction: not to grant it, and — because
 * `removed` is computed from a grantable-only `before` — not to remove it.
 * `cca_head` IS expressible here and is then rejected by the delta guard,
 * because ASSIGNABLE_BY / REVOCABLE_FROM_OTHERS_BY contain it for nobody
 * (I-14). It travels only the dedicated CCA endpoints below.
 */
const roleSchema = z.enum(GRANTABLE_ROLES);

/**
 * Facilities require a DIFFERENT vocabulary than users are granted: `resident`
 * is requirable but not grantable, and `admin` is grantable but must never be
 * stored as a requirement (it is an implicit bypass; storing it invites someone
 * to delete it and lock every admin out of a room). min(1) removes the ambiguous
 * empty state from the write path, since [] and missing-row are now the same
 * state (I-10).
 */
const facilityRoleSchema = z.enum(FACILITY_ROLES);

/**
 * Prisma's Mongo `contains` compiles to $regex. Unescaped operator input is a
 * catastrophic-backtracking vector, and role managers are students.
 */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const listInput = z.object({
  search: z.string().trim().max(100).optional(),
  role: roleSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

/**
 * Server-side capability assertion. Use in EVERY procedure whose gate is a
 * capability rather than a bare role — the procedure middleware only answers
 * "may they reach the surface", this answers "may they do this thing".
 */
function requireCapability<K extends keyof Capabilities>(
  caps: Capabilities,
  key: K,
): void {
  const v = caps[key];
  if (v === false || (Array.isArray(v) && v.length === 0)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `CAPABILITY_REQUIRED:${String(key)}`,
    });
  }
}

const caps = (roles: readonly string[] | undefined) =>
  computeCapabilities(roles ?? []);

/* -- bulk plan tokens ------------------------------------------------------ */

/** Preview→commit binding lifetime. Long enough for a 1000-row wizard. */
const PLAN_TTL_MS = 30 * 60 * 1000;

/**
 * The low-confidence / resolution gate must be SERVER-enforced: a `confirmed:
 * true` boolean from the client is not evidence, and `expectedBefore` is not a
 * secret (it is just the target's current roles, obtainable from listUsers).
 * So every previewed row is signed, and commitBulkChunk will not act on a tuple
 * it did not itself produce.
 *
 * Signed PER ROW rather than as one blob over the whole plan: the client commits
 * in 25-row chunks and must be able to resume a truncated chunk, so the server
 * has to verify a subset without holding per-batch state between requests.
 */
function planSecret(): string {
  const s = env.NEXTAUTH_SECRET;
  if (!s) {
    // Fail closed. Without a secret the token is unforgeable-by-nobody, which
    // is worse than an outage of the bulk surface.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "PLAN_TOKEN_SECRET_MISSING",
    });
  }
  return s;
}

type SignedRow = {
  batchId: string;
  actorUserID: string;
  expiresAt: number;
  /**
   * THE IMPORT MODE IS PART OF THE SIGNATURE, and it is not optional.
   *
   * The token exists so that the signed tuple DETERMINES what the server will
   * do. Without `mode` it did not: `beginBulkImport` takes a client-supplied
   * mode and a client-supplied batchId with no check that either matches the
   * preview, and `commitBulkChunk` derives `requested` from `header.mode`. So a
   * plan previewed as additive (`add`, roles ["jcrc"], expectedBefore matching)
   * could be committed as `set` — every rowToken still verifies, the drift
   * check still passes because expectedBefore is unchanged, and `removed`
   * becomes `before \ ["jcrc"]`: an additive plan the operator reviewed
   * silently executes as a mass demotion.
   *
   * Signing the mode makes a mode swap fail closed. commitBulkChunk recomputes
   * with the mode it is ABOUT TO APPLY, so if the header disagrees with the
   * preview every row returns PLAN_TOKEN_INVALID and nothing is written.
   */
  mode: string;
  userID: string;
  roles: string[];
  expectedBefore: string[];
  via: string;
  confidence: string;
};

function signRow(r: SignedRow): string {
  const payload = [
    r.batchId,
    r.actorUserID,
    String(r.expiresAt),
    r.mode,
    r.userID,
    [...r.roles].sort().join("+"),
    [...r.expectedBefore].sort().join("+"),
    r.via,
    r.confidence,
  ].join("|");
  return createHmac("sha256", planSecret()).update(payload).digest("hex");
}

/** Constant-time compare — a length-leaking `===` on an HMAC is a bad habit. */
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -- identifier resolution ------------------------------------------------- */

/**
 * Tier-ordered resolution, restricted to the two HIGH-CONFIDENCE tiers.
 *
 * The plan's full resolver (§8, `services/identityResolver.ts`) adds matric and
 * display-name tiers. They are deliberately NOT implemented here: matric is
 * self-asserted (user.setMatric upserts whatever the logged-in user types), so a
 * matric-resolved grant is claimable by anyone who types that matric, and
 * `User.displayName` is nullable and non-unique. Both need the ambiguity
 * buckets and the confirmation UI that doc 03 owns. Until then this resolver
 * returns UNRESOLVED for them, which is a refusal, not a silent guess.
 */
function resolveIdentifier(
  raw: string,
): { userID: string; via: "email" | "nusnet" } | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes("@")) {
    const id = canonicalUserID(s);
    return id ? { userID: id, via: "email" } : null;
  }
  const upper = s.toUpperCase();
  return isEFormatUserID(upper) ? { userID: upper, via: "nusnet" } : null;
}

/* ========================================================================== */
/* SECTION B — audit, the escalation guards, and the write chokepoint         */
/* ========================================================================== */

export type AuditEntry = {
  actorUserID: string;
  actorRoles?: string[];
  targetUserID?: string;
  targetFacilityID?: number;
  targetCcaID?: number;
  action: string;
  rolesBefore?: string[];
  rolesAfter?: string[];
  reason?: string;
  ok?: boolean;
  denyReason?: string;
  batchId?: string;
};

/**
 * Audit writer.
 *
 * CRITICAL (I-15): takes a PrismaClient, NEVER a transaction client. A denial
 * audit written inside the transaction it is denying is rolled back by the
 * throw, leaving no trace of exactly the event that most needs one — which
 * defeats abuse detection on the surface most likely to be probed. Every guard
 * below audits on `db`, outside any tx.
 *
 * An audit failure never rolls back an authorization decision, but a failure on
 * a DENIED row is the highest-signal security event this system produces, so it
 * is logged structurally rather than swallowed.
 */
export async function writeAudit(
  db: PrismaClient,
  e: AuditEntry,
): Promise<void> {
  try {
    await db.roleAuditLog.create({
      data: {
        actorUserID: e.actorUserID,
        actorRoles: e.actorRoles ?? [],
        targetUserID: e.targetUserID ?? null,
        targetFacilityID: e.targetFacilityID ?? null,
        targetCcaID: e.targetCcaID ?? null,
        action: e.action,
        rolesBefore: e.rolesBefore ?? [],
        rolesAfter: e.rolesAfter ?? [],
        reason: e.reason ?? null,
        ok: e.ok ?? true,
        denyReason: e.denyReason ?? null,
        batchId: e.batchId ?? null,
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "audit_write_failed",
        action: e.action,
        ok: e.ok ?? true,
        actorUserID: e.actorUserID,
        targetUserID: e.targetUserID,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Thrown by the guards when `dryRun` is set, so a preview can report the same
 * denial reason the real call would produce WITHOUT writing an audit row
 * (I-15's inverse case: a 500-row preview must not emit 500 denial rows for a
 * hypothetical). Caught by previewBulkImport; never escapes to a client.
 */
export class DryRunDenied extends Error {
  constructor(public readonly denyReason: string) {
    super(denyReason);
    this.name = "DryRunDenied";
  }
}

const forbid = (msg: string): never => {
  throw new TRPCError({ code: "FORBIDDEN", message: msg });
};

/**
 * THE privilege-escalation firewall. Computes the resulting role set for a
 * `set`-style request and validates it, or throws and audits the denial.
 *
 *  G1 CALLER      caller must hold admin or jcrc. Also enforced by the
 *                 procedure middleware — belt and braces, because this function
 *                 is the thing every future surface will call.
 *  G2 VOCABULARY  every requested role must be a known GRANTABLE role. Zod
 *                 rejects most of these first; this survives a router that
 *                 forgets. `resident` fails G2 by design (I-8e).
 *  G3 TARGET      a non-admin may not touch ANY role of a user who holds admin.
 *                 Without this a jcrc calls set(admin_user, ["cca_head"]) —
 *                 every role in the PAYLOAD is inside jcrc's world, so an
 *                 additions-only check passes, and the sole admin is stripped.
 *                 This is escalation-by-demotion and it is the single most
 *                 important line in this file.
 *  G4 DELTA       BOTH added and removed must be permitted. Checking only
 *                 additions is the same hole as G3 from another angle: a
 *                 set-payload that merely OMITS a role is a revocation.
 *  G5 REVOKE      revoking from ANOTHER user uses the narrower
 *                 REVOCABLE_FROM_OTHERS_BY map. Self-revocation (stepping down)
 *                 of a non-admin role is always allowed. Under D-3 a jcrc who
 *                 steps down can be restored only by an ADMIN.
 *  G6 SELF-GRANT  a non-admin may not grant themselves a role they lack.
 *                 Scoped to non-admins deliberately: an admin already outranks
 *                 every role, and blocking them would leave the bootstrap admin
 *                 unable to give themselves jcrc with no in-app path to fix it.
 *  G7 KEY         the target must be an E-format userID (I-1). Without this the
 *                 dashboard writes rows keyed on an A-format matric that no
 *                 session ever matches: the grant appears to succeed and does
 *                 nothing.
 *
 * It re-reads BOTH actor and target roles from the database rather than
 * trusting the session (I-5); this also closes the TOCTOU where the actor is
 * demoted mid-request.
 *
 * The LAST-ADMIN guard is NOT here: it must be transactional, and lives in
 * applyRoleChange.
 */
export async function assertCanMutateRoles(opts: {
  db: PrismaClient;
  actorUserID: string;
  targetUserID: string;
  requestedRoles: string[];
  /** Preview only: evaluate the guards identically, but do not audit. */
  dryRun?: boolean;
}): Promise<{
  actorRoles: string[];
  before: GrantableRole[];
  after: GrantableRole[];
  /** The authorised delta. applyRoleChange asserts on THESE. */
  added: GrantableRole[];
  removed: GrantableRole[];
}> {
  const { db, actorUserID, targetUserID, requestedRoles, dryRun } = opts;

  const [actorAll, targetAll] = await Promise.all([
    getUserRoles(db, actorUserID),
    getUserRoles(db, targetUserID),
  ]);

  // Restrict both sides to GRANTABLE roles. Under the STORED baseline this is
  // no longer tidiness — IT IS THE STICKY MECHANISM (I-8c). `removed` below is
  // `before.filter(...)`, so confining `before` to GRANTABLE_ROLES (which
  // excludes `resident`) means the baseline is not filtered out of the removal
  // set: it is INCAPABLE OF ENTERING IT. Widen this line and every role edit
  // silently strips every touched user's ability to book.
  const actorRoles = actorAll.filter(isGrantableRole);
  const before = targetAll.filter(isGrantableRole);

  const actorIsAdmin = actorRoles.includes(ADMIN_ROLE);
  const isSelf = actorUserID === targetUserID;

  const deny = async (reason: string): Promise<never> => {
    if (dryRun) throw new DryRunDenied(reason);
    // Audited BEFORE throwing, on `db` and outside any transaction (I-15):
    // there is no state change to lose, and a probing attempt is exactly what
    // must leave a trail.
    await writeAudit(db, {
      actorUserID,
      actorRoles,
      targetUserID,
      action: "denied",
      rolesBefore: before,
      rolesAfter: requestedRoles,
      ok: false,
      denyReason: reason,
    });
    return forbid(reason);
  };

  if (!isEFormatUserID(targetUserID)) await deny("NOT_A_CANONICAL_USERID"); // G7
  if (!actorIsAdmin && !actorRoles.includes(JCRC_ROLE)) {
    await deny("NOT_A_ROLE_MANAGER"); // G1
  }
  for (const r of requestedRoles) {
    if (!isGrantableRole(r)) await deny("UNKNOWN_ROLE"); // G2
  }
  if (!actorIsAdmin && before.includes(ADMIN_ROLE)) {
    await deny("CANNOT_MODIFY_AN_ADMIN"); // G3
  }

  const requested = [...new Set(requestedRoles)] as GrantableRole[];
  const added = requested.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !requested.includes(r));

  const canAssign = assignableBy(actorRoles);
  const canRevokeOthers = revocableFromOthersBy(actorRoles);

  for (const r of added) {
    // G4 (additions). cca_head fails here for EVERYONE, admin included: it is
    // in no ASSIGNABLE_BY entry (I-14), so the generic path cannot write it and
    // UserRole/CcaHead cannot drift.
    if (!canAssign.has(r)) {
      await deny(
        r === CCA_HEAD_ROLE
          ? "USE_CCA_HEAD_ENDPOINT"
          : `CANNOT_GRANT_${r.toUpperCase()}`,
      );
    }
    // G6
    if (isSelf && !actorIsAdmin && !actorRoles.includes(r)) {
      await deny("CANNOT_SELF_ASSIGN");
    }
  }
  for (const r of removed) {
    // G4 (removals) + G5
    if (isSelf) {
      if (r === ADMIN_ROLE && !actorIsAdmin) await deny("CANNOT_REVOKE_ADMIN");
      continue;
    }
    if (!canRevokeOthers.has(r)) {
      await deny(
        r === CCA_HEAD_ROLE
          ? "USE_CCA_HEAD_ENDPOINT"
          : `CANNOT_REVOKE_${r.toUpperCase()}_FROM_OTHERS`,
      );
    }
  }

  return { actorRoles, before, after: requested, added, removed };
}

/**
 * The legacy `role` mirror, with the I-9 sentinel applied.
 *
 * `legacyMirror` in roles.ts returns `string | null`, but 02-backend-authz.md §6
 * requires the INSERT branch to write `""` and not null: the still-deployed
 * pre-v2 client declares `UserRole.role` required and throws on absence AND on
 * null, whereas `""` is defined for it and is falsy, so the old
 * `row?.role ?? DEFAULT_ROLE` read degrades safely. The coercion lives here
 * rather than in roles.ts because roles.ts is not this phase's file to edit;
 * flag it if the two are ever reconciled. Applied on BOTH branches so a revoke
 * clears a stale mirror instead of leaving a dropped role behind.
 */
const mirror = (roles: readonly string[]): string => legacyMirror(roles) ?? "";

/**
 * Applies a validated role change with the LAST-ADMIN guard held INSIDE a
 * transaction. Read-then-write outside a transaction is not enough: with two
 * admins, two concurrent self-revocations both observe count === 2, both pass,
 * and the system reaches zero admins — unrecoverable, because there is
 * deliberately no in-app path to mint the first admin.
 *
 * THE STICKY CHOKEPOINT (I-8c). This is the ONE write on the generic
 * role-mutation path. setUserRoles, every bulk-import row (add AND set mode)
 * and every bulk-undo row route through it, which is why "bulk is sticky" needs
 * no separate mechanism. The fourth role-write surface, deferred-grant
 * redemption, does not come through here and is additive-only by construction
 * (it $addToSets and never removes).
 */
export async function applyRoleChange(opts: {
  db: PrismaClient;
  actorUserID: string;
  actorRoles: string[];
  targetUserID: string;
  before: GrantableRole[];
  after: GrantableRole[];
  added: GrantableRole[];
  removed: GrantableRole[];
  reason?: string;
  batchId?: string;
}): Promise<GrantableRole[]> {
  const {
    db,
    actorUserID,
    actorRoles,
    targetUserID,
    before,
    after,
    removed,
    reason,
    batchId,
  } = opts;
  const losingAdmin = before.includes(ADMIN_ROLE) && !after.includes(ADMIN_ROLE);

  // I-8c, ASSERTED rather than assumed. `removed` comes from
  // assertCanMutateRoles, where it is `before.filter(...)` over a
  // grantable-only `before` — so this can only fire if someone widens that
  // line or calls this function by hand. Cheap, and it fails loudly instead of
  // stripping 515 baselines.
  if (removed.some((r) => !isGrantableRole(r))) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "NON_GRANTABLE_IN_REMOVAL",
    });
  }

  if (losingAdmin && actorUserID === targetUserID) {
    await writeAudit(db, {
      actorUserID,
      actorRoles,
      targetUserID,
      action: "denied",
      rolesBefore: before,
      rolesAfter: after,
      ok: false,
      denyReason: "CANNOT_SELF_REVOKE_ADMIN",
    });
    forbid("CANNOT_SELF_REVOKE_ADMIN");
  }

  try {
    await db.$transaction(async (tx) => {
      if (losingAdmin) {
        const remaining = await tx.userRole.count({
          where: {
            userID: { not: targetUserID },
            // Legacy-tolerant so an admin still on the singular shape is not
            // invisible to the count. Narrowing this to roles-only before doc
            // 06's gate proves no legacy-only row remains would permit removing
            // the real last admin.
            OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }],
          },
        });
        if (remaining < 1) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "CANNOT_REMOVE_LAST_ADMIN",
          });
        }
      }

      // Read the CURRENT full stored set INSIDE the transaction, so the write
      // below is a compare-and-set against a pre-image observed under the same
      // session as the last-admin count.
      const row = await tx.userRole.findUnique({
        where: { userID: targetUserID },
      });
      const current = row?.roles?.length
        ? row.roles
        : row?.role
          ? [row.role]
          : [];

      // OPTIMISTIC CONCURRENCY. `added`/`removed` were computed from a `before`
      // read in assertCanMutateRoles, in an EARLIER statement. With two
      // concurrent edits and no check, actor A setting [admin] and actor B
      // setting [jcrc] interleave to a state neither requested — and worse, a
      // REVOKE can be silently undone by a concurrent grant, i.e. privilege
      // retention after an apparently successful revocation, with an audit row
      // asserting a rolesAfter that never existed. So: if the target's
      // grantable set has moved since the guards read it, refuse.
      const currentGrantable = current.filter(isGrantableRole);
      const moved =
        currentGrantable.length !== before.length ||
        currentGrantable.some((r) => !before.includes(r));
      if (moved) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "CONFLICT_ROLES_CHANGED",
        });
      }

      // STICKY BY CONSTRUCTION. The written set is
      //   (everything stored that is NOT grantable) ∪ (the authorised final set)
      // `resident` is not grantable, so it lands in the first term and is
      // PRESERVED. It is not filtered out of a removal payload; it is incapable
      // of entering one.
      //
      // Note what this deliberately does NOT do: it does not ADD `resident` to
      // a target that lacks it. `targetUserID` is admin/jcrc-supplied input
      // whose NUS provenance was never established (G7 checks E-format SHAPE,
      // not provenance). Minting a baseline here would grant it to principals
      // that may not exist and were never email-verified. Granting is
      // ensureBaseline's job and only ensureBaseline's job (I-8a/I-8d).
      const keptNonGrantable = current.filter((r) => !isGrantableRole(r));
      const written = [...new Set([...keptNonGrantable, ...after])];

      await tx.userRole.upsert({
        where: { userID: targetUserID },
        create: {
          userID: targetUserID,
          roles: written,
          role: mirror(after),
          updatedAt: new Date(),
          updatedBy: actorUserID,
        },
        update: {
          roles: written,
          role: mirror(after),
          updatedAt: new Date(),
          updatedBy: actorUserID,
        },
      });
      // WHY A TYPED upsert AND NOT $runCommandRaw($pull/$addToSet):
      //  1. Prisma's MongoDB connector does NOT run raw commands inside the
      //     interactive transaction's session — a raw write executes OUTSIDE
      //     the transaction and commits independently of rollback. That would
      //     silently un-atomicise the last-admin guard above and re-open
      //     exactly the zero-admins race this transaction exists to prevent.
      //  2. A raw `updates: [$pull, $addToSet]` array is TWO document writes,
      //     not one: entry 1 succeeding and entry 2 failing leaves the target
      //     stripped of the revoked roles with none of the additions applied.
      //  3. $set and $setOnInsert may never name the same path — MongoDB
      //     rejects that with ConflictingUpdateOperators at parse time (I-9).
      //     No $setOnInsert appears here: `mirror()` already writes `role` on
      //     BOTH branches, and returns "" (never null) so the I-9 sentinel
      //     holds on insert.
      // This IS a set-payload, which I-13 forbids in its BLIND form — the
      // compare-and-set above is what makes it legal, and it is strictly
      // stronger than an unguarded delta. Do not remove the pre-image check
      // "for speed".
    });
  } catch (err) {
    // I-15 again, from the transactional side: a denial raised INSIDE the
    // transaction rolls its own audit row back, so the two guards that can only
    // be evaluated in there are audited HERE, after the rollback, on `db`.
    if (
      err instanceof TRPCError &&
      (err.message === "CANNOT_REMOVE_LAST_ADMIN" ||
        err.message === "CONFLICT_ROLES_CHANGED")
    ) {
      await writeAudit(db, {
        actorUserID,
        actorRoles,
        targetUserID,
        action: "denied",
        rolesBefore: before,
        rolesAfter: after,
        ok: false,
        denyReason: err.message,
        reason,
        batchId,
      });
    }
    throw err;
  }

  await writeAudit(db, {
    actorUserID,
    actorRoles,
    targetUserID,
    action: "set",
    rolesBefore: before,
    rolesAfter: after,
    reason,
    batchId,
    ok: true,
  });
  return after;
}

/**
 * The CCA-path role-string write (I-14). Separate from applyRoleChange because
 * `cca_head` is in no ASSIGNABLE_BY entry, so the generic guards reject it by
 * design — this is the only way it can be written, and it maintains the
 * `CcaHead` row in the SAME transaction so CH-1 (`holds the string` iff `has
 * >=1 CcaHead row`) cannot drift.
 *
 * Same sticky construction as the chokepoint: every stored role other than
 * `cca_head` is carried through verbatim, so `resident`, `jcrc` and `admin` are
 * untouched by a CCA edit.
 */
async function writeCcaHeadString(
  tx: Omit<PrismaClient, `$${string}`>,
  targetUserID: string,
  present: boolean,
  actorUserID: string,
): Promise<string[]> {
  const row = await tx.userRole.findUnique({ where: { userID: targetUserID } });
  const current = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];
  const kept = current.filter((r) => r !== CCA_HEAD_ROLE);
  const written = present ? [...kept, CCA_HEAD_ROLE] : kept;
  await tx.userRole.upsert({
    where: { userID: targetUserID },
    create: {
      userID: targetUserID,
      roles: written,
      role: mirror(written.filter(isGrantableRole)),
      updatedAt: new Date(),
      updatedBy: actorUserID,
    },
    update: {
      roles: written,
      role: mirror(written.filter(isGrantableRole)),
      updatedAt: new Date(),
      updatedBy: actorUserID,
    },
  });
  return written;
}

/**
 * G3 for the CCA path. The generic guards are not reachable from here, so the
 * target guard is re-stated: a jcrc must not be able to reach an admin's role
 * document through the CCA endpoints either.
 */
async function assertMayManageCcaHeadOf(
  db: PrismaClient,
  actorUserID: string,
  actorRoles: readonly string[],
  targetUserID: string,
): Promise<void> {
  const deny = async (reason: string): Promise<never> => {
    await writeAudit(db, {
      actorUserID,
      actorRoles: [...actorRoles],
      targetUserID,
      action: "denied",
      ok: false,
      denyReason: reason,
    });
    return forbid(reason);
  };
  if (!isEFormatUserID(targetUserID)) await deny("NOT_A_CANONICAL_USERID"); // G7
  if (!actorRoles.includes(ADMIN_ROLE)) {
    const targetRoles = await getUserRoles(db, targetUserID);
    if (targetRoles.includes(ADMIN_ROLE)) await deny("CANNOT_MODIFY_AN_ADMIN");
  }
}

/* ========================================================================== */
/* SECTION C — the router                                                     */
/* ========================================================================== */

export const adminRouter = createTRPCRouter({
  /**
   * D-2's single source of client-side truth. NOT roleManagerProcedure: the
   * header calls this for every signed-in user, and a FORBIDDEN on every page
   * load is not acceptable. A non-manager simply receives an all-false
   * capability set.
   */
  whoAmI: protectedProcedure.query(({ ctx }) => {
    const roles = ctx.session.user.roles ?? [];
    return {
      userID: ctx.session.user.userID,
      roles, // includes the stored "resident"
      capabilities: caps(roles),
    };
  }),

  listUsers: roleManagerProcedure
    .input(listInput)
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      const { search, role, limit, cursor } = input;

      /** D-2: a jcrc must not be handed an enumeration of who holds admin. */
      const redact = (roles: string[]) =>
        c.seeAdminIdentities ? roles : roles.filter((r) => r !== ADMIN_ROLE);

      // ---- role-filtered branch: page the SMALL collection first ----------
      if (role) {
        if (role === ADMIN_ROLE) requireCapability(c, "seeAdminIdentities");
        const roleRows = await ctx.db.userRole.findMany({
          where: { OR: [{ roles: { has: role } }, { role }] }, // legacy-tolerant
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: "asc" },
        });
        const page = roleRows.slice(0, limit);
        const nextCursor =
          roleRows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

        // Hydrate. There is no reverse E-format -> email Mongo query, so probe
        // the conventional address and left-join in memory. A role may
        // legitimately exist for a user with no User row (a claimed pending
        // grant, a hand-seeded admin), so a miss renders as a bare id — never
        // as an omission, which would hide a live grant from the audit surface.
        const emails = page.map((r) => `${r.userID.toLowerCase()}@u.nus.edu`);
        const users = await ctx.db.user.findMany({
          where: { email: { in: emails, mode: "insensitive" } },
          // NEVER a bare findMany: passwordHash must not reach the client, and
          // passwordHash-less Google-adapter rows would throw on a full read
          // (I-2).
          select: { id: true, email: true, displayName: true, userID: true },
        });
        // C9: keys that canonicalize to ABSENT are dropped rather than stored
        // under a sentinel key. Before C9 a non-NUS row entered this map at key
        // "" — and `byCanonical.get(r.userID)` below would then MATCH it for a
        // ""-keyed UserRole row (the I-8d red line), attributing a stranger's
        // email and displayName to that grant on the admin surface. That is
        // 09's S5 exactly, and it is a lookup indistinguishable from success.
        // Unreachable while no ""-keyed row exists; the compiler found it anyway.
        const byCanonical = new Map<string, (typeof users)[number]>(
          users.flatMap((u) => {
            const cid = canonicalUserID(u.email);
            return cid === null ? [] : [[cid, u] as const];
          }),
        );

        return {
          items: page.map((r) => {
            const u = byCanonical.get(r.userID);
            return {
              id: u?.id ?? r.id,
              // C9: `UserRole.userID` IS the canonical role key by I-8d, but
              // Prisma types it `string` and a ""-keyed row is exactly the red
              // line I-8d names. Mint it through the checked entry point, so
              // such a row arrives at the client as ABSENT — rendered as "—"
              // with Manage disabled, identical to how the listUsers arm has
              // always rendered a non-NUS account — instead of as a usable
              // grant target. Not reachable today; no ""-keyed row exists.
              canonicalUserID: asStoredCanonicalUserID(r.userID),
              legacyUserID: u?.userID ?? null,
              email: u?.email ?? null,
              displayName: u?.displayName ?? null,
              block: null as string | null,
              hasAccount: Boolean(u),
              eligible: true,
              keyMismatch: false,
              roles: redact(r.roles?.length ? r.roles : r.role ? [r.role] : []),
            };
          }),
          nextCursor,
        };
      }

      // ---- default branch: page User, batch the role lookup ---------------
      const esc = search ? escapeRegex(search) : undefined;
      const users = await ctx.db.user.findMany({
        where: esc
          ? {
              OR: [
                { email: { contains: esc, mode: "insensitive" } },
                { displayName: { contains: esc, mode: "insensitive" } },
              ],
            }
          : {},
        select: {
          id: true,
          email: true,
          displayName: true,
          userID: true,
          block: true,
        },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
      });

      const page = users.slice(0, limit);
      const nextCursor =
        users.length > limit ? (page[page.length - 1]?.id ?? null) : null;

      // C9: `.filter(Boolean)` removed the absent ids at RUNTIME but not in the
      // type, so the `in:` filter below was typed as if it could carry one. A
      // type predicate makes the existing runtime behaviour checkable. No
      // runtime change: null was already dropped, exactly as "" was.
      const canonicalIDs = page
        .map((u) => canonicalUserID(u.email))
        .filter((id): id is CanonicalUserID => id !== null);
      const roleRows = await ctx.db.userRole.findMany({
        where: { userID: { in: canonicalIDs } },
      });
      const byID = new Map(
        roleRows.map((r) => [
          r.userID,
          r.roles?.length ? r.roles : r.role ? [r.role] : [],
        ]),
      );

      return {
        items: page.map((u) => {
          const cid = canonicalUserID(u.email);
          return {
            id: u.id,
            canonicalUserID: cid, // the key ALL mutations must submit; null => none
            legacyUserID: u.userID, // DISPLAY ONLY — may be an A-format matric
            email: u.email,
            displayName: u.displayName,
            block: u.block,
            hasAccount: true,
            eligible: cid !== null, // false => cannot sign in under D-7
            keyMismatch: Boolean(u.userID && u.userID !== cid),
            // C9: `byID.get(cid)` with an absent cid was the same S5 lookup as
            // the pending-grants map above — `byID.get("")` would have rendered
            // a ""-keyed UserRole row's roles (potentially `admin`) as THIS
            // non-NUS user's roles in the admin table. An account with no
            // canonical id holds no stored roles, by construction, so [] is
            // both the safe answer and the true one.
            roles: redact(cid === null ? [] : (byID.get(cid) ?? [])),
          };
        }),
        nextCursor,
      };
    }),

  getStats: roleManagerProcedure.query(async ({ ctx }) => {
    const c = caps(ctx.session.user.roles);
    const [totalUsers, jcrc, ccaHead, admins] = await Promise.all([
      ctx.db.user.count(),
      ctx.db.userRole.count({
        where: { OR: [{ roles: { has: JCRC_ROLE } }, { role: JCRC_ROLE }] },
      }),
      ctx.db.userRole.count({
        where: {
          OR: [{ roles: { has: CCA_HEAD_ROLE } }, { role: CCA_HEAD_ROLE }],
        },
      }),
      ctx.db.userRole.count({
        where: { OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }] },
      }),
    ]);
    return {
      totalUsers,
      jcrc,
      ccaHead,
      admins: c.seeAdminIdentities ? admins : null,
    };
  }),

  /** The one single-user role mutation. Takes the DESIRED FINAL grantable set. */
  setUserRoles: roleManagerProcedure
    .input(
      z.object({
        userID: userIDSchema,
        roles: roleSchema.array().max(8),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const { actorRoles, before, after, added, removed } =
        await assertCanMutateRoles({
          db: ctx.db,
          actorUserID,
          targetUserID: input.userID,
          requestedRoles: input.roles,
        });
      // `added`/`removed` are the authorised DELTA and must be threaded
      // through: applyRoleChange asserts on `removed` (I-8c) and a caller must
      // not be able to skip that by passing only `after`.
      const result = await applyRoleChange({
        db: ctx.db,
        actorUserID,
        actorRoles,
        targetUserID: input.userID,
        before,
        after,
        added,
        removed,
        reason: input.reason,
      });
      return { userID: input.userID, roles: result };
    }),

  /* ---- CCA head endpoints (I-14) ------------------------------------- */

  /**
   * The ONLY writer of the `cca_head` string. Writes the UserRole string and
   * the scoped CcaHead row in ONE transaction, so CH-1 cannot drift. Available
   * to admin AND jcrc via the `manageCcaHeads` capability — note that jcrc's
   * assignableRoles is [] under D-3, so this power is deliberately NOT readable
   * off the assignable set.
   */
  grantCcaHead: roleManagerProcedure
    .input(
      z.object({
        userID: userIDSchema,
        ccaID: z.number().int(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID); // I-5 re-read
      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        input.userID,
      );

      const before = await getUserRoles(ctx.db, input.userID);
      const after = await ctx.db.$transaction(async (tx) => {
        await tx.ccaHead.upsert({
          where: {
            userID_ccaID: { userID: input.userID, ccaID: input.ccaID },
          },
          create: {
            userID: input.userID,
            ccaID: input.ccaID,
            grantedBy: actorUserID,
          },
          update: { grantedBy: actorUserID },
        });
        return writeCcaHeadString(tx, input.userID, true, actorUserID);
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.userID,
        targetCcaID: input.ccaID,
        action: "ccaHead.grant",
        rolesBefore: before,
        rolesAfter: after,
        reason: input.reason,
      });
      return { userID: input.userID, ccaID: input.ccaID, roles: after };
    }),

  revokeCcaHead: roleManagerProcedure
    .input(
      z.object({
        userID: userIDSchema,
        ccaID: z.number().int(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID);
      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        input.userID,
      );

      const before = await getUserRoles(ctx.db, input.userID);
      const after = await ctx.db.$transaction(async (tx) => {
        await tx.ccaHead.deleteMany({
          where: { userID: input.userID, ccaID: input.ccaID },
        });
        // CH-1: the string goes only when the LAST scope goes. A head of two
        // CCAs who is removed from one keeps the role.
        const remaining = await tx.ccaHead.count({
          where: { userID: input.userID },
        });
        return writeCcaHeadString(
          tx,
          input.userID,
          remaining > 0,
          actorUserID,
        );
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.userID,
        targetCcaID: input.ccaID,
        action: "ccaHead.revoke",
        rolesBefore: before,
        rolesAfter: after,
        reason: input.reason,
      });
      return { userID: input.userID, ccaID: input.ccaID, roles: after };
    }),

  /**
   * Succession. Both halves in ONE transaction — a transfer that grants without
   * revoking leaves two heads, and one that revokes without granting leaves a
   * CCA headless. Both audit rows carry the same batchId so the handover reads
   * as one event.
   */
  transferCcaHead: roleManagerProcedure
    .input(
      z.object({
        fromUserID: userIDSchema,
        toUserID: userIDSchema,
        ccaID: z.number().int(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      if (input.fromUserID === input.toUserID) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "SAME_USER" });
      }
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID);
      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        input.fromUserID,
      );
      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        input.toUserID,
      );

      const [beforeFrom, beforeTo] = await Promise.all([
        getUserRoles(ctx.db, input.fromUserID),
        getUserRoles(ctx.db, input.toUserID),
      ]);
      const batchId = randomUUID();

      const { afterFrom, afterTo } = await ctx.db.$transaction(async (tx) => {
        await tx.ccaHead.deleteMany({
          where: { userID: input.fromUserID, ccaID: input.ccaID },
        });
        await tx.ccaHead.upsert({
          where: {
            userID_ccaID: { userID: input.toUserID, ccaID: input.ccaID },
          },
          create: {
            userID: input.toUserID,
            ccaID: input.ccaID,
            grantedBy: actorUserID,
          },
          update: { grantedBy: actorUserID },
        });
        const remainingFrom = await tx.ccaHead.count({
          where: { userID: input.fromUserID },
        });
        return {
          afterFrom: await writeCcaHeadString(
            tx,
            input.fromUserID,
            remainingFrom > 0,
            actorUserID,
          ),
          afterTo: await writeCcaHeadString(
            tx,
            input.toUserID,
            true,
            actorUserID,
          ),
        };
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.fromUserID,
        targetCcaID: input.ccaID,
        action: "ccaHead.transfer",
        rolesBefore: beforeFrom,
        rolesAfter: afterFrom,
        reason: input.reason,
        batchId,
      });
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.toUserID,
        targetCcaID: input.ccaID,
        action: "ccaHead.transfer",
        rolesBefore: beforeTo,
        rolesAfter: afterTo,
        reason: input.reason,
        batchId,
      });
      return { ccaID: input.ccaID, batchId };
    }),

  listCcaHeads: roleManagerProcedure
    .input(z.object({ ccaID: z.number().int().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      return ctx.db.ccaHead.findMany({
        where: input.ccaID === undefined ? {} : { ccaID: input.ccaID },
        orderBy: [{ ccaID: "asc" }, { userID: "asc" }],
      });
    }),

  /* ---- triage, health, flags ----------------------------------------- */

  /**
   * Closes the "admin bypass masks everything" testing hole: canBookWithRoles
   * returns true for admin BEFORE consulting requirements, so the person
   * running the rollout cannot reproduce any resident-side failure from their
   * own session. Audited because it is an enumeration primitive over the whole
   * user base.
   */
  explainAccess: roleManagerProcedure
    .input(z.object({ userID: userIDSchema, facilityID: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const [decision, requiredRoles, roles] = await Promise.all([
        // No email argument, deliberately: this evaluates AS the target, and
        // inspecting a user must not mint them a baseline as a side effect of
        // being inspected. It therefore shows the target's REAL stored state,
        // which is exactly what makes it useful for triaging a NOT_RESIDENT
        // report.
        evaluateBooking(ctx.db, input.userID, input.facilityID),
        getFacilityRequiredRoles(ctx.db, input.facilityID),
        getUserRoles(ctx.db, input.userID),
      ]);
      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        targetUserID: input.userID,
        targetFacilityID: input.facilityID,
        action: "explainAccess",
      });
      return { decision, requiredRoles, roles };
    }),

  /**
   * The detection surface. Aggregate counts for managers; per-user identifier
   * lists are account-integrity data and are admin-only.
   */
  systemHealth: roleManagerProcedure.query(async ({ ctx }) => {
    const c = caps(ctx.session.user.roles);
    const [facilities, access, mode, shadow24h, baselineMissing] =
      await Promise.all([
        ctx.db.facilities.findMany({
          select: { facilityID: true, facilityName: true },
        }),
        ctx.db.facilityAccess.findMany({
          select: { facilityID: true, requiredRoles: true },
        }),
        getEnforcementMode(ctx.db),
        ctx.db.roleAuditLog.count({
          where: {
            action: "booking.denied.shadow",
            at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
          },
        }),
        // RED LINE, not a materialization gap. Scoped to NUS-emailed User rows
        // ONLY: counting ineligible accounts (test@, aaaaaa@) makes a number
        // that can never reach zero, and per I-16's corollary a gate that
        // cannot reach zero gets muted — which deletes the detector.
        //
        // A TRUE SET DIFFERENCE OVER THE CANONICAL KEY, never a subtraction of
        // two counts. `eligible - held` was wrong twice over and the two errors
        // CANCEL, which is the dangerous part:
        //   - `held` counted every UserRole row bearing `resident`, INCLUDING
        //     rows orphaned by merge-accounts.mjs (the losing User row is
        //     deleted, its UserRole row survives). Each orphan hides one real
        //     victim.
        //   - `contains: "@u.nus.edu"` is unanchored, so it also matches
        //     bob@u.nus.edu.evil.com — disagreeing with the anchored predicate
        //     that actually decides who receives a baseline.
        // Two disjoint populations of equal size read as 0, the operator sees a
        // green red-line, flips to `enforce`, and a genuinely eligible user
        // whose baseline write failed (L-6) is denied on every normal room with
        // no signal naming them. I-16: every gate NAMES the offenders, so this
        // returns the ids too, not just a count.
        (async () => {
          const [users, roleRows] = await Promise.all([
            ctx.db.user.findMany({ select: { email: true } }),
            ctx.db.userRole.findMany({
              // Legacy-tolerant, matching getUserRoles: a row still carrying
              // only the singular `role` holds the baseline just as truly.
              where: {
                OR: [
                  { roles: { has: BASELINE_ROLE } },
                  { role: BASELINE_ROLE },
                ],
              },
              select: { userID: true },
            }),
          ]);
          // Same predicate + same canonicalisation the grant path uses, so the
          // two sides are scoped to one population and the gate can reach zero.
          const eligible = new Set(
            users
              .filter((u) => isNusStudentEmail(u.email))
              .map((u) => canonicalUserID(u.email))
              // C9: type-only. `.filter(Boolean)` already dropped absent ids at
              // runtime; the predicate lets the compiler see it. Note the
              // `isNusStudentEmail` filter above already makes this total.
              .filter((id): id is CanonicalUserID => id !== null),
          );
          const held = new Set(roleRows.map((r) => r.userID));
          const missing = [...eligible].filter((id) => !held.has(id)).sort();
          return missing;
        })(),
      ]);
    const configured = new Set(access.map((a) => a.facilityID));
    const unconfigured = facilities.filter(
      (f) => f.facilityID !== -1 && !configured.has(f.facilityID),
    );
    return {
      enforcementMode: mode,
      shadowDenials24h: shadow24h,
      facilities: facilities.length,
      unconfiguredFacilities: unconfigured.length,
      /**
       * RED LINE. Under the stored baseline a non-zero value is a LIVE LOCKOUT
       * of that many eligible users, not an advisory materialization gap. Do
       * not flip enforcement to `enforce` while it is non-zero.
       */
      residentBaselineMissing: baselineMissing.length,
      /**
       * L-6's only detector. `baseline_repair_failed` is a structured console
       * log today, so this stays null until those logs are shipped to a
       * queryable sink; until then, grep the platform logs for that `evt`.
       * Kept in the payload rather than omitted so the panel has a slot for it
       * and it cannot be quietly forgotten.
       */
      baselineRepairFailures24h: null as number | null,
      adminRolesStoredOnFacilities: access.filter((a) =>
        a.requiredRoles?.includes(ADMIN_ROLE),
      ).length,
      /**
       * I-16 — the gate NAMES the offenders. A bare count tells the operator
       * something is wrong but not who, so the only available response is to
       * wait and re-check. Admin-only, like `unconfigured`: this is a list of
       * per-user identifiers, i.e. account-integrity data.
       */
      detail: c.viewSystemHealthDetail
        ? { unconfigured, residentBaselineMissingIDs: baselineMissing }
        : null,
    };
  }),

  setEnforcementMode: adminProcedure
    .input(
      z.object({
        mode: z.enum(["off", "permissive", "enforce"]),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemFlag.upsert({
        where: { key: "rbac.booking.enforcement" },
        create: {
          key: "rbac.booking.enforcement",
          value: input.mode,
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
        update: {
          value: input.mode,
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
      });
      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        action: "enforcement.set",
        reason: input.reason,
        rolesAfter: [input.mode],
      });
      // Takes effect within the 15s per-lambda cache TTL. No redeploy.
      return { mode: input.mode };
    }),

  listAuditLog: adminProcedure
    .input(
      z.object({
        targetUserID: userIDSchema.optional(),
        actorUserID: userIDSchema.optional(),
        action: z.string().max(32).optional(),
        batchId: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.roleAuditLog.findMany({
        where: {
          ...(input.targetUserID ? { targetUserID: input.targetUserID } : {}),
          ...(input.actorUserID ? { actorUserID: input.actorUserID } : {}),
          ...(input.action ? { action: input.action } : {}),
          ...(input.batchId ? { batchId: input.batchId } : {}),
        },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { at: "desc" },
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page,
        nextCursor:
          rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    }),

  /* ---- facility access (admin only) ---------------------------------- */

  listFacilityAccess: adminProcedure.query(async ({ ctx }) => {
    const [facilities, access] = await Promise.all([
      ctx.db.facilities.findMany({ orderBy: { facilityID: "asc" } }),
      ctx.db.facilityAccess.findMany(),
    ]);
    const byID = new Map(access.map((a) => [a.facilityID, a]));
    return facilities.map((f) => {
      const a = byID.get(f.facilityID);
      const stored = a?.requiredRoles?.length
        ? a.requiredRoles
        : a?.requiredRole
          ? [a.requiredRole]
          : [];
      return {
        facilityID: f.facilityID,
        facilityName: f.facilityName,
        requiredRoles: stored.length ? stored : [BASELINE_ROLE],
        /**
         * True = never configured. Under D-1 it defaults to resident, so this
         * is a config gap to surface, not a lockout.
         */
        unconfigured: !a,
      };
    });
  }),

  /**
   * adminProcedure, NOT roleManagerProcedure: a jcrc must not be able to gate
   * every room behind `jcrc`, nor to open SCRC to everyone.
   */
  setFacilityAccess: adminProcedure
    .input(
      z.object({
        facilityID: z.number().int(),
        requiredRoles: facilityRoleSchema.array().min(1).max(8),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const facility = await ctx.db.facilities.findUnique({
        where: { facilityID: input.facilityID },
      });
      if (!facility) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Facility not found" });
      }

      const existing = await ctx.db.facilityAccess.findUnique({
        where: { facilityID: input.facilityID },
      });
      const before = existing?.requiredRoles?.length
        ? existing.requiredRoles
        : existing?.requiredRole
          ? [existing.requiredRole]
          : [];
      const roles = [...new Set(input.requiredRoles)];

      await ctx.db.facilityAccess.upsert({
        where: { facilityID: input.facilityID },
        // The legacy mirror is set to "" on INSERT and left UNTOUCHED on
        // UPDATE. Rationale: a newly created row must read as falsy to the
        // still-deployed pre-v2 access.ts (preserving today's open-by-default),
        // while an existing gated row (SCRC) keeps its real legacy value so a
        // revert does not silently un-gate it. The sentinel is "" and not null
        // because the old deployed client throws on absence and on null (I-9).
        create: {
          facilityID: input.facilityID,
          requiredRoles: roles,
          requiredRole: "",
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
        update: {
          requiredRoles: roles,
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
      });

      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        targetFacilityID: input.facilityID,
        action: "facilityAccess.set",
        rolesBefore: before,
        rolesAfter: roles,
      });
      return { facilityID: input.facilityID, requiredRoles: roles };
    }),

  /* ---- bulk operations (D-8) ----------------------------------------- */

  /**
   * A `.mutation()`, NOT a `.query()`, and this is not a style choice:
   * `src/trpc/react.tsx` uses unstable_httpBatchStreamLink with no
   * methodOverride, so queries are GET with the input serialized into the
   * querystring — 1000 CSV rows is ~1 MB of URL and 414s long before that. The
   * no-write property is preserved STRUCTURALLY instead: this body opens no
   * transaction and passes dryRun: true to every guard call, so not one audit
   * row is written for a 500-row preview containing 40 denials (I-15's inverse
   * case).
   */
  previewBulkImport: roleManagerProcedure
    .input(
      z.object({
        mode: z.enum(["add", "set"]),
        rows: z
          .array(
            z.object({
              lineNo: z.number().int().min(0),
              /**
               * A plain bounded string, NOT userIDSchema: zod validates the
               * whole input object, so one malformed identifier in a regex
               * field would 400 the entire 1000-row preview. Unresolvable rows
               * are reported per row instead.
               */
              identifier: z.string().trim().min(1).max(120),
              roles: roleSchema.array().max(8),
            }),
          )
          .min(1)
          .max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      const actorUserID = ctx.session.user.userID;

      // Preview is a DIRECTORY-DISCLOSURE surface: it accepts up to 1000
      // operator-supplied identifiers and returns each match's email, name and
      // role set. Rate-limited per actor per hour on the existing DB-backed
      // limiter.
      const { rateLimit } = await import("~/lib/rateLimit");
      const rl = await rateLimit(`bulkpreview:${actorUserID}`, 20, 3600_000);
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `RATE_LIMITED:${rl.retryAfter}`,
        });
      }

      const batchId = randomUUID();
      const expiresAt = Date.now() + PLAN_TTL_MS;

      const resolved = input.rows.map((r) => ({
        row: r,
        hit: resolveIdentifier(r.identifier),
      }));
      const ids = [
        ...new Set(resolved.map((r) => r.hit?.userID).filter(Boolean)),
      ] as string[];

      const [roleRows, users] = await Promise.all([
        ctx.db.userRole.findMany({ where: { userID: { in: ids } } }),
        ctx.db.user.findMany({
          where: {
            email: {
              in: ids.map((i) => `${i.toLowerCase()}@u.nus.edu`),
              mode: "insensitive",
            },
          },
          select: { id: true, email: true, displayName: true, block: true },
        }),
      ]);
      const rolesByID = new Map(
        roleRows.map((r) => [
          r.userID,
          (r.roles?.length ? r.roles : r.role ? [r.role] : []).filter(
            isGrantableRole,
          ),
        ]),
      );
      // C9: same S5 hazard as listPendingGrants' map — drop absent keys instead
      // of storing one under a sentinel. `hit.userID` (from resolveIdentifier)
      // is a real E-format id or a canonicalized one, never absent, so this
      // changes no reachable lookup today.
      const userByID = new Map<string, (typeof users)[number]>(
        users.flatMap((u) => {
          const cid = canonicalUserID(u.email);
          return cid === null ? [] : [[cid, u] as const];
        }),
      );

      const items = await Promise.all(
        resolved.map(async ({ row, hit }) => {
          const base = { lineNo: row.lineNo, identifier: row.identifier };
          if (!hit) {
            return {
              ...base,
              status: "denied" as const,
              denyReason: "UNRESOLVED_IDENTIFIER",
            };
          }
          const before = rolesByID.get(hit.userID) ?? [];
          const after =
            input.mode === "add"
              ? [...new Set([...before, ...row.roles])]
              : [...new Set(row.roles)];

          try {
            await assertCanMutateRoles({
              db: ctx.db,
              actorUserID,
              targetUserID: hit.userID,
              requestedRoles: after,
              dryRun: true, // <- the whole no-audit property
            });
          } catch (err) {
            if (err instanceof DryRunDenied) {
              return {
                ...base,
                status: "denied" as const,
                denyReason: err.denyReason,
                userID: hit.userID,
              };
            }
            throw err;
          }

          const u = userByID.get(hit.userID);
          const redact = (rs: string[]) =>
            c.seeAdminIdentities ? rs : rs.filter((r) => r !== ADMIN_ROLE);
          return {
            ...base,
            status: "ok" as const,
            userID: hit.userID,
            via: hit.via,
            confidence: "high" as const,
            // Mask the address on rows where the operator did not themselves
            // supply it — resolving an E-id must not become an email harvest.
            email: hit.via === "email" ? (u?.email ?? null) : null,
            displayName: u?.displayName ?? null,
            block: u?.block ?? null,
            hasAccount: Boolean(u),
            rolesBefore: redact(before),
            rolesAfter: redact(after),
            expectedBefore: before,
            rowToken: signRow({
              batchId,
              actorUserID,
              expiresAt,
              mode: input.mode,
              userID: hit.userID,
              roles: row.roles,
              expectedBefore: before,
              via: hit.via,
              confidence: "high",
            }),
          };
        }),
      );

      return { batchId, mode: input.mode, expiresAt, items };
    }),

  beginBulkImport: roleManagerProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        mode: z.enum(["add", "set"]),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      await ctx.db.bulkRoleImport.create({
        data: {
          batchId: input.batchId,
          actorUserID: ctx.session.user.userID,
          actorRoles: ctx.session.user.roles ?? [],
          mode: input.mode,
          note: input.note ?? null,
        },
      });
      return { batchId: input.batchId };
    }),

  /**
   * Capped at 25 rows: at ~5 Atlas round-trips per row (role reads, guard
   * reads, the transaction, the audit) at ~60ms, 25 rows is ~7.5s against a
   * Vercel ceiling of 10-15s. The client loops chunks under one batchId.
   *
   * GUARDS APPLY PER ROW, NEVER PER BATCH. A jcrc's import containing one admin
   * target returns CANNOT_MODIFY_AN_ADMIN for that row and succeeds on the
   * other 24 — partial failure is the expected outcome, not an error condition.
   * This is also what makes bulk sticky (I-8c): there is no second write path,
   * so replace-mode's safety comes from the chokepoint, not from any
   * client-side "compute the after set" helper.
   */
  commitBulkChunk: roleManagerProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        expiresAt: z.number().int(),
        rows: z
          .array(
            z.object({
              lineNo: z.number().int().min(0),
              userID: z.string().trim().max(120),
              roles: roleSchema.array().max(8),
              expectedBefore: roleSchema.array().max(8),
              via: z.string().max(16),
              confidence: z.string().max(16),
              rowToken: z.string().max(128),
            }),
          )
          .min(1)
          .max(25),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      const actorUserID = ctx.session.user.userID;

      // The batch must belong to THIS actor: a signed plan is a bearer
      // credential, and one manager must not be able to drive another's import.
      const header = await ctx.db.bulkRoleImport.findUnique({
        where: { batchId: input.batchId },
      });
      if (!header || header.actorUserID !== actorUserID) {
        throw new TRPCError({ code: "FORBIDDEN", message: "NOT_YOUR_BATCH" });
      }
      if (input.expiresAt < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "PLAN_EXPIRED" });
      }

      const results: {
        lineNo: number;
        userID: string;
        status: "ok" | "denied";
        roles?: string[];
        denyReason?: string;
      }[] = [];
      let lastLineNo = -1;

      for (const row of input.rows) {
        // Every row is re-verified against the signature the server itself
        // produced. `confirmed: true` from a client is not evidence, and
        // expectedBefore is not a secret — without this a caller posts straight
        // here and skips the preview's resolution rules entirely.
        const expectedToken = signRow({
          batchId: input.batchId,
          actorUserID,
          expiresAt: input.expiresAt,
          // The mode we are ABOUT TO APPLY, taken from the header — not from
          // the client and not from the row. If it differs from the mode the
          // plan was previewed under, the HMAC will not match and the row is
          // refused rather than applied under semantics nobody reviewed.
          mode: header.mode,
          userID: row.userID,
          roles: row.roles,
          expectedBefore: row.expectedBefore,
          via: row.via,
          confidence: row.confidence,
        });
        if (!tokenMatches(expectedToken, row.rowToken)) {
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "denied",
            denyReason: "PLAN_TOKEN_INVALID",
          });
          continue;
        }
        // Low-confidence resolutions (name matches) may only commit if the
        // confirmation was inside the SIGNED payload. The current resolver
        // never emits them; the check stands so adding the tier later cannot
        // silently open this door.
        if (row.confidence !== "high") {
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "denied",
            denyReason: "LOW_CONFIDENCE_NOT_CONFIRMED",
          });
          continue;
        }

        const requested =
          header.mode === "add"
            ? [...new Set([...row.expectedBefore, ...row.roles])]
            : [...new Set(row.roles)];

        try {
          const { actorRoles, before, after, added, removed } =
            await assertCanMutateRoles({
              db: ctx.db,
              actorUserID,
              targetUserID: row.userID,
              requestedRoles: requested,
            });

          // Optimistic concurrency against the PREVIEW, one layer above
          // applyRoleChange's own pre-image check: a row whose target changed
          // between preview and commit must not be silently skipped, or it
          // becomes indistinguishable from one that was never submitted.
          const drifted =
            before.length !== row.expectedBefore.length ||
            before.some((r) => !row.expectedBefore.includes(r));
          if (drifted) {
            await writeAudit(ctx.db, {
              actorUserID,
              actorRoles,
              targetUserID: row.userID,
              action: "denied",
              rolesBefore: before,
              rolesAfter: requested,
              ok: false,
              denyReason: "CONFLICT_ROLES_CHANGED",
              batchId: input.batchId,
            });
            results.push({
              lineNo: row.lineNo,
              userID: row.userID,
              status: "denied",
              denyReason: "CONFLICT_ROLES_CHANGED",
            });
            lastLineNo = row.lineNo;
            continue;
          }

          const roles = await applyRoleChange({
            db: ctx.db,
            actorUserID,
            actorRoles,
            targetUserID: row.userID,
            before,
            after,
            added,
            removed,
            batchId: input.batchId,
          });
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "ok",
            roles,
          });
        } catch (err) {
          // A per-row denial is data, not an exception: one bad row must not
          // abort the other 24. assertCanMutateRoles has ALREADY written the
          // audit row on ctx.db (I-15), so nothing is lost here.
          if (err instanceof TRPCError) {
            results.push({
              lineNo: row.lineNo,
              userID: row.userID,
              status: "denied",
              denyReason: err.message,
            });
          } else {
            throw err;
          }
        }
        lastLineNo = row.lineNo;
      }

      // Returned so a chunk killed by the platform timeout resumes from here
      // rather than retrying blind and double-applying.
      return { batchId: input.batchId, lastLineNo, results };
    }),

  /** Tallies are computed SERVER-side from the audit log, never accepted from the client. */
  finishBulkImport: roleManagerProcedure
    .input(z.object({ batchId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const header = await ctx.db.bulkRoleImport.findUnique({
        where: { batchId: input.batchId },
      });
      if (!header || header.actorUserID !== ctx.session.user.userID) {
        throw new TRPCError({ code: "FORBIDDEN", message: "NOT_YOUR_BATCH" });
      }
      const [applied, denied] = await Promise.all([
        ctx.db.roleAuditLog.count({
          where: { batchId: input.batchId, ok: true, action: "set" },
        }),
        ctx.db.roleAuditLog.count({
          where: { batchId: input.batchId, ok: false },
        }),
      ]);
      await ctx.db.bulkRoleImport.update({
        where: { batchId: input.batchId },
        data: { finishedAt: new Date() },
      });
      return { batchId: input.batchId, applied, denied };
    }),

  listBulkImports: roleManagerProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(100).default(25) })
        .default({ limit: 25 }),
    )
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      return ctx.db.bulkRoleImport.findMany({
        take: input.limit,
        orderBy: { startedAt: "desc" },
      });
    }),

  getBulkImport: roleManagerProcedure
    .input(z.object({ batchId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      const [header, rows] = await Promise.all([
        ctx.db.bulkRoleImport.findUnique({ where: { batchId: input.batchId } }),
        ctx.db.roleAuditLog.findMany({
          where: { batchId: input.batchId },
          orderBy: { at: "asc" },
          take: 1000,
        }),
      ]);
      if (!header) throw new TRPCError({ code: "NOT_FOUND" });
      return { header, rows };
    }),

  /**
   * Undo is a NORMAL guarded role change per row, not a privileged rollback —
   * so a jcrc cannot undo an admin-granting import, and no undo row can express
   * removing `resident`. It is itself an import with its own batchId; the log
   * is append-only.
   *
   * Reversed in DESCENDING `at` order, skipping any target whose current roles
   * have diverged (DIVERGED_SINCE_IMPORT) rather than silently reverting a
   * later deliberate change.
   */
  undoBulkImport: roleManagerProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "undoBulkImport");
      const actorUserID = ctx.session.user.userID;

      const original = await ctx.db.bulkRoleImport.findUnique({
        where: { batchId: input.batchId },
      });
      if (!original) throw new TRPCError({ code: "NOT_FOUND" });
      if (original.undoneBy) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "ALREADY_UNDONE" });
      }

      const undoBatchId = randomUUID();
      await ctx.db.bulkRoleImport.create({
        data: {
          batchId: undoBatchId,
          actorUserID,
          actorRoles: ctx.session.user.roles ?? [],
          mode: "set",
          note: input.reason ?? null,
          undoOf: input.batchId,
        },
      });

      // "pending.claim" is included deliberately: a grant claimed at first
      // login after the import must be reversed too, or escalation outlives the
      // rollback of the import that created it.
      const rows = await ctx.db.roleAuditLog.findMany({
        where: {
          batchId: input.batchId,
          ok: true,
          action: { in: ["set", "pending.claim"] },
        },
        orderBy: { at: "desc" },
        take: 1000,
      });

      const results: {
        targetUserID: string;
        status: "ok" | "denied";
        denyReason?: string;
      }[] = [];
      const seen = new Set<string>();

      for (const r of rows) {
        const target = r.targetUserID;
        if (!target || seen.has(target)) continue; // newest row per target wins
        seen.add(target);
        try {
          const { actorRoles, before, after, added, removed } =
            await assertCanMutateRoles({
              db: ctx.db,
              actorUserID,
              targetUserID: target,
              requestedRoles: r.rolesBefore.filter(isGrantableRole),
            });
          const diverged =
            before.length !== r.rolesAfter.filter(isGrantableRole).length ||
            before.some((x) => !r.rolesAfter.includes(x));
          if (diverged) {
            await writeAudit(ctx.db, {
              actorUserID,
              actorRoles,
              targetUserID: target,
              action: "denied",
              rolesBefore: before,
              rolesAfter: r.rolesBefore,
              ok: false,
              denyReason: "DIVERGED_SINCE_IMPORT",
              batchId: undoBatchId,
            });
            results.push({
              targetUserID: target,
              status: "denied",
              denyReason: "DIVERGED_SINCE_IMPORT",
            });
            continue;
          }
          await applyRoleChange({
            db: ctx.db,
            actorUserID,
            actorRoles,
            targetUserID: target,
            before,
            after,
            added,
            removed,
            reason: input.reason,
            batchId: undoBatchId,
          });
          results.push({ targetUserID: target, status: "ok" });
        } catch (err) {
          if (err instanceof TRPCError) {
            results.push({
              targetUserID: target,
              status: "denied",
              denyReason: err.message,
            });
          } else {
            throw err;
          }
        }
      }

      // Unclaimed deferred grants from the same import are deleted rather than
      // left to land after the undo. Counted separately so the UI does not
      // report them as reverted role changes.
      const purged = await ctx.db.pendingRoleGrant.deleteMany({
        where: { batchId: input.batchId },
      });

      await ctx.db.bulkRoleImport.update({
        where: { batchId: input.batchId },
        data: { undoneBy: undoBatchId },
      });

      return {
        undoBatchId,
        reverted: results.filter((r) => r.status === "ok").length,
        skipped: results.filter((r) => r.status === "denied").length,
        pendingGrantsDeleted: purged.count,
        results,
      };
    }),

  /* ---- deferred grants (D-8) ----------------------------------------- */

  /**
   * A pending grant is a BEARER CREDENTIAL against a mailbox nobody has claimed
   * yet, so the creation rules are enforced here and not only in the UI:
   *   1. `resident` is unrepresentable (not in roleSchema) — I-8e. A user with
   *      "no resident row yet" is I-8a/I-8b's case, never this one.
   *   2. every role must be in assignableBy(actor's LIVE roles) — a jcrc
   *      creating a pending `jcrc` is refused (D-3).
   *   3. `admin` additionally requires seeAdminIdentities, a non-empty reason
   *      and <= 14 days: the shorter it lives, the smaller the window.
   *   4. an existing User row is refused (USER_EXISTS_GRANT_DIRECTLY) — the
   *      redemption fast path fires only at true first login, so a grant
   *      created after signup would be stranded.
   *   5. keyed ONLY on a canonical E-format id from an E-id or an @u.nus.edu
   *      address. NEVER a matric (self-asserted) and never a display name.
   */
  createPendingGrants: roleManagerProcedure
    .input(
      z.object({
        rows: z
          .array(
            z.object({
              identifier: z.string().trim().min(1).max(120),
              roles: roleSchema.array().min(1).max(8),
            }),
          )
          .min(1)
          .max(200),
        expiresInDays: z.number().int().min(1).max(90).default(30),
        reason: z.string().trim().max(500).optional(),
        batchId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "createPendingGrants");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID); // I-5 re-read
      const canAssign = assignableBy(actorRoles);
      const expiresAt = new Date(
        Date.now() + input.expiresInDays * 24 * 3600 * 1000,
      );

      const results: {
        identifier: string;
        status: "ok" | "denied";
        userID?: string;
        denyReason?: string;
      }[] = [];

      for (const row of input.rows) {
        const deny = async (denyReason: string, userID?: string) => {
          await writeAudit(ctx.db, {
            actorUserID,
            actorRoles,
            targetUserID: userID,
            action: "denied",
            rolesAfter: row.roles,
            ok: false,
            denyReason,
            batchId: input.batchId,
          });
          results.push({ identifier: row.identifier, status: "denied", denyReason, userID });
        };

        const hit = resolveIdentifier(row.identifier);
        if (!hit) {
          await deny("UNRESOLVED_IDENTIFIER");
          continue;
        }
        const bad = row.roles.find((r) => !canAssign.has(r));
        if (bad) {
          await deny(
            bad === CCA_HEAD_ROLE
              ? "USE_CCA_HEAD_ENDPOINT"
              : `CANNOT_GRANT_${bad.toUpperCase()}`,
            hit.userID,
          );
          continue;
        }
        if (row.roles.includes(ADMIN_ROLE)) {
          if (!c.seeAdminIdentities || !input.reason || input.expiresInDays > 14) {
            await deny("ADMIN_PENDING_GRANT_RESTRICTED", hit.userID);
            continue;
          }
        }
        const existing = await ctx.db.user.findFirst({
          where: {
            email: {
              equals: `${hit.userID.toLowerCase()}@u.nus.edu`,
              mode: "insensitive",
            },
          },
          select: { id: true },
        });
        if (existing) {
          await deny("USER_EXISTS_GRANT_DIRECTLY", hit.userID);
          continue;
        }

        const prior = await ctx.db.pendingRoleGrant.findUnique({
          where: { userID: hit.userID },
        });
        // Union the roles and take the LATER expiry, so two operators adding
        // the same person do not silently shorten or narrow each other's grant.
        const roles = [...new Set([...(prior?.roles ?? []), ...row.roles])];
        const laterExpiry =
          prior && prior.expiresAt > expiresAt ? prior.expiresAt : expiresAt;

        await ctx.db.pendingRoleGrant.upsert({
          where: { userID: hit.userID },
          create: {
            userID: hit.userID,
            roles,
            createdBy: actorUserID,
            createdByRoles: actorRoles,
            expiresAt: laterExpiry,
            batchId: input.batchId ?? null,
            reason: input.reason ?? null,
          },
          update: {
            roles,
            expiresAt: laterExpiry,
            createdBy: actorUserID,
            createdByRoles: actorRoles,
            batchId: input.batchId ?? null,
            reason: input.reason ?? null,
          },
        });
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: hit.userID,
          action: "pending.create",
          rolesBefore: prior?.roles ?? [],
          rolesAfter: roles,
          reason: input.reason,
          batchId: input.batchId,
        });
        results.push({
          identifier: row.identifier,
          status: "ok",
          userID: hit.userID,
        });
      }

      return { results };
    }),

  listPendingGrants: roleManagerProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).default(50) })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      const rows = await ctx.db.pendingRoleGrant.findMany({
        take: input.limit,
        orderBy: { createdAt: "desc" },
      });
      // D-2: admin-bearing rows are hidden, not redacted — a row whose only
      // role is `admin` must not surface as an empty-roles mystery entry.
      return c.seeAdminIdentities
        ? rows
        : rows.filter((r) => !r.roles.includes(ADMIN_ROLE));
    }),

  revokePendingGrant: roleManagerProcedure
    .input(
      z.object({
        userID: userIDSchema,
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "createPendingGrants");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID);
      const row = await ctx.db.pendingRoleGrant.findUnique({
        where: { userID: input.userID },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      // A jcrc must not be able to delete an admin-bearing grant they could not
      // have created and cannot even see.
      if (row.roles.includes(ADMIN_ROLE) && !c.seeAdminIdentities) {
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: input.userID,
          action: "denied",
          ok: false,
          denyReason: "CANNOT_MODIFY_AN_ADMIN",
        });
        forbid("CANNOT_MODIFY_AN_ADMIN");
      }
      await ctx.db.pendingRoleGrant.delete({ where: { userID: input.userID } });
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.userID,
        action: "pending.revoke",
        rolesBefore: row.roles,
        reason: input.reason,
        batchId: row.batchId ?? undefined,
      });
      return { userID: input.userID };
    }),

  purgeExpiredPendingGrants: adminProcedure.mutation(async ({ ctx }) => {
    const res = await ctx.db.pendingRoleGrant.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await writeAudit(ctx.db, {
      actorUserID: ctx.session.user.userID,
      actorRoles: ctx.session.user.roles ?? [],
      action: "pending.revoke",
      reason: `purged ${res.count} expired`,
    });
    return { deleted: res.count };
  }),
});
