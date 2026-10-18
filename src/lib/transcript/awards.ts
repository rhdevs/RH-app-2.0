/**
 * AWARDS, as pure rules: how a name is normalised, what counts as a duplicate,
 * how the list is grouped, and how a multi-selection changes. No database.
 */

export const AWARD_NAME_MAX = 80;
export const AWARD_CITATION_MAX = 300;
/** HIDDEN safety caps per request: people in one assign, awards in one bulk action. */
export const MAX_ASSIGN = 2000;
export const MAX_BULK = 2000;

/** Lower-case, trimmed, inner whitespace collapsed: what makes an award name unique. */
export function normalizeAwardName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

/** A blank citation is no citation. */
export const cleanCitation = (c: string | null | undefined): string | null => {
  const t = (c ?? "").trim();
  return t === "" ? null : t;
};

/* ---- duplicates ------------------------------------------------------------ */

export interface ExistingAward {
  userID: string;
  awardTypeID: string | null;
  title: string | null;
}

/**
 * Does `existing` (an ACTIVE award of the same year) already give this person
 * this award? Same catalogue entry, or, for an award with no entry, the same
 * normalised name.
 */
export function isDuplicateAward(
  existing: ExistingAward,
  userID: string,
  type: { id: string; name: string },
): boolean {
  if (existing.userID !== userID) return false;
  if (existing.awardTypeID !== null) return existing.awardTypeID === type.id;
  return (
    normalizeAwardName(existing.title ?? "") === normalizeAwardName(type.name)
  );
}

/**
 * The key that makes an ACTIVE award unique per year, person and award (the
 * catalogue entry, or the normalised title when there is none). A removed award
 * carries `removedAwardKey` instead, which frees this one.
 */
export function awardActiveKey(a: {
  academicYear: string;
  userID: string;
  awardTypeID: string | null;
  title: string | null;
}): string {
  const what = a.awardTypeID ?? `title:${normalizeAwardName(a.title ?? "")}`;
  return `${a.academicYear}|${a.userID}|${what}`;
}

/** The key a removed award is rewritten to, so a new active one can take its place. */
export const removedAwardKey = (activeKey: string, id: string) =>
  `${activeKey}|removed|${id}`;

/** The small tag on an award a manager recorded or edited for themselves. */
export const SELF_RECORDED_TAG = "Self-recorded";

/** Did the resident record, edit or remove this award themself? */
export const isSelfRecorded = (r: {
  userID: string;
  recordedBy?: string | null;
  updatedBy?: string | null;
  voidedBy?: string | null;
}): boolean =>
  r.recordedBy === r.userID ||
  r.updatedBy === r.userID ||
  r.voidedBy === r.userID;

/** An upload still "importing" this long after it began has been cut off. */
export const BATCH_INTERRUPTED_AFTER_MS = 15 * 60 * 1000;

/**
 * The status to show: a batch still "importing" more than 15 minutes after it
 * began is "interrupted" (the server stopped before it could say how it ended).
 */
export function effectiveBatchStatus(
  status: string | null | undefined,
  createdAt: Date | string | null | undefined,
  now: Date,
): string {
  const s = status ?? "complete";
  if (s !== "importing" || !createdAt) return s;
  return now.getTime() - new Date(createdAt).getTime() >
    BATCH_INTERRUPTED_AFTER_MS
    ? "interrupted"
    : s;
}

/** What an upload's status reads as in History. Undo works for all four. */
export function batchStatusLabel(status: string | null | undefined): string {
  if (status === "interrupted") return "Interrupted";
  if (status === "importing") return "Importing";
  if (status === "partial") return "Partly imported";
  return "Imported";
}

export interface Recipient {
  userID: string;
  citation?: string | null;
}

export interface AssignPlan<R extends Recipient> {
  create: R[];
  /** Already have it, or listed twice in the request. */
  skipped: R[];
}

/** Split recipients into the ones to create and the ones to skip, keeping order. */
export function planAssignment<R extends Recipient>(
  existing: readonly ExistingAward[],
  type: { id: string; name: string },
  recipients: readonly R[],
): AssignPlan<R> {
  const create: R[] = [];
  const skipped: R[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    const dup =
      seen.has(r.userID) ||
      existing.some((e) => isDuplicateAward(e, r.userID, type));
    if (dup) skipped.push(r);
    else create.push(r);
    seen.add(r.userID);
  }
  return { create, skipped };
}

