import { protectedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  updateProfileInput,
  completeProfileInput,
  isProfileCompletionField,
  MATRIC_RE,
  type ProfileCompletionField,
} from "~/lib/schemas/profile";
import { getUserRoles } from "../services/access";
// THE shared profile writers. MOVED out of this file (not copied) when the
// admin user-detail surface gained a profile edit — see the header of
// services/profile.ts for why a second matric writer is the specific hazard.
import {
  assertMatricUnclaimed,
  clearable,
  writeMatric,
} from "../services/profile";
import { isDisplayNameValid } from "~/lib/profileCompleteness";

// Matric number: "A" + 7 digits + an uppercase letter, e.g. A0234567X. The
// regex itself now lives in ~/lib/schemas/profile beside the other shared
// validators, because the completion form needs the runtime VALUE and a
// `"use client"` component must not value-import from the server tree. Aliased
// rather than renamed at the call sites so this file reads as it did.
const MATRIC_REGEX = MATRIC_RE;

/* -------------------------------------------------------------------------- */
/* CCA display types — see the long note on `getMyCCAs` below                  */
/* -------------------------------------------------------------------------- */

/** One CCA as the profile page renders it. `ccaName`/`category` are null only
 *  when no `CCA` row matches the id — real drift, surfaced rather than hidden. */
export type ProfileCCA = {
  ccaID: number;
  ccaName: string | null;
  category: string | null;
  isHead: boolean;
};

/** The shape `user.findRaw` yields under our projection. Untyped BSON: every
 *  field is `unknown` and is narrowed at the use site, never trusted. */
type RawUserCcaDoc = { userCCA?: unknown; userID?: unknown };

/* -------------------------------------------------------------------------- */
/* D-5 / THE matric writer — now in services/profile.ts                        */
/* -------------------------------------------------------------------------- */
/*
 * `clearable` (with the whole D-5 branch-A/B/C note), `writeMatric` and
 * `assertMatricUnclaimed` were MOVED to `../services/profile`, unchanged, when
 * `routers/userAdmin.ts` gained an admin-side profile edit. Nothing about their
 * behaviour changed and the call order below is identical; they live one level
 * down so that BOTH routers share one matric writer and one CLEAR_MODE constant.
 * Do not re-declare a local copy here — read the header of services/profile.ts
 * first if you are tempted.
 */

