import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, adminProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import {
  assertCcaManagementEnabled,
  isCcaManagementEnabled,
} from "~/server/api/services/ccaScope";
import { writeAudit } from "~/server/api/routers/admin";
import {
  membershipKeysFor,
  removeCcaMember,
  removeMemberTargetSchema,
} from "~/server/api/services/ccaMembers";
import { isCanonicalResidentID } from "~/lib/identity";

/**
 * CCA MANAGEMENT — admin only, and additionally behind the
 * `cca.management.enabled` kill switch.
 *
 * THERE IS NO DELETE PROCEDURE HERE, DELIBERATELY. Nothing in this application
 * deletes a CCA. deleteCcaCascade (services/cascade.ts) reaches Bookings by
 * ccaID and is guarded against the reserved ccaID 0 for that reason; it remains
 * script-only. Do not add a delete endpoint without reading that file first.
 *
 * Head management is NOT duplicated here either — admin.grantCcaHead /
 * revokeCcaHead / transferCcaHead already exist, are audited, and maintain
 * invariant CH-1 in one transaction. The management UI calls across to them.
 * Reimplementing them here would create a second writer of the `cca_head`
 * string, which is precisely what I-14 forbids.
 *
 * Separate from admin.ts because that file is past 1600 lines; the gate class
 * (adminProcedure) is the same, so these could have lived there.
 */

const KILL_SWITCH_NOTE =
  "every mutation asserts the kill switch BEFORE doing anything else — the " +
  "page-level check is cosmetic, this is the boundary";
void KILL_SWITCH_NOTE;

/**
 * A canonical userID as produced by canonicalUserID(email).
 *
 * DO NOT constrain this to /^E\d{7}$/. Non-E-format @u.nus.edu localparts are
 * REAL in this database — `g.s_samuel@u.nus.edu` canonicalises to "G.S_SAMUEL".
 * E-format is a validation rule for pasted grant targets, never an eligibility
 * gate; reintroducing the regex here re-opens lockout mode L-27.
 */
const canonicalUserIDSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCanonicalResidentID, "not a canonical @u.nus.edu userID");

/** ccaID 0 is RESERVED — see cascade.ts. It is never a manageable CCA. */
const ccaIDSchema = z.number().int().positive();

function requireManageCcas(roles: readonly string[]): void {
  if (!computeCapabilities(roles).manageCcas) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "CAPABILITY_REQUIRED:manageCcas",
    });
  }
}

