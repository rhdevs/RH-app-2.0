import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { computeCapabilities } from "./roles";
import { assertScrcEnabled } from "./scrcFlag";

/* -------------------------------------------------------------------------- */
/* The object-scoped guard                                                     */
/* -------------------------------------------------------------------------- */

export type CcaScope = {
  ccaID: number;
  /**
   * How the caller got in. Recorded so the UI can say "viewing as JCRC".
   *
   * `readOnly` is produced ONLY by assertMayViewCcaRoster (never by
   * assertHeadsCca), so a `via` of "readOnly" can never accompany a write. The
   * UI must treat it as strictly weaker than the other two; RosterPanel already
   * does, because it branches on `via === "manageCcaHeads"` positively rather
   * than switching exhaustively.
   */
  via: "headship" | "manageCcaHeads" | "readOnly";
};

export type CcaActor = {
  userID: string;
  roles: readonly string[];
};

/**
 * THE object-scoped authorization check — this codebase's first
 * (07-cca-future.md §6.6 names it as the seam that makes self-serve handover
 * cheap later).
 *
 * It answers "may THIS actor act on THIS ccaID", which computeCapabilities
 * structurally CANNOT: capabilities are computed from roles alone, and a role
 * carries no object.
 *
 * IT READS CcaHead DIRECTLY AND MUST NEVER CONSULT roles.includes("cca_head").
 * That string is scope-FREE by construction — 07 §1.1 deliberately kept scope
 * out of UserRole.roles — so it answers "heads something", never "heads this".
 * Under invariant CH-1 the two agree; CH-1 is a code contract MongoDB cannot
 * enforce, and not depending on it is the entire point of this function.
 *
 * `actor.roles` MUST be a live getUserRoles() read (I-5), never
 * session.user.roles. The session copy is render-only and can be up to 30 days
 * stale, which on this path would mean a demoted user still reading rosters.
 *
 * ORDER: the capability is checked first because it is in-memory and saves the
 * query for admin/jcrc. `via` distinguishes an admin who reached a CCA by
 * override from a genuine head — the fact a future audit row wants.
 */
export async function assertHeadsCca(
  db: PrismaClient,
  actor: CcaActor,
  ccaID: number,
): Promise<CcaScope> {
  if (computeCapabilities(actor.roles).manageCcaHeads) {
    return { ccaID, via: "manageCcaHeads" };
  }

  const row = await db.ccaHead.findUnique({
    where: { userID_ccaID: { userID: actor.userID, ccaID } },
    select: { id: true },
  });
  if (row) return { ccaID, via: "headship" };

  // Same message grantCcaHead's H4 guard already uses, and the same shape as
  // requireCapability's CAPABILITY_REQUIRED:<key>. NOT_FOUND would be better
  // non-disclosure but would lie about a CCA that exists, and a ccaID is not a
  // secret — it is public in the booking UI.
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "NOT_A_HEAD_OF_THIS_CCA",
  });
}

/**
 * READ ONLY. NEVER call this from a procedure that writes, and never merge it
 * with assertHeadsCca.
 *
 * assertHeadsCca is THE write guard: it also gates cca.updateProfile,
 * cca.removeMembers, cca.handoverHeads, cca.memberDirectory (matric/telegram/
 * bio) and event.publish / cancelEvent / exportAttendees. Widening it by one
 * capability would hand all of that to whoever holds that capability, which is
 * why the hall office got a SECOND function instead of a wider first one. The
 * two must stay separate even though branches 1 and 2 below are duplicated
 * from it — the duplication is the point, and it is four lines.
 *
 * ORDER IS LOAD-BEARING. Branches 1 and 2 are byte-for-byte the decision
 * assertHeadsCca makes, and they come FIRST, so an admin, a jcrc or a genuine
 * head reaches exactly the same answer by exactly the same route and NEVER
 * touches the `scrc.enabled` flag read. Only a caller who would otherwise have
 * been refused falls through to branch 3, so flipping the switch off cannot
 * affect anybody who could already read the roster.
 *
 * `actor.roles` MUST be a live getUserRoles() read (I-5), same as
 * assertHeadsCca — see its comment for why.
 */
export async function assertMayViewCcaRoster(
  db: PrismaClient,
  actor: CcaActor,
  ccaID: number,
): Promise<CcaScope> {
  const capabilities = computeCapabilities(actor.roles);

  // 1 + 2: identical to assertHeadsCca, in the same order, for the same reason.
  if (capabilities.manageCcaHeads) {
    return { ccaID, via: "manageCcaHeads" };
  }

  const row = await db.ccaHead.findUnique({
    where: { userID_ccaID: { userID: actor.userID, ccaID } },
    select: { id: true },
  });
  if (row) return { ccaID, via: "headship" };

  // 3: the read-only tier (hall office). Behind the kill switch, and behind it
  // HERE rather than in the callers, so the flag cannot be forgotten by the
  // next procedure that adopts this guard.
  if (capabilities.viewCcaRostersReadOnly) {
    await assertScrcEnabled(db);
    return { ccaID, via: "readOnly" };
  }

  // Same message and same non-disclosure argument as assertHeadsCca. A caller
  // refused here learns nothing it would not have learned there.
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "NOT_A_HEAD_OF_THIS_CCA",
  });
}

/* -------------------------------------------------------------------------- */
/* The CCA-management kill switch                                              */
/* -------------------------------------------------------------------------- */

const MGMT_FLAG_KEY = "cca.management.enabled";
const FLAG_TTL_MS = 15_000;

let mgmtFlagCache: { at: number; on: boolean } | null = null;

/**
 * I-11 applied to /admin/manage-ccas, with ONE DELIBERATE DIVERGENCE from the
 * three switches in access.ts.
 *
 * Those switches gate whether NEW enforcement applies to an EXISTING path, so
 * they fail OPEN — an unreachable flag means "behave as the app did yesterday",
 * which for them is no gate. That is right for enforcement and WRONG here.
 *
 * This switch gates a NEW WRITE SURFACE that creates and renames CCAs and edits
 * membership. "Behave as yesterday" for a surface that did not exist yesterday
 * means DISABLED. So an unreachable flag returns false, and the absence of the
 * row returns false: the surface is inert until someone deliberately writes
 * `cca.management.enabled = "on"`.
 *
 * Not in access.ts because that module's resetEnforcementModeCache() is scoped
 * to the three RBAC enforcement switches, and this is neither an enforcement
 * mode nor part of that rollout.
 */
export async function isCcaManagementEnabled(
  db: PrismaClient,
): Promise<boolean> {
  if (mgmtFlagCache && Date.now() - mgmtFlagCache.at < FLAG_TTL_MS) {
    return mgmtFlagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: MGMT_FLAG_KEY },
    });
    const on = row?.value === "on";
    mgmtFlagCache = { at: Date.now(), on };
    return on;
  } catch {
    // Fail CLOSED, and deliberately NOT cached — the next request retries
    // rather than pinning "disabled" for 15s on a transient Atlas hiccup.
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetCcaManagementCache(): void {
  mgmtFlagCache = null;
}

/**
 * Assert the switch is on. Called at the top of EVERY ccaAdmin mutation — the
 * page-level check is cosmetic, this one is the boundary.
 */
export async function assertCcaManagementEnabled(
  db: PrismaClient,
): Promise<void> {
  if (!(await isCcaManagementEnabled(db))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "CCA_MANAGEMENT_DISABLED",
    });
  }
}
