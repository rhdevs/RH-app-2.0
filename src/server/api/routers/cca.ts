import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  createTRPCRouter,
  identifiedProcedure,
  oversightProcedure,
} from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities, isEFormatUserID } from "~/server/api/services/roles";
import {
  assertHeadsCca,
  assertMayViewCcaRoster,
} from "~/server/api/services/ccaScope";
import { assertScrcEnabled } from "~/server/api/services/scrcFlag";
import {
  redactRosterForReadOnly,
  resolveRoster,
} from "~/server/api/services/ccaRoster";
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
 * MUST call assertHeadsCca — or, for a roster READ only, assertMayViewCcaRoster
 * — before touching CCA-scoped data. The procedure builder does NOT do it for
 * you — identifiedProcedure only narrows identity. A procedure here that forgets
 * the guard is a full-roster IDOR across all 89 CCAs.
 *
 *     grep -nE "assertHeadsCca|assertMayViewCcaRoster" src/server/api/routers/cca.ts
 *     grep -n "input.ccaID" src/server/api/routers/cca.ts
 *     → every hit of the second must sit in a procedure whose body also names
 *       one of the two guards.
 *
 * THE TWO ARE NOT INTERCHANGEABLE. assertMayViewCcaRoster is a strictly WIDER
 * gate: it additionally admits the hall office (viewCcaRostersReadOnly), who may
 * look at a roster and nothing else. It is therefore NOT a substitute for
 * assertHeadsCca on a write, nor on a read that carries PII — using it on
 * updateProfile, removeMembers, handoverHeads or memberDirectory (matric /
 * telegram / bio) would hand those to a read-only role in one line. Writes and
 * PII reads stay on assertHeadsCca; only getRoster and listHeads take the wider
 * guard.
 *
 * AND THE WIDER GUARD IS NOT THE WHOLE STORY — BOTH OF THOSE TWO ALSO REDACT.
 * A full roster carries every member's email, stored userID and raw membership
 * keys (mostly A-format matrics), and listHeads carries every head's email, so
 * "the guard let them in" is only half the boundary. Each branches on
 * `scope.via === "readOnly"` and strips identifiers down to names, headship and
 * grant dates for that tier alone; heads and managers are byte-identical to
 * before. If you add a third procedure to this guard, it inherits the
 * obligation: check `scope.via` and decide what the read-only tier may see.
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
   *
   * Guarded by assertMayViewCcaRoster, NOT assertHeadsCca, and this is the only
   * difference between the two: a roster is names + grant dates, so the hall
   * office may read one without being able to touch anything. Admin, jcrc and a
   * genuine head take branches 1 and 2 of that guard, which are byte-for-byte
   * assertHeadsCca — so their answer, their `via` and their query count are
   * unchanged, and they never touch the `scrc.enabled` flag read. The flag check
   * for the read-only tier lives INSIDE the guard; do not repeat it here.
   */
  getRoster: identifiedProcedure
    // .positive(), not .nonnegative(): ccaID 0 is RESERVED (see cascade.ts) and
    // is never a real CCA, so it is refused at the boundary rather than
    // resolving to an empty roster that looks like a legitimate answer.
    .input(z.object({ ccaID: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertMayViewCcaRoster(
        ctx.db,
        { userID, roles },
        input.ccaID,
      );
      const roster = await resolveRoster(ctx.db, input.ccaID);
      // THE READ-ONLY TIER GETS NAMES, NOT IDENTIFIERS. A full roster carries
      // every member's email, stored userID and raw membership keys (mostly
      // A-format matrics); a caller who can enumerate all 89 CCAs would
      // reassemble most of admin.listUsers from them. Keyed off `scope.via`,
      // which only assertMayViewCcaRoster can set to "readOnly", so a head or a
      // manager takes the untouched branch and sees exactly what they always
      // have. See redactRosterForReadOnly.
      const visible =
        scope.via === "readOnly" ? redactRosterForReadOnly(roster) : roster;
      return { ...visible, via: scope.via };
    }),

  /**
   * The roster PLUS each resolved person's profile details (matric, block,
   * telegram, bio) and the keys that resolved to them. Powers the
   * click-to-expand member details and the "Export to Excel" download on a
   * head's member list.
   *
   * Head-only and per-CCA (assertHeadsCca), and it exposes EXACTLY the detail
   * set the Applications tab already shows a head (matric/telegram/bio), so it
   * opens no new sensitivity boundary. Profile fields are read by the EXACT
   * User.id resolveRoster already matched — no email guessing here — and
   * selected EXPLICITLY: never a bare User read (passwordHash must not leave the
   * server, and a passwordHash-less Google-adapter row throws on a full read,
   * I-2). Matric lives in UserMatric keyed by canonical userID, so every key a
   * member might be filed under is tried.
   *
   * Entries include heads as well as members (with a `role`), so the export is
   * the whole roster; the members and heads tables map back to it by `rowKey`.
   */
  memberDirectory: identifiedProcedure
    .input(z.object({ ccaID: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(
        ctx.db,
        { userID, roles },
        input.ccaID,
      );

      const roster = await resolveRoster(ctx.db, input.ccaID);
      const entries = [...roster.heads, ...roster.members];

      const userIds: string[] = [];
      const matricKeys = new Set<string>();
      for (const e of entries) {
        if (e.kind !== "resolved") continue;
        userIds.push(e.userId);
        for (const k of e.membershipKeys) matricKeys.add(k);
        if (e.storedUserID) matricKeys.add(e.storedUserID);
        const cid = canonicalUserID(e.email);
        if (cid) matricKeys.add(cid);
      }

      const [profiles, matrics] = await Promise.all([
        userIds.length === 0
          ? Promise.resolve(
              [] as {
                id: string;
                telegramHandle: string | null;
                block: number | null;
                bio: string | null;
              }[],
            )
          : ctx.db.user.findMany({
              where: { id: { in: userIds } },
              select: {
                id: true,
                telegramHandle: true,
                block: true,
                bio: true,
              },
            }),
        matricKeys.size === 0
          ? Promise.resolve([] as { userID: string; matric: string }[])
          : ctx.db.userMatric.findMany({
              where: { userID: { in: [...matricKeys] } },
              select: { userID: true, matric: true },
            }),
      ]);

      const profileById = new Map(profiles.map((p) => [p.id, p]));
      const matricByKey = new Map(matrics.map((m) => [m.userID, m.matric]));

      const directory = entries.map((e) => {
        const role: "Head" | "Member" = e.isHead ? "Head" : "Member";
        if (e.kind !== "resolved") {
          return {
            rowKey: `k:${e.key}`,
            resolved: false,
            role,
            name: null,
            email: null,
            userID: e.key,
            matric: null,
            block: null,
            telegramHandle: null,
            bio: null,
            membershipRecords: e.userCcaRowCount,
            joinedAt: e.grantedAt ? e.grantedAt.toISOString() : null,
            note:
              e.reason === "AMBIGUOUS_KEY"
                ? "Ambiguous record — more than one account claims this membership."
                : "Unmatched record — no account matches this membership key.",
          };
        }
        const prof = profileById.get(e.userId);
        let matric: string | null = null;
        const cid = canonicalUserID(e.email);
        for (const k of [...e.membershipKeys, e.storedUserID, cid]) {
          if (k && matricByKey.has(k)) {
            matric = matricByKey.get(k) ?? null;
            if (matric) break;
          }
        }
        return {
          rowKey: `u:${e.userId}`,
          resolved: true,
          role,
          name: e.displayName,
          email: e.email,
          userID: e.storedUserID,
          matric,
          block: prof?.block ?? null,
          telegramHandle: prof?.telegramHandle ?? null,
          bio: prof?.bio ?? null,
          membershipRecords: e.userCcaRowCount,
          joinedAt: e.grantedAt ? e.grantedAt.toISOString() : null,
          note: null,
        };
      });

      return { cca: roster.cca, via: scope.via, entries: directory };
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
  /**
   * The CCA's heads WITH resolved names, for the admin heads manager.
   *
   * admin.listCcaHeads returns raw CcaHead rows — just the canonical userID — so
   * a manager sees "E1714044", not a person. This resolves each head's name the
   * same way the roster does (there is no reverse canonical→User query, so guess
   * the email and also match the stored key), while still returning the
   * authoritative CcaHead.userID that Remove needs.
   *
   * Guarded by assertMayViewCcaRoster, so it works for a manager
   * (manageCcaHeads) on any CCA, for a head on their own, and — through branch 3
   * of that guard, behind the `scrc.enabled` switch — for the hall office
   * read-only. It is the roster's other half: who leads this CCA is exactly the
   * question the hall office asks.
   *
   * THE ANSWER IS NOT THE SAME FOR ALL THREE. A manager or a head gets name,
   * EMAIL and grant date — unchanged, and identical to what /admin/ccas has
   * always shown. The read-only tier gets name and grant date with the email
   * NULLED, because 89 CCAs' worth of head addresses is a contact list, and
   * building one out of a read-only capability is the disclosure requirement 8
   * withholds. Matric, telegram and bio are absent for everyone here — those
   * live in memberDirectory, which stays on assertHeadsCca.
   *
   * NOT a licence to write: Remove-head still goes through admin.setCcaHeads /
   * cca.handoverHeads, both of which re-guard with assertHeadsCca.
   */
  listHeads: identifiedProcedure
    .input(z.object({ ccaID: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertMayViewCcaRoster(
        ctx.db,
        { userID, roles },
        input.ccaID,
      );
      // Same rule as getRoster: the read-only tier gets NAMES, not addresses.
      // 89 CCAs x their heads is a contact list, and assembling one is exactly
      // what `viewCcaRostersReadOnly` promises not to allow.
      const readOnly = scope.via === "readOnly";

      const heads = await ctx.db.ccaHead.findMany({
        where: { ccaID: input.ccaID },
        select: { userID: true, grantedAt: true },
        orderBy: { userID: "asc" },
      });
      if (heads.length === 0) return { heads: [] };

      const keys = heads.map((h) => h.userID);
      const guessedEmails = keys.map((k) => `${k.toLowerCase()}@u.nus.edu`);

      const [byEmail, byStored] = await Promise.all([
        ctx.db.user.findMany({
          where: { email: { in: guessedEmails, mode: "insensitive" } },
          // Never a bare read: passwordHash must not leave the server (I-2).
          select: { email: true, displayName: true, userID: true },
        }),
        ctx.db.user.findMany({
          where: { userID: { in: keys } },
          select: { email: true, displayName: true, userID: true },
        }),
      ]);

      // key → display, canonicalising the email-matched rows and dropping nulls
      // so a non-NUS row can't land under a "" key (the listUsers guard).
      const byKey = new Map<string, { displayName: string | null; email: string | null }>();
      for (const u of byEmail) {
        const cid = canonicalUserID(u.email);
        if (cid) byKey.set(cid, { displayName: u.displayName, email: u.email });
      }
      for (const u of byStored) {
        if (u.userID && !byKey.has(u.userID)) {
          byKey.set(u.userID, { displayName: u.displayName, email: u.email });
        }
      }

      return {
        heads: heads.map((h) => ({
          // NULLED FOR THE READ-ONLY TIER TOO, and the earlier defence for
          // keeping it ("it is the row's own primary key") was simply wrong.
          // `CcaHead.userID` is a canonical E-format id, and this very
          // procedure derives the address from it four lines up:
          // `E1234567` -> `e1234567@u.nus.edu`. Returning the id while nulling
          // the email hands back the same contact list one derivation later, so
          // a loop over listAllForOversight -> listHeads would still reassemble
          // name + email for every head in the hall. It also contradicted
          // redactRosterForReadOnly, which nulls `storedUserID` for exactly
          // this reason — two paths, one rule.
          //
          // Nothing renders this for the read-only tier (the only caller is
          // /admin/ccas' CcaHeadsManager, which is manager-gated), so nulling
          // costs no UI. A manager or head is unaffected.
          userID: readOnly ? null : h.userID,
          displayName: byKey.get(h.userID)?.displayName ?? null,
          email: readOnly ? null : (byKey.get(h.userID)?.email ?? null),
          grantedAt: h.grantedAt,
        })),
      };
    }),

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

  /* --------------------------- OVERSIGHT (read-only) ---------------------- */

  /**
   * Every CCA's NAME, for the hall office's CCA picker. A name list and nothing
   * else — no heads, no members, no counts.
   *
   * WHY A NEW PROCEDURE. The two existing "all the CCAs" lists are both out of
   * reach and both for good reasons: admin.listCcas requires manageCcaHeads
   * (admin.ts) — the capability that makes assertHeadsCca pass unconditionally,
   * i.e. full write on all 89 CCAs — and ccaApplications.browse sits behind a
   * DIFFERENT kill switch (`cca.applications.enabled`), so the CCA picker would
   * go dark whenever applications are off. Neither is a usable CCA list for the
   * hall office, and widening either would cost far more than it buys. The
   * projection is deliberately IDENTICAL to admin.listCcas' so the two cannot
   * drift into disagreeing about what a "CCA list" is.
   *
   * WHY oversightProcedure AND NOT identifiedProcedure, which every other
   * procedure in this file uses. Those are object-scoped: the client names a
   * ccaID and the guard is the entire boundary, so the builder answers nothing.
   * This one takes NO input — there is no object to scope to — so the role gate
   * IS the boundary and a role-gated builder is the honest way to say so.
   *
   * This list is NOT an authorization. It grants no read of any roster: every
   * ccaID the picker hands back is authorised again, per-CCA, by
   * assertMayViewCcaRoster inside getRoster / listHeads. A leaked name buys an
   * attacker a number that is already public in the booking UI.
   */
  listAllForOversight: oversightProcedure.query(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    // I-5: LIVE read. session.user.roles is render-only and up to 30 days stale,
    // so a demoted hall-office member would otherwise keep the picker.
    const roles = await getUserRoles(ctx.db, userID);
    const capabilities = computeCapabilities(roles);
    if (!capabilities.viewCcaRostersReadOnly) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "CAPABILITY_REQUIRED:viewCcaRostersReadOnly",
      });
    }

    // The switch is checked HERE rather than left to assertMayViewCcaRoster,
    // because nothing below calls that guard — but on the SAME branch that
    // guard puts it on, and not unconditionally as it was at first. An ADMIN
    // holds reachScrcDashboard, so an admin can open /scrc before rollout; an
    // unconditional check made every panel error for the one person entitled to
    // inspect the surface before switching it on. `manageCcaHeads` is the
    // manager tier here, i.e. exactly the callers who reach a roster through
    // branch 1 of assertMayViewCcaRoster and never touch the flag.
    if (!capabilities.manageCcaHeads) await assertScrcEnabled(ctx.db);

    return {
      ccas: await ctx.db.cCA.findMany({
        select: { ccaID: true, ccaName: true, category: true },
        orderBy: { ccaName: "asc" },
      }),
    };
  }),
});
