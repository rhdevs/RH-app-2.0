import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

/**
 * THE shared profile writers.
 *
 * WHY THIS FILE EXISTS. These three functions lived in
 * `src/server/api/routers/user.ts` and were MOVED here — not copied — when the
 * admin user-detail surface (`routers/userAdmin.ts`) gained the ability to edit
 * someone else's profile. `writeMatric`'s own comment already states the rule:
 * a second upsert is a second chance to key a matric on the Mongo `_id` instead
 * of the canonical `userID`, which is the mis-keying that produced the duplicate
 * rows the remediation scripts exist to clean up after. An admin matric writer
 * copied into a second router IS that second chance.
 *
 * `CLEAR_MODE` is here for the same reason from the other direction: it encodes
 * an OPEN branch decision (D-5) whose resolution must remain a one-line flip in
 * exactly one file.
 *
 * SERVER-ONLY BY DESIGN. It imports `@trpc/server` and takes a `PrismaClient`,
 * so — unlike `src/lib/schemas/profile.ts`, which the client value-imports for
 * its mirrored `safeParse` — nothing under `src/app/**` may import this. The
 * split between the two files is that one: VALIDATORS in src/lib (shared with
 * the browser), WRITERS here.
 */

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
 * Both the resident's own edit (user.updateUserData) and the admin edit
 * (userAdmin.updateProfile) route through here, so the branch flip stays a
 * one-line change.
 *
 * scripts/remediation/normalize-telegram-handles.mjs makes the SAME decision and
 * must be flipped in the same commit ($unset vs $set: null).
 */
const CLEAR_MODE: "null" | "unset" = "unset";

type ClearableString = string | null | { unset: true };

/** "" from the shared schema means "clear it"; anything else is a literal set. */
export function clearable(value: string): ClearableString {
  if (value !== "") return value;
  return CLEAR_MODE === "unset" ? { unset: true } : null;
}

/* -------------------------------------------------------------------------- */
/* THE matric writer                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The ONE path that writes UserMatric. `user.setMatric` (the matric onboarding
 * page), `user.completeProfile` (the post-merge form) and
 * `userAdmin.updateProfile` (an admin correcting someone's record) all go
 * through here, so there is exactly one place that decides how a matric is keyed
 * and persisted.
 *
 * Extracted rather than copied: a second upsert would be a second chance to key
 * it on `session.user.id` (the Mongo _id) instead of the canonical `userID`,
 * which is the mis-keying that produced the duplicate rows this whole feature
 * exists to clean up after. The admin path makes that hazard sharper, not
 * softer — there the "obvious" key is the `User.id` the operator clicked, and
 * `User.userID` holds an A-format matric on ~515 rows. The `userID` parameter is
 * typed non-null, so the ""-key hazard (I-8d) cannot reach this function without
 * a caller's guard having run first — callers guard, this function assumes.
 */
export async function writeMatric(
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
 * Applied in `user.setMatric` (self-service), in `user.completeProfile`, and in
 * `userAdmin.updateProfile` (an admin writing on someone's behalf must not be
 * the softer door).
 *
 * The message is deliberately worded for a RESIDENT, because that is who reads
 * it on two of the three paths. The admin UI maps the CONFLICT code to its own
 * copy rather than re-wording the server — do not change this string.
 */
export async function assertMatricUnclaimed(
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
