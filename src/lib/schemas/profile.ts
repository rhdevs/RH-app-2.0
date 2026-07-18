import { z } from "zod";

/**
 * Shared profile-edit validation. Deliberately NOT under `src/server/`: the
 * client mirrors this validation with a real `safeParse`, so it needs the
 * runtime VALUE, and a `"use client"` component value-importing from the server
 * tree risks pulling Prisma into the browser bundle (and breaks outright if a
 * `server-only` guard is ever added). `src/lib/` already holds password.ts,
 * rateLimit.ts, email.ts and utils.ts — this follows that convention.
 */

export const BLOCKS = [2, 3, 4, 5, 6, 7, 8] as const;

/** Telegram's own rule for usernames. */
export const TELEGRAM_RE = /^[A-Za-z0-9_]{5,32}$/;

export const BIO_MAX = 500;
export const DISPLAY_NAME_MAX = 60;

/**
 * Strip control characters and zero-width / bidi-override codepoints.
 * displayName is rendered to OTHER users on every booking listing, so an
 * unfiltered value allows impersonation via homoglyphs, invisible padding, or a
 * right-to-left override. React escaping prevents XSS, not impersonation.
 */
export const sanitizeName = (s: string) =>
  s
    // \p{Cc} = C0/C1 controls and DEL. \p{Cf} = format characters, which is
    // exactly the zero-width and bidi set: ZWSP/ZWNJ/ZWJ (U+200B-200D), LRM/RLM
    // (U+200E-200F), the bidi embeddings and overrides (U+202A-202E), the bidi
    // isolates (U+2066-2069) and the BOM (U+FEFF). Named classes rather than a
    // hand-written codepoint range so the set cannot silently rot.
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * SECURITY: this schema must NEVER gain a `roles`, `role`, `userID`, `email` or
 * `matric` key. The mutation targets `ctx.session.user.id` and zod strips
 * unknown keys, so the only way a user escalates through the profile save is if
 * someone ADDS such a key here. Role mutation lives behind the admin router's
 * G1..G7 guards; matric is set once via `user.setMatric`.
 */
export const updateProfileInput = z.object({
  // NOT .min(1): pre-existing rows (created by the NextAuth Google adapter) may
  // have no displayName, and requiring one would block those users from editing
  // anything else on the page.
  displayName: z.string().max(DISPLAY_NAME_MAX).transform(sanitizeName),

  bio: z
    .string()
    .trim()
    .max(BIO_MAX, `Bio must be ${BIO_MAX} characters or fewer`),

  // Stored WITHOUT the leading "@" so there is exactly one canonical form; the
  // UI renders "@{handle}". "" means "clear it" — see the D-5 helper in
  // src/server/api/routers/user.ts for how that is persisted.
  //
  // Uniqueness is deliberately NOT enforced in v1: a findFirst check is
  // TOCTOU-racy, and its CONFLICT message is an existence oracle letting any
  // authenticated user enumerate which handles belong to residents — which
  // partly undoes the restriction in facilitiesBooking.ts that keeps handles
  // private to their owner. It would also lock out legacy duplicate holders.
  telegramHandle: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@+/, ""))
    .refine((v) => v === "" || TELEGRAM_RE.test(v), {
      message: "Telegram handle must be 5–32 characters: letters, digits or _",
    }),

  // Required, matching signup, which mandates it. The page must initialise the
  // select to UNSET rather than defaulting to a block the user never chose —
  // the old `user?.block ?? 8` pre-selected Block 8 and let it be saved by
  // accident. Nullability is not the fix; an unset control is.
  block: z
    .number()
    .int()
    .refine((n) => (BLOCKS as readonly number[]).includes(n), "Invalid block"),
});

export type UpdateProfileInput = z.input<typeof updateProfileInput>;