export const userRouter = createTRPCRouter({
  getCurrentUserData: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const userID = ctx.session.user.userID; // canonical E-format key (I-1)

    const user = await ctx.db.user.findUnique({
      where: { id: userId },
      // Never ship passwordHash to the client (#9). Also I-2: schema.prisma
      // declares passwordHash required while PrismaAdapter-created (Google) rows
      // may lack it, and Prisma 6 on Mongo throws when it reads such a document
      // — an explicit select keeps this path off the field entirely.
      select: {
        id: true,
        userID: true,
        email: true,
        displayName: true,
        telegramHandle: true,
        bio: true,
        block: true,
        createdAt: true,
      },
    });

    if (!user)
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

    // D-7: session.user.userID is derived from the email and is EMPTY for an
    // account that is not on @u.nus.edu. Before D-7 that was an odd edge case;
    // now it means a pre-cutover JWT on an ineligible address. Do not key lookups
    // on it, do not override a real stored id with "", and do not render this as
    // an ordinary zero-roles profile — the page gives it its own state, because
    // an amber "No roles" pill would misdiagnose a policy decision as a data bug.
    if (!userID) {
      return {
        ...user,
        matric: null,
        hasMatric: false,
        roles: [] as string[],
        // D-C: the same field MatricGate branches on, so the gate and this page
        // can no longer disagree about what an empty-identity session is.
        hasIdentity: false,
        // Retained, and identical in value on this branch, so /profile's
      };
    }

    const [matricRow, roles] = await Promise.all([
      ctx.db.userMatric.findUnique({ where: { userID } }),
      // THE shared role read boundary. getUserRoles resolves through
      // normalizeStoredRoles; never re-derive the role set here, because a
      // second derivation is exactly where `resident` gets silently dropped and
      // the badges start disagreeing with the booking path (lockout modes 12-14).
      // Equally: do not read UserRole directly and do not read the legacy `role`
      // scalar — doc 06 enumerates every legacy read that must be deleted, and a
      // new one here becomes an item on that list.
      getUserRoles(ctx.db, userID),
    ]);

    return {
      ...user,
      userID, // session-derived value, not the stale User.userID column (I-1)
      matric: matricRow?.matric ?? null,
      hasMatric: Boolean(matricRow?.matric),
      roles: roles as string[], // DISPLAY ONLY (I-5)
      hasIdentity: true, // D-C — reached only when `userID` is non-empty
    };
  }),

  /**
   * The caller's own CCAs, for display on /profile.
   *
   * A SIBLING QUERY rather than an extension of getCurrentUserData, on purpose:
   *
   *  - getCurrentUserData's `select` is a security control with a comment
   *    explaining why (#9 passwordHash, I-2 Prisma-throws-on-missing-required).
   *    Source A lives in a field that is NOT in the Prisma `User` model at all
   *    (see below), so folding it in would mean either editing
   *    prisma/schema.prisma — a schema change this read-only feature must not
   *    make to a $jsonSchema-guarded collection — or bolting a raw read onto
   *    the one procedure whose whole point is a narrow, auditable typed select.
   *  - This read is four collections wide and is pure decoration. The profile
   *    shell, the identity panel and the error state must not wait on it or
   *    fail with it; a separate query key gives it its own loading state.
   *
   * ============================ THE TWO SOURCES ============================
   * CCA membership is recorded in TWO places and NEITHER is complete. Measured
   * against production over the 116 users with any CCA data at all:
   *
   *     65  both sources agree exactly
   *     37  ONLY in the embedded User.userCCA array
   *      6  ONLY in the UserCCA collection
   *      8  present in both, but the two sets DIFFER
   *
   * So this returns the UNION. Reading either source alone hides real
   * memberships for ~43 people. Reconciling or repairing the two is a separate
   * MIGRATION decision and is deliberately NOT attempted here — this procedure
   * only displays, it never writes, and it never picks a winner.
   *
   * Source A — `User.userCCA`, an embedded Int[] on the caller's own row.
   *   Read with `findRaw` because the field is absent from `model User` in
   *   schema.prisma and `User` carries the $jsonSchema doc comment, so adding
   *   it is not a free change. The projection is explicit and lists exactly two
   *   keys, which means this path structurally cannot reach passwordHash — the
   *   same property the typed select above is buying, obtained the same way.
   *
   * Source B — the `UserCCA` collection, whose `userID` is MIXED-KEY. 07 §0.3
   *   census: 100% A-format matric before the account merge, canonical E-format
   *   only on the rows the merge reassigned. So a lookup by the canonical id
   *   ALONE misses most rows. We match on BOTH the caller's canonical userID
   *   and their stored `User.userID` — which itself holds an A-format matric on
   *   many rows (I-1 / 08 Problem B). Both keys come from the caller's own
   *   session and their own document; neither is client-supplied, so widening
   *   the key set widens no authorization surface.
   *
   * Headships — `CcaHead`, canonical-keyed and reliable (invariant CH-1,
   *   written only by the CCA endpoints). Looked up by the canonical id only;
   *   mixing the legacy key in here would import Source B's ambiguity into the
   *   one collection that does not have it. A head of a CCA they are not a
   *   member of is surfaced as a CCA anyway rather than dropped.
   */
  getMyCCAs: protectedProcedure.query(async ({ ctx }) => {
    const userID = ctx.session.user.userID; // canonical E-format key (I-1)

    // Same guard as getProfileCompletion / getMatricStatus: keyed on the
    // canonical userID being FALSY, never on `session.user.eligible`, which is
    // flag-aware (I-11) and is true with an absent userID whenever the auth
    // kill switch sits at its default "off". Returns the success SHAPE, and
    // does not query — `where: { userID: "" }` would match a ""-keyed row and
    // report a stranger's CCAs as the caller's.
    if (!userID) return { ccas: [] as ProfileCCA[] };

    /* ---- Source A: the embedded array, plus the legacy lookup key ---- */
    const rawDocs = (await ctx.db.user.findRaw({
      filter: { _id: { $oid: ctx.session.user.id } },
      options: { projection: { userCCA: 1, userID: 1, _id: 0 } },
    })) as unknown as RawUserCcaDoc[];

    const doc = Array.isArray(rawDocs) ? rawDocs[0] : undefined;

    // Defensive at every step: this is untyped BSON. A non-array userCCA, or an
    // array holding a string or a float, is legacy data we would rather skip
    // than throw on — a profile page must not 500 because one row is odd.
    const embedded = Array.isArray(doc?.userCCA)
      ? doc.userCCA.filter((v): v is number => Number.isInteger(v))
      : [];

    // The stored column, NOT used as the display identity (I-1 forbids letting
    // it override the session-derived canonical id) — only as a second lookup
    // key for the legacy-keyed rows in Source B.
    const storedUserID =
      typeof doc?.userID === "string" && doc.userID.length > 0
        ? doc.userID
        : null;

    const membershipKeys = [
      ...new Set([userID as string, storedUserID]),
    ].filter((k): k is string => Boolean(k));

    /* ---- Source B + headships ---- */
    const [collectionRows, headRows] = await Promise.all([
      ctx.db.userCCA.findMany({
        where: { userID: { in: membershipKeys } },
        select: { ccaID: true },
      }),
      ctx.db.ccaHead.findMany({
        where: { userID },
        select: { ccaID: true },
      }),
    ]);

    const headIDs = new Set(headRows.map((r) => r.ccaID));

    // THE UNION. Heads are folded in too, so a headship without a matching
    // membership row still surfaces rather than vanishing.
    const ccaIDs = [
      ...new Set([
        ...embedded,
        ...collectionRows.map((r) => r.ccaID),
        ...headIDs,
      ]),
    ];

    if (ccaIDs.length === 0) return { ccas: [] as ProfileCCA[] };

    /* ---- Names ---- */
    const named = await ctx.db.cCA.findMany({
      where: { ccaID: { in: ccaIDs } },
      select: { ccaID: true, ccaName: true, category: true },
    });
    const byID = new Map(named.map((c) => [c.ccaID, c]));

    // A ccaID with no CCA row is REAL DRIFT and is shown as unknown rather than
    // filtered away — hiding it would hide the only evidence it exists. This is
    // the one place a ccaID is allowed to reach the UI.
    const ccas: ProfileCCA[] = ccaIDs.map((ccaID) => {
      const row = byID.get(ccaID);
      return {
        ccaID,
        ccaName: row?.ccaName ?? null,
        category: row?.category ?? null,
        isHead: headIDs.has(ccaID),
      };
    });

    // Sorted server-side so the list does not reshuffle between renders when
    // the union's insertion order changes. Unknowns last.
    ccas.sort(
      (a, b) =>
        (a.category ?? "￿").localeCompare(b.category ?? "￿") ||
        (a.ccaName ?? "￿").localeCompare(b.ccaName ?? "￿"),
    );

    return { ccas };
  }),

  updateUserData: protectedProcedure
    // The shared schema, so the client mirrors this validation exactly. See the
    // SECURITY note there: no roles / role / userID / email / matric key may ever
    // be added. The target row is always ctx.session.user.id and is never
    // client-supplied, so there is no IDOR here; zod strips unknown keys, so the
    // only way a user escalates through this procedure is if someone widens the
    // input schema. Role mutation lives in the admin router behind G1..G7.
    .input(updateProfileInput)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Strict profile gate (server side): a proper display name is enforced on
      // EVERY save, not just the forced completion flow — otherwise a user could
      // "fix" the gate by setting their name back to their NUSNET id and loop.
      // Uses the SAME rule the client mirrors and the session callback gates on.
      //
      // No identity read any more: the rule is a check on the SHAPE of the name
      // (an E-format id), not a comparison against this account's own userID /
      // email / matric. See profileCompleteness.ts — the comparison version was
      // unsatisfiable for name-derived NUSNET ids.
      if (!isDisplayNameValid(input.displayName)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter your real name — not your NUSNET ID.",
        });
      }

      const updatedUser = await ctx.db.user.update({
        where: { id: userId },
        data: {
          displayName: input.displayName,
          bio: input.bio,
          // "" clears. See the D-5 note on `clearable` above — this is the ONE
          // place the branch-A/B decision is encoded.
          telegramHandle: clearable(input.telegramHandle),
          // OMITTED WHEN ABSENT, never written as null. `block` is optional on
          // the shared schema (see the note there): `undefined` means "leave the
          // stored value alone", and there is deliberately no value meaning
          // "clear it". Spreading rather than assigning is what makes that true
          // — `block: input.block` would hand Prisma `undefined`, which is a
          // no-op today but is one refactor away from becoming a null write, and
          // it would read as though omission were a supported way to blank the
          // field. Same posture as `matric` in the admin router.
          //
          // A resident's payload always carries a block (EditProfileModal
          // refuses a blank one before parsing), so this branch is reached ONLY
          // by a profile-gate-exempt account — behaviour for all 1382 residents
          // is byte-identical.
          ...(input.block !== undefined ? { block: input.block } : {}),
        },
        // Mirror the read path's select — a bare update returns the whole row,
        // including passwordHash, straight into the browser and the React Query
        // cache (#9). userID and email are deliberately absent: this result is
        // merged into the cached profile client-side, and User.userID holds an
        // A-format matric on ~515 legacy rows, so returning it would clobber the
        // session-derived canonical id (I-1). Selecting explicitly also keeps
        // this path off passwordHash, which schema.prisma declares required but
        // PrismaAdapter-created (Google) rows may lack — Prisma throws when it
        // reads such a document (I-2). Do not "simplify" this away.
        select: {
          id: true,
          displayName: true,
          telegramHandle: true,
          bio: true,
          block: true,
        },
      });

      return updatedUser;
    }),

  // Read the caller's matric status. Kept at protectedProcedure (NOT
  // matricProcedure) so a still-gated user can render the onboarding page.
  getMatricStatus: protectedProcedure.query(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    // 09 §2.4 (S6): the unguarded twin of the two guarded siblings in this file
    // (getProfile above, setMatric below). An empty canonical userID must not be
    // used as a lookup key — `findUnique({ where: { userID: "" } })` would match
    // a ""-keyed UserMatric row and report a stranger's matric as the caller's.
    // Latent only because no such row exists yet: its producer is
    // merge-accounts.mjs (09 §2.2), an unrun script. A ""-keyed row that cannot
    // exist YET is a latent finding, not a non-finding.
    //
    // Same shape as the success return, so no client branch sees a new field.
    if (!userID) {
      return {
        hasMatric: false,
        matric: null,
      };
    }
    const record = await ctx.db.userMatric.findUnique({ where: { userID } });
    return {
      hasMatric: Boolean(record?.matric),
      matric: record?.matric ?? null,
    };
  }),

  // Save the caller's matric number, clearing the login gate. Keyed on the
  // canonical userID string (session.user.userID) — the same key the session
  // callback and the merge migration use. Stays at protectedProcedure so a
  // gated user is actually able to submit it; otherwise the gate is a dead end.
  setMatric: protectedProcedure
    .input(
      z.object({
        matric: z
          .string()
          .trim()
          .transform((v) => v.toUpperCase())
          .refine((v) => MATRIC_REGEX.test(v), {
            message:
              "Matric must be in the format A0234567X (A + 7 digits + a letter).",
          }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      if (!userID) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No canonical userID on session.",
        });
      }

      // Before writing: refuse a number another account already holds. See the
      // note on the helper for why this is a check rather than a unique index.
      await assertMatricUnclaimed(ctx.db, userID, input.matric);

      return { matric: await writeMatric(ctx.db, userID, input.matric) };
    }),

  /* ------------------------------------------------------------------------ */
  /* Post-merge profile completion                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * What this account still has to re-supply after a duplicate-account merge.
   *
   * protectedProcedure, NOT identifiedProcedure: a flagged user must be able to
   * render the form that clears their own flag, so this may not be a dead end —
   * the same reasoning as `getMatricStatus` above. It guards on `userID` being
   * falsy instead, and NEVER on `session.user.eligible`: `eligible` is
   * flag-aware (I-11) and is TRUE with an empty userID whenever the auth kill
   * switch sits at its default "off", so an eligible-keyed guard here would
   * silently do nothing in the only mode that ships.
   *
   * The empty-identity branch returns the SAME SHAPE as the success branch, so
   * no client branch sees a new field, and it does not query — `findUnique({
   * where: { userID: "" } })` would match a ""-keyed row and report a
   * stranger's outstanding fields as the caller's.
   */
  getProfileCompletion: protectedProcedure.query(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    if (!userID) return { needsFields: [] as ProfileCompletionField[] };

    const row = await ctx.db.profileCompletion.findUnique({
      where: { userID },
    });

    // A resolved row is history, not a live prompt — same rule the session
    // callback applies, so the gate and this page cannot disagree.
    if (!row || row.resolvedAt != null) {
      return { needsFields: [] as ProfileCompletionField[] };
    }

    // Filtered against the closed vocabulary, so an unrecognised entry written
    // by a future script renders as nothing rather than as an unlabelled input.
    return {
      needsFields: row.needsFields.filter(isProfileCompletionField),
    };
  }),

  /**
   * Supply the values the merge could not reconcile.
   *
   * AUTHORIZATION: the row is located by the CALLER'S OWN canonical id, taken
   * from the session and never from the input — there is no id parameter to
   * tamper with, so a user can only ever resolve their own flag. As above, the
   * guard keys off `userID` being falsy and never off `eligible`.
   *
   * The submitted fields are intersected with the STORED `needsFields` before
   * anything is written, so a hand-crafted call cannot use this procedure to
   * set a matric it was never asked for — it would be a second, unguarded
   * matric writer if it did.
   */
  completeProfile: protectedProcedure
    .input(completeProfileInput)
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      if (!userID) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No canonical userID on session.",
        });
      }

      const row = await ctx.db.profileCompletion.findUnique({
        where: { userID },
      });
      if (!row || row.resolvedAt != null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "There is nothing left to confirm on this account.",
        });
      }

      const outstanding = row.needsFields.filter(isProfileCompletionField);
      const resolved: ProfileCompletionField[] = [];

      // Matric goes through writeMatric — THE matric writer — so this path
      // inherits its keying and cannot drift from `setMatric`.
      if (input.matric !== undefined && outstanding.includes("matric")) {
        // Same duplicate guard as setMatric. This path was deliberately exempt
        // at first — hard-failing here can strand someone in a post-merge form
        // they cannot clear — but that reasoning only holds if the form is the
        // ONLY way out, and it is not: the value is rejected, the flag stays
        // outstanding, and the person can correct the number or reach the JCRC.
        // Leaving it exempt meant this path could still mint the exact
        // collision self-service refuses, which is the impersonation primitive
        // the guard exists to close (matric resolves identities in the bulk
        // import). A stranded user is recoverable; a silently duplicated matric
        // is not noticed until it resolves to the wrong person.
        await assertMatricUnclaimed(ctx.db, userID, input.matric);
        await writeMatric(ctx.db, userID, input.matric);
        resolved.push("matric");
      }

      if (
        input.telegramHandle !== undefined &&
        outstanding.includes("telegramHandle")
      ) {
        // Targets ctx.session.user.id, never a client-supplied id — the same
        // rule updateUserData follows. `clearable` is not used: the input
        // schema already refuses "", so this is always a literal set.
        await ctx.db.user.update({
          where: { id: ctx.session.user.id },
          data: { telegramHandle: input.telegramHandle },
          select: { id: true },
        });
        resolved.push("telegramHandle");
      }

      if (resolved.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Nothing to save.",
        });
      }

      // Drop what we just wrote. Filtering the STORED array (rather than
      // writing back the `outstanding` we computed) preserves any entry outside
      // the known vocabulary instead of silently discarding it, so a value this
      // deploy does not understand survives for one that does.
      const remaining = row.needsFields.filter(
        (f) => !(resolved as string[]).includes(f),
      );

      await ctx.db.profileCompletion.update({
        where: { userID },
        data: {
          needsFields: remaining,
          // Stamped only once the list actually empties — a partial save leaves
          // the row live and the user still prompted for the rest. This is also
          // what makes the whole feature inert afterwards: the session callback
          // reads a resolved row as [].
          ...(remaining.length === 0 ? { resolvedAt: new Date() } : {}),
        },
      });

      return { resolved, remaining };
    }),
});