export const ccaAdminRouter = createTRPCRouter({
  /** Every CCA, with head and membership-row counts, for the management table. */
  listAll: adminProcedure.query(async ({ ctx }) => {
    const roles = await getUserRoles(ctx.db, ctx.session.user.userID); // I-5
    requireManageCcas(roles);

    // Read, so it is NOT gated on the kill switch — but the switch state ships
    // with the payload so the page can disable its write affordances without a
    // second round trip. The switch is still asserted inside every mutation:
    // a disabled control is cosmetic, the procedure is the boundary.
    const enabled = await isCcaManagementEnabled(ctx.db);

    const [ccas, heads, memberships] = await Promise.all([
      ctx.db.cCA.findMany({
        select: { ccaID: true, ccaName: true, category: true },
        orderBy: { ccaName: "asc" },
      }),
      ctx.db.ccaHead.findMany({ select: { ccaID: true } }),
      // Whole-collection read. UserCCA has no ccaID index, so a per-CCA query
      // per row would be 89 collection scans; one scan grouped in memory is
      // strictly cheaper until the index lands.
      ctx.db.userCCA.findMany({ select: { ccaID: true } }),
    ]);

    const headCounts = new Map<number, number>();
    for (const h of heads) {
      headCounts.set(h.ccaID, (headCounts.get(h.ccaID) ?? 0) + 1);
    }
    const memberCounts = new Map<number, number>();
    for (const m of memberships) {
      memberCounts.set(m.ccaID, (memberCounts.get(m.ccaID) ?? 0) + 1);
    }

    return {
      enabled,
      ccas: ccas.map((c) => ({
        ...c,
        headCount: headCounts.get(c.ccaID) ?? 0,
        // Row count, NOT distinct people — duplicates are possible and the
        // roster is where they get named. Labelled as such in the UI.
        membershipRows: memberCounts.get(c.ccaID) ?? 0,
      })),
    };
  }),

  /**
   * Create a CCA.
   *
   * ccaID is Int @unique with NO auto-increment, so it must be allocated:
   * max + 1, insert, and let the unique index turn a concurrent allocation into
   * a loud P2002 rather than a silent duplicate. Retried once.
   *
   * A deleted ccaID is never reused — bookings and posts may still reference
   * it. Since nothing deletes CCAs, max+1 is monotonic in practice.
   *
   * NOTE: the CCA collection carries a DB-level $jsonSchema validator. If this
   * insert starts failing with a Mongo write error rather than a Prisma
   * validation error, dump the validator and compare field-for-field — Prisma
   * surfaces that class of failure opaquely.
   */
  create: adminProcedure
    .input(
      z.object({
        ccaName: z.string().trim().min(1).max(120),
        category: z.string().trim().min(1).max(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCcaManagementEnabled(ctx.db);
      const actorUserID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, actorUserID); // I-5
      requireManageCcas(roles);

      const clash = await ctx.db.cCA.findFirst({
        where: { ccaName: { equals: input.ccaName, mode: "insensitive" } },
        select: { ccaID: true },
      });
      if (clash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "CCA_NAME_ALREADY_EXISTS",
        });
      }

      let created: { ccaID: number; ccaName: string } | null = null;
      for (let attempt = 0; attempt < 2 && !created; attempt++) {
        const top = await ctx.db.cCA.findFirst({
          orderBy: { ccaID: "desc" },
          select: { ccaID: true },
        });
        const nextID = Math.max(1, (top?.ccaID ?? 0) + 1);
        try {
          created = await ctx.db.cCA.create({
            data: {
              ccaID: nextID,
              ccaName: input.ccaName,
              category: input.category,
            },
            select: { ccaID: true, ccaName: true },
          });
        } catch (e) {
          // P2002 = unique violation on ccaID: someone allocated the same id
          // between our read and our write. Recompute and retry once.
          const code = (e as { code?: string })?.code;
          if (code !== "P2002" || attempt === 1) throw e;
        }
      }

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        targetCcaID: created!.ccaID,
        action: "cca.create",
        reason: `${created!.ccaName} (${input.category})`,
      });
      return created!;
    }),

  /**
   * Rename / recategorise a CCA.
   *
   * AN UPDATE IN PLACE, NEVER A DELETE-AND-RECREATE. ccaID is the join key for
   * Bookings, UserCCA and CcaHead; recreating the row under a new id silently
   * orphans every membership in the CCA. scripts/remediation/reconcile-ccas.mjs
   * renames for exactly this reason — keep the two consistent.
   */
  rename: adminProcedure
    .input(
      z.object({
        ccaID: ccaIDSchema,
        ccaName: z.string().trim().min(1).max(120),
        category: z.string().trim().min(1).max(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCcaManagementEnabled(ctx.db);
      const actorUserID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, actorUserID); // I-5
      requireManageCcas(roles);

      const before = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaName: true, category: true },
      });
      if (!before) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_CCA" });
      }

      const updated = await ctx.db.cCA.update({
        where: { ccaID: input.ccaID },
        data: { ccaName: input.ccaName, category: input.category },
        select: { ccaID: true, ccaName: true, category: true },
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        targetCcaID: input.ccaID,
        action: "cca.rename",
        reason: `"${before.ccaName}" (${before.category}) → "${updated.ccaName}" (${updated.category})`,
      });
      return updated;
    }),

  /**
   * Add a member.
   *
   * NEW ROWS ARE WRITTEN CANONICAL. Every new-collection write in this repo
   * keys canonical (CcaHead, UserRole, UserMatric — invariant I-1), it is what
   * account merges produce, and getMyCCAs reads both key formats so the member
   * still sees the CCA. Writing A-format would deepen the legacy problem.
   *
   * Consequence, which is fine: a person may end up with a legacy A-format row
   * AND this canonical one. That is the same human under two keys, and the
   * roster's User.id dedupe collapses them into one entry.
   */
  addMember: adminProcedure
    .input(
      z.object({
        ccaID: ccaIDSchema,
        userID: canonicalUserIDSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCcaManagementEnabled(ctx.db);
      const actorUserID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, actorUserID); // I-5
      requireManageCcas(roles);

      const cca = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaID: true },
      });
      if (!cca) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_CCA" });
      }

      // Check BOTH key formats before inserting, so we don't add a canonical
      // row next to an existing legacy one for the same person. UserCCA has no
      // compound unique, so this check-then-insert can still race — the roster
      // surfaces any duplicate that slips through rather than hiding it.
      const target = await ctx.db.user.findFirst({
        where: {
          OR: [
            { email: { equals: `${input.userID.toLowerCase()}@u.nus.edu`, mode: "insensitive" } },
            { userID: input.userID },
          ],
        },
        select: { email: true, userID: true },
      });
      const keys = target
        ? membershipKeysFor(target)
        : [input.userID as string];

      const existing = await ctx.db.userCCA.findFirst({
        where: { ccaID: input.ccaID, userID: { in: keys } },
        select: { id: true },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "ALREADY_A_MEMBER",
        });
      }

      await ctx.db.userCCA.create({
        data: { ccaID: input.ccaID, userID: input.userID },
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        targetCcaID: input.ccaID,
        targetUserID: input.userID,
        action: "ccaMember.add",
      });
      return { ccaID: input.ccaID, userID: input.userID };
    }),

  /**
   * Remove a member.
   *
   * MEMBERSHIP LIVES IN THREE PLACES AND THIS MUST CLEAN ALL OF THEM:
   *   1. UserCCA rows under the CANONICAL key
   *   2. UserCCA rows under the LEGACY A-format key (same person, other key)
   *   3. the undeclared User.userCCA Int[] — a roster SOURCE, so a member left
   *      in the array simply reappears after a "successful" removal
   *
   * Adding writes only (1). The asymmetry is deliberate: do not grow the legacy
   * embedded array, but do clean it.
   *
   * The target is identified by SERVER-DERIVED keys, never client-supplied
   * ones: the caller names a User document (or a raw unresolved key straight
   * from the roster), and the key set is recomputed here.
   */
  removeMember: adminProcedure
    .input(z.object({ ccaID: ccaIDSchema, target: removeMemberTargetSchema }))
    .mutation(async ({ ctx, input }) => {
      await assertCcaManagementEnabled(ctx.db);
      const actorUserID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, actorUserID); // I-5
      requireManageCcas(roles);

      const result = await removeCcaMember(ctx.db, input.ccaID, input.target);

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        targetCcaID: input.ccaID,
        targetUserID: result.targetKey,
        action: "ccaMember.remove",
        reason: `admin: ${result.label} — ${result.removedRows} membership row(s)${
          result.touchedEmbedded ? " + embedded array" : ""
        }`,
      });

      return { ccaID: input.ccaID, removedRows: result.removedRows };
    }),
});
