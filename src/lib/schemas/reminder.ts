import { z } from "zod";

import { isRealDayKey } from "~/lib/schemas/disposable";

/**
 * Shared broadcast validation. Under `src/lib/` and server-import-free so the
 * form runs the same `safeParse` as the procedure.
 */

export const REMINDER_TITLE_MAX = 120;
export const REMINDER_MESSAGE_MAX = 1000;
/** Most CCAs one broadcast may address. */
export const REMINDER_TARGET_CAP = 50;

/** Drop control and zero-width characters, but keep line breaks and tabs. */
const clean = (s: string) =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .trim();
const text = (max: number) => z.string().max(max).transform(clean);

const broadcastID = z.string().regex(/^[a-f\d]{24}$/i);

export const reminderCreateInput = z.object({
  /** CCAs to address. Only what to CHECK: the sender is never taken from here. */
  ccaIDs: z
    .array(z.number().int().positive())
    .min(1)
    .max(REMINDER_TARGET_CAP)
    .transform((ids) => [...new Set(ids)]),
  title: text(REMINDER_TITLE_MAX).pipe(z.string().min(1)),
  message: text(REMINDER_MESSAGE_MAX),
  deadline: z.string().refine(isRealDayKey, { message: "Use a real date" }),
});

export const reminderIdInput = z.object({ id: broadcastID });

export const reminderMarkDoneInput = z.object({
  broadcastID,
  ccaID: z.number().int().positive(),
});

export type ReminderCreateInput = z.infer<typeof reminderCreateInput>;
