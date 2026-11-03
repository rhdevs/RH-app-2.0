import { z } from "zod";

import { LOAN_ID } from "~/lib/equipment/photo";
import { LOAN_STATUSES } from "~/lib/equipment/status";

/**
 * Shared equipment-loan validation. Under `src/lib/` and server-import-free so
 * the forms run the same `safeParse` as the procedures (see schemas/disposable.ts).
 */

export const ITEM_NAME_MAX = 80;
export const ITEM_NOTE_MAX = 300;
/** More than a hall owns of anything; stops a slip of the finger. */
export const ITEM_QUANTITY_MAX = 10_000;
export const LOAN_LINES_MAX = 20;
export const REASON_MAX = 300;
export const DIRECTOR_NOTE_MAX = 500;
/** Epoch seconds: year 2100 is far enough. */
const EPOCH_SECONDS_MAX = 4_102_444_800;

/** Drop control and zero-width characters, but keep line breaks and tabs. */
const clean = (s: string) =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .trim();
const text = (max: number) => z.string().max(max).transform(clean);

const hexID = z
  .string()
  .regex(LOAN_ID)
  .transform((s) => s.toLowerCase());
const eventID = z.number().int().positive();
const version = z.number().int().min(0);
const epochSeconds = z.number().int().positive().max(EPOCH_SECONDS_MAX);

/* ------------------------------ the list -------------------------------- */

const itemContent = {
  name: text(ITEM_NAME_MAX).pipe(z.string().min(1)),
  note: text(ITEM_NOTE_MAX).default(""),
  quantity: z.number().int().min(0).max(ITEM_QUANTITY_MAX),
};

export const itemCreateInput = z.object(itemContent);
export const itemUpdateInput = z.object({
  id: hexID,
  version,
  ...itemContent,
});
export const itemRetireInput = z.object({
  id: hexID,
  version,
  retired: z.boolean(),
});
export const itemDeleteInput = z.object({ id: hexID });

/* ------------------------------- a loan --------------------------------- */

export const loanLineInput = z.object({
  itemID: hexID,
  quantity: z.number().int().min(1).max(ITEM_QUANTITY_MAX),
});

const lines = z
  .array(loanLineInput)
  .min(1, "Choose at least one item")
  .max(LOAN_LINES_MAX)
  .refine(
    (l) => new Set(l.map((x) => x.itemID.toLowerCase())).size === l.length,
    {
      message: "Each item can appear only once",
    },
  );

const window = {
  collectAt: epochSeconds,
  returnAt: epochSeconds,
};
const windowOrder = (v: { collectAt: number; returnAt: number }) =>
  v.returnAt > v.collectAt;
const WINDOW_ORDER = { message: "The return must be after the collection" };

/** There is NO ccaID here: the CCA comes from the event, never the browser. */
export const loanCreateInput = z
  .object({ eventID, lines, ...window })
  .refine(windowOrder, WINDOW_ORDER);

/** The "looks short" preview while the form is open. */
export const loanCheckInput = loanCreateInput;

export const loanIdInput = z.object({ id: hexID });
export const loanActInput = z.object({ id: hexID, version });

export const loanApproveInput = loanActInput.extend({
  directorNote: text(DIRECTOR_NOTE_MAX)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .default(null),
});
export const loanRejectInput = loanActInput.extend({
  reason: text(REASON_MAX).pipe(z.string().min(1, "Say why")),
});
export const loanDirectorCancelInput = loanActInput.extend({
  reason: text(REASON_MAX)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .default(null),
});
/** `url` is the address the photo upload returned; omitted when there is no photo. */
/** A note from the Social director on a loan that has been returned. */
export const loanNoteInput = loanActInput.extend({
  directorNote: text(DIRECTOR_NOTE_MAX).pipe(z.string().min(1, "Write a note")),
});
export const loanReturnInput = loanActInput.extend({
  url: z.string().min(1).max(2048).nullable().default(null),
});

export const loanListInput = z.object({
  status: z.enum(LOAN_STATUSES).nullable().default(null),
  /** A CCA id, "hall" for hall-wide, or null for all. */
  cca: z
    .union([z.number().int().positive(), z.literal("hall")])
    .nullable()
    .default(null),
  overdueOnly: z.boolean().default(false),
});

export const draftInput = z.object({ eventID });
