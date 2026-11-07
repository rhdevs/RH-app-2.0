import { z } from "zod";

import { DISPOSABLE_STATUSES } from "~/lib/disposables/status";

/**
 * Shared disposable-request validation. Under `src/lib/` and server-import-free
 * so the form runs the same `safeParse` as the procedure (see
 * schemas/proposal.ts).
 */

export const DISPOSABLE_ITEMS = [
  "plates",
  "cups",
  "bowls",
  "forks",
  "spoons",
] as const;
export type DisposableItem = (typeof DISPOSABLE_ITEMS)[number];

/** Per item (Q22's default). */
export const DISPOSABLE_ITEM_CAP = 500;
export const DISPOSABLE_TITLE_MAX = 120;
export const DISPOSABLE_DESCRIPTION_MAX = 1000;
export const DISPOSABLE_NOTE_MAX = 500;

/** Drop control and zero-width characters, but keep line breaks and tabs. */
const clean = (s: string) =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .trim();
const text = (max: number) => z.string().max(max).transform(clean);

const quantity = z.number().int().min(0).max(DISPOSABLE_ITEM_CAP);

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar date written "YYYY-MM-DD" (so not 2026-02-30). */
export function isRealDayKey(s: string): boolean {
  const m = DAY.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** A Singapore date key is earlier than today's. Both are "YYYY-MM-DD". */
export const isPastDay = (day: string, todayKey: string) => day < todayKey;

export const totalItems = (q: Record<DisposableItem, number>) =>
  DISPOSABLE_ITEMS.reduce((sum, item) => sum + q[item], 0);

const AT_LEAST_ONE = { message: "Ask for at least one item" };
const hasAnItem = (q: Record<DisposableItem, number>) => totalItems(q) >= 1;

const proposalID = z.string().regex(/^[a-f\d]{24}$/i);
/** `Event.eventID`: a positive whole number (not the row's ObjectId). */
const eventID = z.number().int().positive();
const requestID = z.string().regex(/^[a-f\d]{24}$/i);
const dayField = z
  .string()
  .refine(isRealDayKey, { message: "Use a real date" });
const timeField = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "Use a time like 14:30" });

/**
 * What a request says about itself. The tag (event or proposal) is NOT here:
 * it is chosen once, when the request is filed, and cannot be changed by an
 * edit (to retag, delete the request and file it again).
 */
const content = {
  title: text(DISPOSABLE_TITLE_MAX).pipe(z.string().min(1)),
  description: text(DISPOSABLE_DESCRIPTION_MAX),
  plates: quantity,
  cups: quantity,
  bowls: quantity,
  forks: quantity,
  spoons: quantity,
  collectionDay: dayField,
  collectionTime: timeField,
};

export const NEEDS_A_TAG = {
  message: "Choose the event this is for, or a proposal",
};
const hasATag = (v: { eventID: number | null; proposalID: string | null }) =>
  v.eventID !== null || v.proposalID !== null;

/**
 * Filing needs an event, or a proposal that has no event yet. There is NO ccaID
 * here: the CCA comes from the event (or the proposal), never from the browser.
 */
export const disposableCreateInput = z
  .object({
    eventID: eventID.nullable().default(null),
    proposalID: proposalID.nullable().default(null),
    ...content,
    description: content.description.default(""),
  })
  .refine(hasAnItem, AT_LEAST_ONE)
  .refine(hasATag, NEEDS_A_TAG);

/** An edit sends the whole form again; `version` is the one the editor loaded. */
export const disposableUpdateInput = z
  .object({
    id: requestID,
    version: z.number().int().min(0),
    ...content,
    description: content.description.default(""),
  })
  .refine(hasAnItem, AT_LEAST_ONE);

export const disposableIdInput = z.object({ id: requestID });
export const disposableDeleteInput = disposableIdInput;

const note = text(DISPOSABLE_NOTE_MAX)
  .transform((s) => (s === "" ? null : s))
  .nullable()
  .default(null);

export const disposableDecideInput = z.object({
  id: requestID,
  version: z.number().int().min(0),
  note,
});

export const disposableListInput = z
  .object({
    status: z.enum(DISPOSABLE_STATUSES).optional(),
    ccaID: z.number().int().positive().optional(),
    /** Only requests for hall-wide events (they have no CCA). */
    hallWide: z.literal(true).optional(),
    eventID: eventID.optional(),
    /** Inclusive Singapore date keys. */
    from: dayField.optional(),
    to: dayField.optional(),
  })
  .refine((v) => v.ccaID === undefined || v.hallWide === undefined, {
    message: "Choose a CCA or hall-wide, not both",
  })
  .default({});

export const disposableCanFileInput = z.object({ eventID });

export type DisposableCreateInput = z.infer<typeof disposableCreateInput>;
export type DisposableUpdateInput = z.infer<typeof disposableUpdateInput>;
export type DisposableDecideInput = z.infer<typeof disposableDecideInput>;
export type DisposableListInput = z.infer<typeof disposableListInput>;
