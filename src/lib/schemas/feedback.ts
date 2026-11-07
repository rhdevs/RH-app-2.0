import { z } from "zod";

/**
 * Shared feedback validation. Under `src/lib/` and server-import-free so the
 * form can run the same `safeParse` as the procedure (see schemas/profile.ts).
 */

export const FEEDBACK_CATEGORIES = ["bug", "suggestion", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_MESSAGE_MAX = 2000;

/** Drop control and zero-width characters, but keep line breaks and tabs. */
const cleanMessage = (s: string) =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .trim();

export const feedbackSubmitInput = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  message: z
    .string()
    .max(FEEDBACK_MESSAGE_MAX)
    .transform(cleanMessage)
    .pipe(z.string().min(1)),
});
