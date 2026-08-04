import { z } from "zod";

import {
  BIO_MAX,
  BLOCKS,
  DISPLAY_NAME_MAX,
  MATRIC_RE,
  TELEGRAM_RE,
  sanitizeName,
} from "~/lib/schemas/profile";
import { isDisplayNameValid } from "~/lib/profileCompleteness";

/**
 * Client-side support for the /admin/users detail dialogs (UserDetailDialog and
 * DeleteUserDialog). Shared between the two because they surface ONE router's
 * error vocabulary; two copies of an error map is how the delete dialog starts
 * rendering "That didn't save" for a message the edit dialog explains properly.
 *
 * Deliberately NOT merged with ManageCcaDetail.tsx's own `friendlyError`: that
 * one maps ccaAdmin's vocabulary, which shares only two strings with this one.
 * A single map over both routers would grow entries neither surface can produce.
 */

/* ========================================================================== */
/* The form schema — a MIRROR of updateSchema in routers/userAdmin.ts          */
/* ========================================================================== */

/**
 * WHY THIS IS A MIRROR AND NOT AN IMPORT.
 *
 * `updateSchema` lives inside `src/server/api/routers/userAdmin.ts`, which is
 * not exported and could not be value-imported into a `"use client"` file
 * anyway — it pulls the whole router, Prisma and @trpc/server into the browser
 * bundle. That is precisely why the field VALIDATORS live in
 * src/lib/schemas/profile.ts: every rule below is imported from there, so the
 * two schemas cannot drift on what a valid telegram handle or matric IS. What
 * is restated here is only the SHAPE — which fields are required, and which one
 * may be blank.
 *
 * THE SERVER IS THE AUTHORITY. This schema exists so the operator sees a field
 * error under the field instead of a raw rejection after a round trip; it is
 * not a control. `updateSchema` is `.strict()` and re-validates everything.
 *
 * STRICTER THAN `updateProfileInput` IN EXACTLY ONE DIRECTION, mirroring the
 * server: displayName may not be empty and telegramHandle has no `""` escape
 * hatch, because the strict profile-completion gate is ALWAYS ON. An admin who
 * saves a blank gate field walls that resident behind the completion dialog
 * with no way to see who did it. AN ADMIN EDIT MAY CLOSE A PROFILE GAP; IT MAY
 * NEVER OPEN ONE. Only `bio` is clearable — bio is not a gate field.
 *
 * EVERY FIELD IS `.optional()`, matching the server, and that is what makes
 * PARTIAL REPAIR possible rather than what weakens the rule. `undefined` means
 * "leave the stored value alone"; a value that is PRESENT must satisfy its
 * validator outright, so the only thing a gate field can be moved TO is a valid
 * value. UserDetailDialog omits every field the operator did not change — so an
 * operator who knows a gated resident's block but not their Telegram handle can
 * record the block instead of being blocked by the very field they came to
 * supply, and a save that touched one field cannot carry a stale copy of the
 * others back over somebody else's newer edit.
 */
export const adminProfileFormSchema = z.object({
  displayName: z
    .string()
    .min(1, "Enter a display name.")
    .max(DISPLAY_NAME_MAX, `Keep it to ${DISPLAY_NAME_MAX} characters or fewer`)
    .transform(sanitizeName)
    // The same rule the resident's own save applies on EVERY submit, asserted
    // AFTER sanitizeName so a name made entirely of zero-width characters is
    // caught here rather than saved as "". Message is byte-identical to the
    // server's (routers/userAdmin.ts) and to EditProfileModal's — one rule, one
    // wording, wherever the operator meets it.
    .refine(isDisplayNameValid, "Enter your real name — not your NUSNET ID.")
    .optional(),

  // `.optional()` like the gate fields, and for the same reason: omitted means
  // "leave the stored value alone". Bio is additionally the ONE field where a
  // present "" is a real instruction (clear it) rather than a validation error,
  // because bio is not a gate field — so `undefined` and `""` are genuinely
  // different messages here and the dialog must not conflate them.
  bio: z
    .string()
    .trim()
    .max(BIO_MAX, `Bio must be ${BIO_MAX} characters or fewer`)
    .optional(),

  telegramHandle: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@+/, ""))
    .refine((v) => TELEGRAM_RE.test(v), {
      message: "Telegram handle must be 5–32 characters: letters, digits or _",
    })
    .optional(),

  // BLOCKS is 2..8. The form holds `number | ""` and never reaches here with ""
  // (see UserDetailDialog) — an unset select is a distinct state from an
  // invalid one and deserves its own message.
  block: z
    .number()
    .int()
    .refine((n) => (BLOCKS as readonly number[]).includes(n), "Pick a block.")
    .optional(),

  // `undefined` means "leave the UserMatric row alone". There is deliberately
  // no value that means "clear it": matric is a gate field, and the server has
  // no clearing branch either.
  matric: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => MATRIC_RE.test(v), {
      message:
        "Matric must be in the format A0234567X (A + 7 digits + a letter).",
    })
    .optional(),
});

