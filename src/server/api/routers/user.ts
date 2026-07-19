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
import type { PrismaClient } from "@prisma/client";
import { getUserRoles } from "../services/access";

// Matric number: "A" + 7 digits + an uppercase letter, e.g. A0234567X. The
// regex itself now lives in ~/lib/schemas/profile beside the other shared
// validators, because the completion form needs the runtime VALUE and a
// `"use client"` component must not value-import from the server tree. Aliased
// rather than renamed at the call sites so this file reads as it did.
const MATRIC_REGEX = MATRIC_RE;

/* -------------------------------------------------------------------------- */
/* D-5: how a cleared optional String is persisted                             */
/* -------------------------------------------------------------------------- */

/**
 * OPEN QUESTION — the user must run the step-0 $jsonSchema dump before this is
 * settled. The `User` collection is $jsonSchema-guarded, and `String?` in the
 * Prisma schema means "optional/absent", NOT "null-accepting": Prisma infers
 * nullability from a missing key, not from the validator. No existing write path
 * has ever produced a null here (register/route.ts writes concrete values after
 * a presence check; the old updateUserData always wrote strings), so the
 * validator may well declare `bsonType: "string"` and reject the first
 * "clear my handle" save at the database.
 *
 * Until the dump is read, clearing is routed through this ONE helper so the
 * answer is a one-line flip rather than a hunt:
 *
 *   Branch A — bsonType is an array including "null"  ->  CLEAR_MODE = "null"
 *   Branch B — bsonType excludes null (bare "string") ->  CLEAR_MODE = "unset"
 *   Branch C — the field is in the validator's `required` array -> it cannot be
 *              cleared at all; make it required in updateProfileInput with
 *              `.refine((v) => v !== "")` and drop the clear affordance from the
 *              modal, rather than shipping a UI control that always errors.
 *
 * "unset" is the SAFE-UNDER-BOTH default and is why it is selected here: Prisma
 * Mongo's `{ unset: true }` removes the key, which every branch-A validator also
 * accepts (an optional field is satisfied by absence), whereas writing `null`
 * under branch B is rejected. Reads are identical either way — an absent key
 * deserialises as `null` — so no client code depends on this choice.
 *
 * If the dump comes back branch A and you prefer a literal null on disk, flip
 * the constant. If it comes back branch C, take the branch-C action above; this
 * helper cannot save you there, because the write itself is illegal.
 *
 * scripts/remediation/normalize-telegram-handles.mjs makes the SAME decision and
 * must be flipped in the same commit ($unset vs $set: null).
 */
const CLEAR_MODE: "null" | "unset" = "unset";

type ClearableString = string | null | { unset: true };

/** "" from the shared schema means "clear it"; anything else is a literal set. */
function clearable(value: string): ClearableString {
  if (value !== "") return value;
  return CLEAR_MODE === "unset" ? { unset: true } : null;
}

/* -------------------------------------------------------------------------- */
/* THE matric writer                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The ONE path that writes UserMatric. `setMatric` (the matric onboarding page)
 * and `completeProfile` (the post-merge form) both go through here, so there is
 * exactly one place that decides how a matric is keyed and persisted.
 *
 * Extracted rather than copied: a second upsert would be a second chance to key
 * it on `session.user.id` (the Mongo _id) instead of the canonical `userID`,
 * which is the mis-keying that produced the duplicate rows this whole feature
 * exists to clean up after. The `userID` parameter is typed non-null, so the
 * ""-key hazard (I-8d) cannot reach this function without a caller's guard
 * having run first — callers guard, this function assumes.
 */
async function writeMatric(
  db: PrismaClient,
  userID: string,
  matric: string,
): Promise<string> {
  const record = await db.userMatric.upsert({
    where: { userID },
    create: { userID, matric },
    update: { matric },
  });
  return record.matric;
}

/**
 * Refuse a matric that a DIFFERENT canonical userID already holds.
 *
 * Why this is a check and not a `@unique` index: `UserMatric.matric` is
 * deliberately non-unique in schema.prisma because the legacy data ALREADY
 * contains duplicate matrics, and bulk resolution needs to READ those rows and
 * report them as AMBIGUOUS rather than have the database refuse to hold them.
 * Adding a unique index would break that remediation path (and could not be
 * created against the live collection anyway while the duplicates exist).
 *
 * But "we must be able to read pre-existing duplicates" is not "a user may
 * newly claim someone else's number". Matric is an identity key in the bulk
 * import: if two accounts hold one matric, an import row can resolve to the
 * wrong person, which is an impersonation primitive, not a display bug. So the
 * WRITE path refuses new collisions while the SCHEMA stays permissive enough to
 * represent the old ones.
 *
 * This is a read-then-write check and is therefore TOCTOU-racy in principle;
 * two users would have to submit the same matric within the same few
 * milliseconds to slip through, and the result is the pre-existing AMBIGUOUS
 * state that bulk resolution already handles rather than a new failure mode.
 *
 * Applied in `setMatric` (self-service) only. `completeProfile` resolves a
 * post-merge flag against a matric the merge itself derived, and hard-failing
 * there would strand a user in a form they cannot clear.
 */
async function assertMatricUnclaimed(
  db: PrismaClient,
  userID: string,
  matric: string,
): Promise<void> {
  const claimedByAnother = await db.userMatric.findFirst({
    where: { matric, userID: { not: userID } },
    select: { id: true },
  });

  if (claimedByAnother) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "That matriculation number is already registered to another account. If you think that is wrong, contact the JCRC.",
    });
  }
}

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

      const updatedUser = await ctx.db.user.update({
        where: { id: userId },
        data: {
          displayName: input.displayName,
          bio: input.bio,
          // "" clears. See the D-5 note on `clearable` above — this is the ONE
          // place the branch-A/B decision is encoded.
          telegramHandle: clearable(input.telegramHandle),
          block: input.block,
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
