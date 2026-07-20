import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, identifiedProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities, isEFormatUserID } from "~/server/api/services/roles";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import { resolveRoster } from "~/server/api/services/ccaRoster";
import { randomUUID } from "node:crypto";

import { del } from "@vercel/blob";
import { setCcaHeads, writeAudit } from "~/server/api/routers/admin";
import {
  removeCcaMember,
  removeMemberTargetSchema,
} from "~/server/api/services/ccaMembers";
import {
  ccaProfileInput,
  handoverHeadsInput,
  type HeadCandidateResult,
} from "~/lib/schemas/cca";
import { MATRIC_RE } from "~/lib/schemas/profile";
import { canonicalUserID } from "~/lib/identity";

/**
 * CCA-head-facing procedures, scoped per-CCA rather than per-role.
 *
 * NO LONGER READ-ONLY. `updateProfile` is the FIRST write in this application
 * that a non-admin can make: a CCA head editing their own CCA's description.
 * That raises the stakes on the guard below — assertHeadsCca used to protect
 * only read privacy, and now protects data integrity too. Admin-scoped CCA
 * writes (create/rename, heads, members) still live in ccaAdmin.*, and the
 * validator-guarded `CCA` collection is never written from here.
 *
 * THE ONE RULE IN THIS FILE: every procedure that takes a ccaID FROM THE CLIENT
 * MUST call assertHeadsCca before touching CCA-scoped data. The procedure
 * builder does NOT do it for you — identifiedProcedure only narrows identity. A
 * procedure here that forgets the guard is a full-roster IDOR across all 89
 * CCAs.
 *
 *     grep -n "input.ccaID" src/server/api/routers/cca.ts
 *     → every hit must sit in a procedure whose body also names assertHeadsCca.
 *
 * The gate is on `input.ccaID` SPECIFICALLY, not on the string "ccaID". listMine
 * touches ccaID a dozen times and needs no guard, because every id it handles
 * was read back from `ccaHead.findMany({ where: { userID } })` — the caller's
 * own headships — rather than supplied by the caller. Widening the pattern to
 * bare "ccaID" would flag that as a violation, and a gate that cries wolf is a
 * gate people learn to skip.
 *
 * Middleware cannot cover this: the ccaID lives in the INPUT, not the context.
 *
 * WHY A SEPARATE ROUTER FROM admin.ts. The authorization CLASS differs. Every
 * procedure in admin.ts is roleManagerProcedure or adminProcedure — a coarse
 * role gate that fully answers the question. These are object-scoped, where the
 * builder answers NOTHING and the guard is the entire boundary. Sitting the two
 * kinds adjacent invites a future procedure that copies its neighbour's builder
 * and forgets the guard. (admin.ts also imports node:crypto and ~/env for the
 * bulk plan-token HMAC, which a head-facing route should not pull in.)
 *
 * WHY identifiedProcedure. assertHeadsCca needs a non-null canonical userID as a
 * CcaHead lookup key. trpc.ts warns that adoption of this builder is deliberately
 * narrow — only procedures that ALREADY refuse an empty identity may take it.
 * These are new and refuse an empty identity BY CONSTRUCTION: a null userID
 * matches no CcaHead row, and a null-keyed lookup is the I-8d red line. So this
 * is not a behaviour change wearing a refactor's clothes.
 */