export type AdminProfileFormValues = z.output<typeof adminProfileFormSchema>;

/**
 * Flatten zod issues into one message per field, first-wins.
 *
 * First-wins rather than joined: two messages stacked under one input is noise,
 * and the operator fixes them one at a time anyway.
 */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !out[key]) out[key] = issue.message;
  }
  return out;
}

/* ========================================================================== */
/* Error copy                                                                 */
/* ========================================================================== */

/**
 * A tRPC client error, structurally. Typed loosely on purpose so both a
 * mutation's and a query's error object satisfy it without importing
 * TRPCClientErrorLike<AppRouter> and dragging the router type in here.
 */
export type ClientErrorLike =
  | { message?: string | null; data?: { code?: string } | null }
  | null
  | undefined;

/**
 * Server messages this surface can produce, mapped to operator copy.
 *
 * The matric duplicate is mapped by CODE (CONFLICT) rather than by text: the
 * server's prose is written for the resident editing their own profile
 * (services/profile.ts) and must not be re-worded there just to read well here.
 *
 * Anything unmapped falls through to a generic line. That is deliberate — an
 * unmapped message may be a zod issue array serialised as JSON, and dumping it
 * into the dialog is worse than saying nothing useful.
 */
const MESSAGE_COPY: Record<string, string> = {
  // "open or edit", not "edit": G3 is applied on `userAdmin.get` as well as on
  // the writes, so this string is what a jcrc sees when the DIALOG LOADS, before
  // any form is shown.
  CANNOT_MODIFY_AN_ADMIN: "You can't open or edit an admin's details.",
  // The OTHER G3 denial (services/userAdmin.ts). Deliberately not folded into
  // NO_CANONICAL_IDENTITY below: that one is updateProfile's matric refusal and
  // says the account has no matric record, which would read here as a field
  // problem rather than as "you may not open this at all". Worded so an operator
  // knows the remedy is a person, not a retry.
  CANNOT_MODIFY_AN_UNKEYED_ACCOUNT:
    "This account isn't on an @u.nus.edu address, so it has no NUSNET id and its role record can't be read back — there's no way to check what access it holds. Only an admin can open it.",
  NO_SUCH_USER: "That account no longer exists. Reload the page.",
  NO_CANONICAL_IDENTITY:
    "This account isn't on an @u.nus.edu address, so it has no matric record.",
  USER_DELETE_DISABLED: "Account deletion is turned off.",
  CONFIRM_EMAIL_MISMATCH: "That email doesn't match.",
  // Produced by BOTH dialogs and mapped here rather than falling through to the
  // PRECONDITION_FAILED line below, which says "something changed while you
  // were confirming" — true for the delete's TOCTOU case and wrong for this
  // one, which is a standing state of the data and will not clear on a retry.
  SHARED_CANONICAL_ID:
    "Another account resolves to the same NUSNET id as this one, and matric and post-merge records are filed under that shared id. Ask a developer to run the account merge (scripts/remediation/merge-by-canonical.mjs) first.",
  // Mapped for the SAME reason SHARED_CANONICAL_ID is: it arrives as a
  // PRECONDITION_FAILED, and that code's generic line ("something changed while
  // you were confirming") is wrong here — this is a standing property of the
  // address and no retry will clear it. Normally the operator never reaches it,
  // because the preflight lists it as a refusal and the confirm control is not
  // mounted; this covers the paths that skip the preview.
  ABSENT_CANONICAL_ID:
    "This account has no NUSNET id, so its records can't be located and it can't be deleted safely. Ask a developer to clear it out first.",
  // Passed through verbatim: the server, EditProfileModal and the mirror schema
  // above all use this exact string, and it is already operator-readable.
  "Enter your real name — not your NUSNET ID.":
    "Enter their real name — not their NUSNET ID.",
};