/* ---- the awards list --------------------------------------------------------- */

export interface ListedAward {
  id: string;
  title: string;
  awardTypeID: string | null;
  displayName: string | null;
  userID: string;
  removed: boolean;
}

export interface AwardGroup<T extends ListedAward> {
  /** The catalogue entry, or the normalised name for an award with none. */
  key: string;
  title: string;
  /** Recipients who currently have it (not removed). */
  activeCount: number;
  items: T[];
}

const byName = (a: ListedAward, b: ListedAward) =>
  (a.displayName ?? a.userID).localeCompare(b.displayName ?? b.userID, "en", {
    sensitivity: "base",
  });

/** "Group by award": one group per award, by title, with people by name. */
export function groupByAward<T extends ListedAward>(
  awards: readonly T[],
): Array<AwardGroup<T>> {
  const groups = new Map<string, AwardGroup<T>>();
  for (const a of awards) {
    const key = a.awardTypeID ?? `name:${normalizeAwardName(a.title)}`;
    const group = groups.get(key) ?? {
      key,
      title: a.title,
      activeCount: 0,
      items: [],
    };
    group.items.push(a);
    if (!a.removed) group.activeCount += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort(byName) }))
    .sort((a, b) =>
      a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
    );
}

/** "Full Colours: 14 residents". */
export const groupLine = (title: string, count: number) =>
  `${title}: ${count} ${count === 1 ? "resident" : "residents"}`;

/** Case-insensitive match on the award or the recipient's name. */
export function matchesSearch(
  a: { title: string; displayName: string | null; userID: string },
  query: string,
): boolean {
  const q = query.trim().toLocaleLowerCase("en");
  if (q === "") return true;
  return (
    a.title.toLocaleLowerCase("en").includes(q) ||
    (a.displayName ?? a.userID).toLocaleLowerCase("en").includes(q)
  );
}

/* ---- selecting several awards ---------------------------------------------------- */

export type Selection = ReadonlySet<string>;

export const EMPTY_SELECTION: Selection = new Set();

export function toggleSelected(selection: Selection, id: string): Selection {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Select (or, if all are already selected, clear) a set of ids such as one group. */
export function toggleMany(
  selection: Selection,
  ids: readonly string[],
): Selection {
  const all = ids.length > 0 && ids.every((id) => selection.has(id));
  const next = new Set(selection);
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** Keep only ids still in the list (after a reload or a filter). */
export function pruneSelection(
  selection: Selection,
  visibleIds: readonly string[],
): Selection {
  const visible = new Set(visibleIds);
  return new Set([...selection].filter((id) => visible.has(id)));
}

/** The selected awards that can be removed, and the ones that can be restored. */
export function selectionSplit<T extends { id: string; removed: boolean }>(
  selection: Selection,
  awards: readonly T[],
): { removable: string[]; restorable: string[] } {
  const removable: string[] = [];
  const restorable: string[] = [];
  for (const a of awards) {
    if (!selection.has(a.id)) continue;
    (a.removed ? restorable : removable).push(a.id);
  }
  return { removable, restorable };
}

/* ---- wording -------------------------------------------------------------------------- */

const names = (list: readonly string[]) => list.join(", ");

/** "12 assigned. Skipped (already have it): A, B." */
export function assignResultLine(assigned: number, skipped: readonly string[]) {
  const base = `${assigned} assigned.`;
  return skipped.length === 0
    ? base
    : `${base} Skipped (already have it): ${names(skipped)}.`;
}

export const UNDO_BATCH_CONFIRMATION = (count: number) =>
  `This removes the ${count} ${count === 1 ? "award" : "awards"} from this upload. You can restore them one by one later.`;

export const REMOVE_AWARDS_CONFIRMATION = (count: number) =>
  `This takes ${count} ${count === 1 ? "award" : "awards"} off the transcripts. You can restore ${count === 1 ? "it" : "them"} later from Show removed.`;