export const ccaRouter = createTRPCRouter({
  /**
   * The CCAs this caller heads. Deliberately NOT "all 89 CCAs for a manager" —
   * this is the head's own surface, and managers have /admin/ccas. A manager
   * with no headships gets an empty list and `canManageAll: true`, which the
   * page turns into a pointer rather than a dead end.
   */
  listMine: identifiedProcedure.query(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    // I-5: LIVE read. session.user.roles is render-only and up to 30 days stale.
    const roles = await getUserRoles(ctx.db, userID);
    const capabilities = computeCapabilities(roles);

    if (!capabilities.reachCcaDashboard) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "CAPABILITY_REQUIRED:reachCcaDashboard",
      });
    }

    const mine = await ctx.db.ccaHead.findMany({
      where: { userID },
      select: { ccaID: true, grantedAt: true },
      orderBy: { ccaID: "asc" },
    });

    const ccaIDs = mine.map((m) => m.ccaID);
    if (ccaIDs.length === 0) {
      return { ccas: [], canManageAll: capabilities.viewAnyCcaRoster };
    }

    const [named, allHeads] = await Promise.all([
      ctx.db.cCA.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true, ccaName: true, category: true },
      }),
      // Indexed on ccaID. Counting co-heads, not resolving them — no hydration.
      ctx.db.ccaHead.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true },
      }),
    ]);

    const byID = new Map(named.map((c) => [c.ccaID, c]));
    const headCounts = new Map<number, number>();
    for (const h of allHeads) {
      headCounts.set(h.ccaID, (headCounts.get(h.ccaID) ?? 0) + 1);
    }

    const ccas = mine.map((m) => {
      const row = byID.get(m.ccaID);
      return {
        ccaID: m.ccaID,
        // null when the ccaID has no CCA row — the CcaBadges amber idiom. This
        // is the only place a bare ccaID reaches the UI.
        ccaName: row?.ccaName ?? null,
        category: row?.category ?? null,
        headCount: headCounts.get(m.ccaID) ?? 1,
        grantedAt: m.grantedAt,
      };
    });

    ccas.sort(
      (a, b) =>
        (a.category ?? "￿").localeCompare(b.category ?? "￿") ||
        (a.ccaName ?? "￿").localeCompare(b.ccaName ?? "￿"),
    );

    return { ccas, canManageAll: capabilities.viewAnyCcaRoster };
  }),

  /**
   * The roster: heads and members of one CCA.
   *
   * THE security boundary for both /cca/[ccaID] and /admin/ccas. Neither page
   * pre-guards — a client can call this from the console on any page, so the
   * layouts are defence in depth only (I-7).
   */
  getRoster: identifiedProcedure
    // .positive(), not .nonnegative(): ccaID 0 is RESERVED (see cascade.ts) and
    // is never a real CCA, so it is refused at the boundary rather than
    // resolving to an empty roster that looks like a legitimate answer.
    .input(z.object({ ccaID: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);
      const roster = await resolveRoster(ctx.db, input.ccaID);
      return { ...roster, via: scope.via };
    }),

  /**
   * The CCA's editable profile. Separate from getRoster because the details
   * page needs none of the roster's expensive resolution, and the overview
   * needs the roster without waiting on this.
   */
  getProfile: identifiedProcedure
    .input(z.object({ ccaID: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const row = await ctx.db.ccaProfile.findUnique({
        where: { ccaID: input.ccaID },
        select: {
          description: true,
          logoUrl: true,
          bannerUrl: true,
          updatedAt: true,
          updatedBy: true,
        },
      });

      // No row is the normal state for a CCA nobody has described yet — an
      // empty profile, not an error.
      return {
        description: row?.description ?? "",
        logoUrl: row?.logoUrl ?? null,
        bannerUrl: row?.bannerUrl ?? null,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    }),

  /**
   * THE FIRST WRITE A NON-ADMIN CAN MAKE IN THIS APP.
   *
   * Writes CcaProfile — never `CCA`, which is $jsonSchema-guarded and would
   * reject an undeclared `description` silently at write time (code 121, ok:1).
   * See the model's doc comment in prisma/schema.prisma.
   *
   * `ccaName` and `category` are deliberately NOT accepted here: they live on
   * CCA and are renamed only by admins via ccaAdmin.rename. ccaProfileInput
   * documents that constraint and zod strips anything else the client sends.
   */
  updateProfile: identifiedProcedure
    .input(ccaProfileInput)
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      // The CCA must exist. Without this a head whose CCA was renamed away
      // could write a profile row pointing at nothing, which would then be
      // invisible everywhere and impossible to clean up from the UI.
      const cca = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaID: true },
      });
      if (!cca) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_CCA" });
      }

      const before = await ctx.db.ccaProfile.findUnique({
        where: { ccaID: input.ccaID },
        select: { description: true, logoUrl: true, bannerUrl: true },
      });

      const saved = await ctx.db.ccaProfile.upsert({
        where: { ccaID: input.ccaID },
        create: {
          ccaID: input.ccaID,
          description: input.description,
          logoUrl: input.logoUrl,
          bannerUrl: input.bannerUrl,
          updatedAt: new Date(),
          updatedBy: userID,
        },
        update: {
          description: input.description,
          logoUrl: input.logoUrl,
          bannerUrl: input.bannerUrl,
          updatedAt: new Date(),
          updatedBy: userID,
        },
        select: {
          description: true,
          logoUrl: true,
          bannerUrl: true,
          updatedAt: true,
          updatedBy: true,
        },
      });

      /**
       * Delete blobs this save replaced, so a CCA that re-uploads its logo ten
       * times doesn't leave nine paying tenants in the store. `del()` is free
       * per Vercel's pricing docs.
       *
       * AFTER the upsert and deliberately non-fatal: an orphaned blob costs
       * fractions of a cent, while a delete failure that rolled back the save
       * would lose the user's edit. Logged rather than swallowed so a
       * persistent failure is visible.
       *
       * The input URLs are already proven to be ours and this CCA's by
       * ccaProfileInput's superRefine, and `before` came from our own row —
       * so nothing here can be pointed at another CCA's blob.
       */
      const replaced = [
        before?.logoUrl && before.logoUrl !== saved.logoUrl
          ? before.logoUrl
          : null,
        before?.bannerUrl && before.bannerUrl !== saved.bannerUrl
          ? before.bannerUrl
          : null,
      ].filter((u): u is string => u !== null);

      if (replaced.length > 0) {
        try {
          await del(replaced);
        } catch (err) {
          console.error(
            JSON.stringify({
              evt: "cca_blob_delete_failed",
              ccaID: input.ccaID,
              urls: replaced,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      // Audited on ctx.db, outside any transaction (I-15). `via` records
      // whether this was the CCA's own head or a manager acting over the top.
      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: input.ccaID,
        action: "ccaProfile.update",
        reason: [
          scope.via,
          `description ${input.description.length} chars`,
          before?.logoUrl !== saved.logoUrl
            ? `logo ${saved.logoUrl ? "set" : "removed"}`
            : null,
          before?.bannerUrl !== saved.bannerUrl
            ? `banner ${saved.bannerUrl ? "set" : "removed"}`
            : null,
        ]
          .filter(Boolean)
          .join("; "),
      });

      return saved;
    }),

  /**
   * Remove one or more members from a CCA a head is responsible for.
   *
   * BATCH, not single: `targets` is 1..N, so removing one member and removing
   * fifty go through the same path — the roster has "a lot of members" and
   * pruning them one round-trip at a time is the thing this avoids.
   *
   * The head-facing sibling of `ccaAdmin.removeMember`. Both wrap the SAME
   * `removeCcaMember` service, so the three-target delete (canonical UserCCA,
   * legacy-key UserCCA, embedded array) cannot diverge between them.
   *
   * There is intentionally NO addMember here: joining a CCA will run through the
   * application-management system, not a head typing a userID. Removal is the
   * only membership write a head gets in this phase.
   *
   * NO KILL SWITCH, unlike the admin surface. `cca.management.enabled` gates the
   * admin CRUD tab (create/rename/heads/members) as one unit; a head pruning
   * their own roster is a distinct, self-scoped, audited action and is the
   * feature, not part of that surface. The safety here is the client
   * confirmation plus the per-CCA guard, not a global flag.
   *
   * Only MEMBERS are removable — heads never reach this path. The roster splits
   * on `isHead`, so a co-head (even one who also holds membership rows) sits in
   * the heads list and never appears as a removable member row. Headship is
   * managed only through grant/revoke/transfer, which maintain CH-1.
   */
  removeMembers: identifiedProcedure
    .input(
      z.object({
        ccaID: z.number().int().positive(),
        // Capped so one request cannot ask for an unbounded number of
        // collection scans (UserCCA has no ccaID index yet). 200 comfortably
        // exceeds any real CCA's roster; the UI can chunk if that ever changes.
        targets: z.array(removeMemberTargetSchema).min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      // ONE authorisation check for the whole batch — the scope is the CCA, not
      // the individual member.
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      // One batchId ties every row of this removal together in the audit log,
      // exactly as transferCcaHead groups its two halves — so a bulk prune is
      // one reviewable event, while each member is still an individually
      // attributable row.
      const batchId = randomUUID();

      let removedMembers = 0;
      let removedRows = 0;
      let failed = 0;

      // Per-target and independent, NOT one transaction: each removeCcaMember
      // is idempotent, and one bad target (e.g. a User doc deleted mid-flight)
      // must not roll back the members already removed. Failures are counted
      // and surfaced, never silent.
      for (const target of input.targets) {
        try {
          const result = await removeCcaMember(ctx.db, input.ccaID, target);
          removedMembers += 1;
          removedRows += result.removedRows;
          await writeAudit(ctx.db, {
            actorUserID: userID,
            actorRoles: roles,
            targetCcaID: input.ccaID,
            targetUserID: result.targetKey,
            action: "ccaMember.remove",
            batchId,
            reason: `${scope.via} (bulk): ${result.label} — ${result.removedRows} membership row(s)${
              result.touchedEmbedded ? " + embedded array" : ""
            }`,
          });
        } catch {
          failed += 1;
        }
      }

      return { ccaID: input.ccaID, removedMembers, removedRows, failed };
    }),

  /**
   * Resolve a typed identifier (email / NUSNET id / matric) to an account, for
   * the handover and admin add-head previews.
   *
   * Guarded by assertHeadsCca so it is NOT an open directory oracle: only a head
   * of this CCA (or a manager) can resolve identities through it. The name/email
   * it returns is what the human eyeballs before committing a headship change.
   *
   * Never guesses. A matric matching more than one account is AMBIGUOUS and
   * refused — matric is self-asserted and UserMatric.matric is not unique.
   */
  resolveHeadCandidate: identifiedProcedure
    .input(
      z.object({
        ccaID: z.number().int().positive(),
        identifier: z.string().trim().min(1).max(120),
      }),
    )
    .query(async ({ ctx, input }): Promise<HeadCandidateResult> => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const raw = input.identifier.trim();

      // Resolve to a canonical userID by tier. Matric is the only tier that can
      // be AMBIGUOUS, because it is looked up in a non-unique collection.
      let candidateID: string | null = null;
      if (raw.includes("@")) {
        candidateID = canonicalUserID(raw); // email → canonical, or null
      } else if (isEFormatUserID(raw.toUpperCase())) {
        candidateID = raw.toUpperCase(); // NUSNET id is already canonical
      } else if (MATRIC_RE.test(raw.toUpperCase())) {
        const rows = await ctx.db.userMatric.findMany({
          where: { matric: raw.toUpperCase() },
          select: { userID: true },
        });
        if (rows.length > 1) return { status: "AMBIGUOUS" };
        candidateID = rows[0]?.userID ?? null;
      }

      if (candidateID === null) return { status: "NOT_FOUND" };

      // Must have signed in: a UserRole row is written at account creation and
      // topped up every session, so "has a row" is a reliable proxy for "has
      // logged in at least once" (mirrors transferCcaHead's H3 successor gate).
      const hasSignedIn = await ctx.db.userRole.findUnique({
        where: { userID: candidateID },
        select: { userID: true },
      });
      if (!hasSignedIn) return { status: "NOT_SIGNED_IN", userID: candidateID };

      // Best-effort display. There is no reverse canonical→User query, so guess
      // the email like admin.listUsers does, and fall back to the stored key.
      const user = await ctx.db.user.findFirst({
        where: {
          OR: [
            {
              email: {
                equals: `${candidateID.toLowerCase()}@u.nus.edu`,
                mode: "insensitive",
              },
            },
            { userID: candidateID },
          ],
        },
        // Never a bare read: passwordHash must not leave the server, and a
        // Google-adapter row lacking it throws on deserialization (I-2).
        select: { displayName: true, email: true },
      });

      return {
        status: "FOUND",
        userID: candidateID,
        displayName: user?.displayName ?? null,
        email: user?.email ?? null,
      };
    }),

  /**
   * HAND OVER — overwrite this CCA's head set to exactly `newHeadUserIDs`.
   *
   * The first head-INITIATED change to headship (07-cca-future.md §6.6 deferred
   * this until an object-scoped guard existed; assertHeadsCca is that guard). A
   * head who omits themselves stops being a head — that is the point of handing
   * over; to stay, they include themselves.
   *
   * setCcaHeads is the write primitive and shares writeCcaHeadString with
   * grant/revoke/transfer, so CH-1 holds and no other role is touched — which is
   * why this head-facing path needs no admin-target guard (see setCcaHeads).
   */
  handoverHeads: identifiedProcedure
    .input(handoverHeadsInput)
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const desired = [...new Set(input.newHeadUserIDs)];
      // Belt-and-braces: the schema already enforces >= 1, but overwriting to
      // zero heads is the one unrecoverable state, so refuse it explicitly too.
      if (desired.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "NO_HEADS_LEFT" });
      }

      // Every incoming head must have signed in — re-checked server-side, never
      // trusting the client's preview. A userID with no UserRole row cannot be
      // made a head (else a CCA is handed to someone who may never appear).
      const rows = await ctx.db.userRole.findMany({
        where: { userID: { in: desired } },
        select: { userID: true },
      });
      const signedIn = new Set(rows.map((r) => r.userID));
      const missing = desired.filter((u) => !signedIn.has(u));
      if (missing.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "SUCCESSOR_HAS_NOT_SIGNED_IN",
        });
      }

      const { granted, revoked, batchId } = await setCcaHeads(
        ctx.db,
        input.ccaID,
        desired,
        userID,
      );

      // One audit row per change, all under the batchId — a handover reads as a
      // single event while each grant/revoke stays individually attributable.
      for (const target of granted) {
        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetUserID: target,
          targetCcaID: input.ccaID,
          action: "ccaHead.grant",
          batchId,
          reason: `${scope.via} (handover)`,
        });
      }
      for (const target of revoked) {
        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetUserID: target,
          targetCcaID: input.ccaID,
          action: "ccaHead.revoke",
          batchId,
          reason: `${scope.via} (handover)`,
        });
      }

      return {
        ccaID: input.ccaID,
        granted: granted.length,
        revoked: revoked.length,
        // The initiator lost their headship unless they kept themselves — the
        // UI uses this to warn that /cca is about to close for them.
        selfRemoved: revoked.includes(userID),
      };
    }),
});