export function friendlyError(err: ClientErrorLike): string | null {
  if (!err) return null;
  const message = err.message ?? "";
  const code = err.data?.code;

  if (MESSAGE_COPY[message]) return MESSAGE_COPY[message]!;

  // The ObjectId shape check in routers/userAdmin.ts is a ZOD refusal, so its
  // message arrives as a serialised issue array rather than as the bare string.
  // Matched by substring so the operator gets "that account no longer exists"
  // — the true statement — instead of the generic retry line, which would send
  // them back at a call that can never resolve.
  if (message.includes("NO_SUCH_USER")) return MESSAGE_COPY.NO_SUCH_USER!;

  // The matric duplicate guard in services/profile.ts. By code, not by text.
  if (code === "CONFLICT")
    return "That matric number is already registered to another account.";

  if (message.startsWith("CAPABILITY_REQUIRED"))
    return "You don't have permission to do that.";

  /**
   * PRECONDITION_FAILED reaching a dialog means the state moved underneath the
   * operator. The delete's refusals are rendered from the preflight and the
   * confirm control is not even mounted while any exist, so a refusal arriving
   * at COMMIT time can only be the TOCTOU case the in-transaction re-checks
   * exist to catch: a co-head revoked, or the target granted admin, in the
   * seconds between the preview and the typed confirmation.
   */
  if (code === "PRECONDITION_FAILED")
    return "Something changed while you were confirming. Reload and check again.";

  return "That didn't save. Try again.";
}

/**
 * May this error be re-attempted, i.e. is a Retry control honest?
 *
 * IT IS NOT MERELY COSMETIC. `userAdmin.get` applies the G3 target guard
 * (assertMayManageUserProfileOf), and that guard AUDITS ITS OWN DENIALS — so a
 * Retry offered against a FORBIDDEN writes one more `denied` RoleAuditLog row,
 * on the highest-signal action this system records, per click, for an operation
 * that can never now succeed. DeleteUserDialog's onError block names the same
 * pattern from the other direction (it re-runs the preflight so the dead confirm
 * button unmounts). Noise on the audit surface is not free: it is the surface an
 * admin reads to find a real probe.
 *
 * The three refusals below are properties of the REQUEST, not of the moment, and
 * this dialog's query input is fixed for its lifetime:
 *   FORBIDDEN   — the capability or the target guard. Needs a different actor.
 *   NOT_FOUND   — no such User row. The copy already says "Reload the page."
 *   BAD_REQUEST — the ObjectId shape refusal (a zod issue, hence the NO_SUCH_USER
 *                 substring match above). The same id will fail identically.
 * Everything else — a network fault, INTERNAL_SERVER_ERROR, TIMEOUT — is the
 * transient class a Retry is FOR, and must keep the button.
 */
const NON_RETRYABLE_CODES = new Set(["FORBIDDEN", "NOT_FOUND", "BAD_REQUEST"]);

export function isRetryable(err: ClientErrorLike): boolean {
  const code = err?.data?.code;
  return !(code && NON_RETRYABLE_CODES.has(code));
}

/* ========================================================================== */
/* Deletion footprint copy                                                    */
/* ========================================================================== */

/**
 * Render order and labels for `getDeletionImpact`'s `counts`.
 *
 * A MIRROR of FOOTPRINT_COLLECTIONS in src/server/api/services/userAdmin.ts,
 * not a value import: that module imports @trpc/server and services/access, so
 * pulling it into a client component drags server code into the browser bundle.
 * services/roles.ts may be imported here (it is runtime-pure, which is why
 * AdminCapabilityContext imports it); services/userAdmin.ts may not.
 *
 * Drift is SAFE IN ONE DIRECTION and that is by design: any key present in
 * `counts` but absent from this list is still rendered, under its raw name, by
 * the fallback in DeleteUserDialog. A collection added to the cascade shows up
 * in the blast radius immediately, ugly but VISIBLE — the same call RoleBadge
 * makes for an unknown role string. Silently omitting it would under-report
 * what a delete destroys, which is the one thing this panel exists to prevent.
 *
 * `order` was here and is gone: the cascade no longer touches the supper domain
 * (see the residue block in services/userAdmin.ts). Listing a collection the
 * cascade does not delete is the same defect as omitting one it does, pointing
 * the other way — and the server no longer emits the key, so the entry would
 * simply have rendered `0` forever.
 */
export const FOOTPRINT_ORDER = [
  "ccaHead",
  "userRole",
  "pendingRoleGrant",
  "userMatric",
  "profileCompletion",
  "eventSignup",
  "ccaInterviewNote",
  "ccaApplication",
  "userCCA",
  "bookings",
  "posts",
  "gym",
] as const;

