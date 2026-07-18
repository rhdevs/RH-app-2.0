import { protectedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { updateProfileInput } from "~/lib/schemas/profile";
import { getUserRoles } from "../services/access";

// Matric number: "A" + 7 digits + an uppercase letter, e.g. A0234567X. This is
// the single shared validator used by both the save mutation and the client
// onboarding form so they can never disagree on what is accepted.
const MATRIC_REGEX = /^A\d{7}[A-Z]$/;

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

    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

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
        eligible: false,
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
      eligible: true,
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

      const record = await ctx.db.userMatric.upsert({
        where: { userID },
        create: { userID, matric: input.matric },
        update: { matric: input.matric },
      });

      return { matric: record.matric };
    }),
});