/** Singular / plural copy. Written for a sentence, not for a schema. */
const FOOTPRINT_LABEL: Record<string, { one: string; many: string }> = {
  ccaHead: { one: "CCA headship", many: "CCA headships" },
  userRole: { one: "role record", many: "role records" },
  pendingRoleGrant: { one: "pending role grant", many: "pending role grants" },
  userMatric: { one: "matric record", many: "matric records" },
  profileCompletion: {
    one: "profile-completion flag",
    many: "profile-completion flags",
  },
  eventSignup: { one: "event signup", many: "event signups" },
  ccaInterviewNote: {
    one: "interview note about them",
    many: "interview notes about them",
  },
  ccaApplication: { one: "CCA application", many: "CCA applications" },
  userCCA: { one: "CCA membership", many: "CCA memberships" },
  bookings: { one: "booking", many: "bookings" },
  posts: { one: "post", many: "posts" },
  gym: { one: "gym record", many: "gym records" },
};

/** `46 bookings`, `1 role record`, or the raw key for a collection added later. */
export function footprintPhrase(key: string, n: number): string {
  const label = FOOTPRINT_LABEL[key];
  if (!label) return `${n} × ${key}`;
  return `${n} ${n === 1 ? label.one : label.many}`;
}

/* ========================================================================== */
/* Refusals                                                                   */
/* ========================================================================== */

/** `SOLE_HEAD_OF_CCA:12` -> 12. null for every other refusal. */
export function soleHeadCcaID(refusal: string): number | null {
  const prefix = "SOLE_HEAD_OF_CCA:";
  if (!refusal.startsWith(prefix)) return null;
  const id = Number(refusal.slice(prefix.length));
  return Number.isFinite(id) ? id : null;
}

/**
 * Why the delete is refused, and — more importantly — what the operator does
 * next. Every one of these is a deliberate refusal with a documented remedy;
 * copy that only said "not allowed" would read as the feature being broken,
 * which matters most for LEGACY_KEY_MISMATCH because that population is exactly
 * the messy duplicate an admin most wants to clean up.
 *
 * `ccaName` resolves SOLE_HEAD_OF_CCA's id; it may be absent (the CCA list is
 * a separate query and may still be loading), in which case the id is shown.
 */
export function refusalCopy(
  refusal: string,
  ccaName: (ccaID: number) => string | null,
): string {
  const ccaID = soleHeadCcaID(refusal);
  if (ccaID !== null) {
    const name = ccaName(ccaID) ?? `CCA #${ccaID}`;
    return `They are the only head of ${name}. Hand that CCA over to someone else first — a CCA with no head can't be recovered from the app.`;
  }
  switch (refusal) {
    case "CANNOT_DELETE_SELF":
      return "You can't delete your own account.";
    // NOT the same string as NO_CANONICAL_IDENTITY in MESSAGE_COPY above, and
    // deliberately so: that one is updateProfile's matric refusal, and this map
    // and that one are both consumed by the delete dialog.
    case "ABSENT_CANONICAL_ID":
      return "This account isn't on an @u.nus.edu address, so it has no NUSNET id and its records can't be located. Deleting it would remove the account and leave anything it owns — bookings that still hold a room, posts — behind with no owner. Ask a developer to clear it out first (scripts/remediation/rbac-doctor.mjs --nonnus lists what it owns).";
    case "CANNOT_DELETE_AN_ADMIN":
      return "This account holds the admin role. Remove that role from Manage roles first — deleting an admin directly could leave the hall with no administrator, and there is no way to create the first one from inside the app.";
    case "LEGACY_KEY_MISMATCH":
      return "This account's stored ID doesn't match its email, so its records can't be attributed safely. This is the split-account case — ask a developer to run a merge script instead.";
    case "SHARED_CANONICAL_ID":
      return "Another account resolves to the same NUSNET id as this one (usually a stray space or a different capitalisation in the email). Deleting either one would take the other's roles, bookings and matric with it, because those records are filed under the shared id. Ask a developer to run the account merge (scripts/remediation/merge-by-canonical.mjs) first.";
    default:
      // Same call as the unknown-collection fallback above: an unmapped refusal
      // must still BLOCK and still be visible, never silently disappear and let
      // the confirm control render.
      return `This account can't be deleted (${refusal}).`;
  }
}
