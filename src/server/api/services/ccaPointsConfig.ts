import type { CcaPointsConfig, Prisma, PrismaClient } from "@prisma/client";

import { DEFAULT_RANGE, type Range } from "~/lib/points/constants";
import {
  fillRange,
  rangeProblem,
  type RangeOverride,
} from "~/lib/points/meanSd";

/**
 * JCRC's points-entry configuration: the allowed mean/SD ranges and the
 * hall-wide open/close switch. CONFIG ONLY — this module (like its router) never
 * sees a score. Leaders enter and check points in their own browser.
 *
 * Two kinds of row in one collection (see `model CcaPointsConfig`):
 *   "default"      hall-wide ranges + `entryOpen`
 *   "cca:<ccaID>"  a per-CCA waiver (blank fields mean "use the default")
 *                  and/or a FLAT-points marking (`flatPoints`, null = not flat)
 *
 * One per-CCA row can therefore be a waiver, a flat marking, or both. Code that
 * lists or deletes waivers must not touch the flat marking, and vice versa — see
 * `waiverRows`, `removeOverride` and `clearFlat`.
 *
 * THE SWITCH IS CLOSED BY DEFAULT. An absent row, or a null `entryOpen`, reads
 * as closed: points entry is a NEW surface, so — like cca.management.enabled and
 * unlike the enforcement switches — "no row" means the surface is inert until
 * JCRC deliberately opens it.
 *
 * Reads are deliberately UNCACHED. The ranges a leader is judged against must be
 * what JCRC last saved, and the volume here is one tiny read per page load.
 */

export const DEFAULT_SCOPE = "default";
export const ccaScope = (ccaID: number): string => `cca:${ccaID}`;

export type RangeField = keyof Range;
const RANGE_FIELDS: readonly RangeField[] = [
  "meanMin",
  "meanMax",
  "sdMin",
  "sdMax",
];

export type ResolvedRange = {
  range: Range;
  /** Fields the per-CCA row overrides (non-blank), in field order. */
  waivedFields: RangeField[];
  isWaived: boolean;
};

/**
 * Per-field fallback: override row -> default row -> built-in DEFAULT_RANGE.
 * Each of the four fields falls back independently, exactly as the sandbox does.
 */
export function resolveRange(
  defaultRow: RangeOverride | null,
  overrideRow: RangeOverride | null,
): ResolvedRange {
  const fromDefault = fillRange(defaultRow ?? {}, DEFAULT_RANGE);
  const range = fillRange(overrideRow ?? {}, fromDefault);
  const waivedFields = RANGE_FIELDS.filter(
    (f) => overrideRow?.[f] !== null && overrideRow?.[f] !== undefined,
  );
  return { range, waivedFields, isWaived: waivedFields.length > 0 };
}

export { rangeProblem };

/** The fields of a per-CCA row that decide what kind of row it is. */
export type ConfigRowLike = RangeOverride & {
  note: string | null;
  flatPoints: number | null;
};

/** Flat when `flatPoints` is a number (0 is a valid flat value). */
export const isFlatRow = (row: ConfigRowLike | null): boolean =>
  row?.flatPoints !== null && row?.flatPoints !== undefined;

/** A real waiver: any range field or a note is set. */
export const hasWaiver = (row: ConfigRowLike | null): boolean =>
  row !== null &&
  (row.note !== null ||
    RANGE_FIELDS.some((f) => row[f] !== null && row[f] !== undefined));

/** Rows that are waivers; a row that only marks a CCA flat is not one. */
export function waiverRows<T extends ConfigRowLike>(rows: readonly T[]): T[] {
  return rows.filter(hasWaiver);
}

export type BrokenWaiver = { ccaID: number; problem: string };

/**
 * Waivers that a NEW default would make impossible. A waiver only sets some
 * fields and the rest follow the default, so changing the default can leave
 * "average 13–12" for a CCA no head could ever meet. Flat CCAs' waivers are
 * checked too (they are kept, and may be used again once the CCA is not flat).
 * `problem` names the broken part(s) in plain words.
 */
export function waiversBrokenByDefault(
  rows: readonly (ConfigRowLike & { ccaID: number | null })[],
  newDefault: Readonly<Range>,
): BrokenWaiver[] {
  const broken: BrokenWaiver[] = [];
  for (const row of waiverRows(rows)) {
    if (row.ccaID === null) continue;
    const r = fillRange(row, newDefault);
    const parts: string[] = [];
    if (r.meanMin > r.meanMax) parts.push(`average ${r.meanMin}–${r.meanMax}`);
    if (r.sdMin > r.sdMax) parts.push(`spread ${r.sdMin}–${r.sdMax}`);
    if (parts.length > 0)
      broken.push({ ccaID: row.ccaID, problem: parts.join(" and ") });
  }
  return broken;
}

/** The error shown to JCRC when a new default would break waivers. */
export function brokenWaiversMessage(
  broken: readonly { ccaName: string; problem: string }[],
): string {
  const [only] = broken;
  if (broken.length === 1 && only) {
    return `This would make ${only.ccaName}'s waiver impossible (${only.problem}). Edit that waiver first.`;
  }
  const list = broken.map((b) => `${b.ccaName} (${b.problem})`).join(", ");
  return `This would make these waivers impossible: ${list}. Edit those waivers first.`;
}

/** Audit reason for a flat-points export: counts only, never a matric or a name. */
export function flatExportReason(
  ccaCount: number,
  memberCount: number,
): string {
  return `${ccaCount} CCA(s), ${memberCount} member(s)`;
}

/* -------------------------------------------------------------------------- */
/* Database helpers                                                            */
/* -------------------------------------------------------------------------- */

export function readDefaultRow(
  db: PrismaClient,
): Promise<CcaPointsConfig | null> {
  return db.ccaPointsConfig.findUnique({ where: { scope: DEFAULT_SCOPE } });
}

export function readOverrideRow(
  db: PrismaClient,
  ccaID: number,
): Promise<CcaPointsConfig | null> {
  return db.ccaPointsConfig.findUnique({ where: { scope: ccaScope(ccaID) } });
}

export function listOverrideRows(db: PrismaClient): Promise<CcaPointsConfig[]> {
  return db.ccaPointsConfig.findMany({
    where: { scope: { startsWith: "cca:" } },
    orderBy: { ccaID: "asc" },
  });
}

/** Hall-wide switch: only an explicit `true` is open. */
export const isEntryOpen = (row: CcaPointsConfig | null): boolean =>
  row?.entryOpen === true;

export async function writeEntryOpen(
  db: PrismaClient,
  open: boolean,
  actorUserID: string,
  now: Date,
): Promise<void> {
  await db.ccaPointsConfig.upsert({
    where: { scope: DEFAULT_SCOPE },
    create: {
      scope: DEFAULT_SCOPE,
      entryOpen: open,
      updatedAt: now,
      updatedBy: actorUserID,
    },
    update: { entryOpen: open, updatedAt: now, updatedBy: actorUserID },
  });
}

export async function writeDefaultRange(
  db: PrismaClient,
  range: Readonly<Range>,
  actorUserID: string,
  now: Date,
): Promise<void> {
  await db.ccaPointsConfig.upsert({
    where: { scope: DEFAULT_SCOPE },
    create: {
      scope: DEFAULT_SCOPE,
      ...range,
      updatedAt: now,
      updatedBy: actorUserID,
    },
    update: { ...range, updatedAt: now, updatedBy: actorUserID },
  });
}

export type OverrideValues = {
  meanMin: number | null;
  meanMax: number | null;
  sdMin: number | null;
  sdMax: number | null;
  note: string;
};

export async function writeOverride(
  db: PrismaClient,
  ccaID: number,
  values: OverrideValues,
  actorUserID: string,
  now: Date,
): Promise<void> {
  await db.ccaPointsConfig.upsert({
    where: { scope: ccaScope(ccaID) },
    create: {
      scope: ccaScope(ccaID),
      ccaID,
      ...values,
      updatedAt: now,
      updatedBy: actorUserID,
    },
    update: { ...values, updatedAt: now, updatedBy: actorUserID },
  });
}

/**
 * Prisma + MongoDB tell an explicit null from an unset field, so "blank" has to
 * test for both. The two halves of a per-CCA row (waiver fields, flat marking)
 * are each removed WITHOUT reading the row first: a read-then-delete could wipe
 * the other half if it were written in between. Instead the delete itself says
 * "only when the other half is blank", and if it matched nothing the one half is
 * nulled in place.
 */
const blank = (field: string): Prisma.CcaPointsConfigWhereInput => ({
  OR: [{ [field]: null }, { [field]: { isSet: false } }],
});
const filled = (field: string): Prisma.CcaPointsConfigWhereInput => ({
  [field]: { not: null },
});
const WAIVER_FIELDS = ["meanMin", "meanMax", "sdMin", "sdMax", "note"] as const;
const anyWaiverField: Prisma.CcaPointsConfigWhereInput = {
  OR: WAIVER_FIELDS.map(filled),
};

/**
 * Two removals that run at once can each null their own half of a row that held
 * both, leaving a row with every config field blank: neither waiver nor flat, and
 * nothing would ever clean it up. So each removal ends by deleting the row if it
 * is now entirely blank. Whichever finishes last finds the empty row and removes it.
 */
async function deleteIfBlank(db: PrismaClient, scope: string): Promise<void> {
  await db.ccaPointsConfig.deleteMany({
    where: {
      scope,
      AND: [...WAIVER_FIELDS, "flatPoints"].map(blank),
    },
  });
}

/**
 * Removes the WAIVER, returning whether there was one. A CCA that is also flat
 * keeps its row (only the waiver fields are cleared); otherwise the row goes.
 */
export async function removeOverride(
  db: PrismaClient,
  ccaID: number,
): Promise<boolean> {
  const scope = ccaScope(ccaID);
  const deleted = await db.ccaPointsConfig.deleteMany({
    where: { scope, AND: [blank("flatPoints"), anyWaiverField] },
  });
  if (deleted.count > 0) return true;
  const cleared = await db.ccaPointsConfig.updateMany({
    where: { scope, ...anyWaiverField },
    data: {
      meanMin: null,
      meanMax: null,
      sdMin: null,
      sdMax: null,
      note: null,
    },
  });
  await deleteIfBlank(db, scope);
  return cleared.count > 0;
}

/* -------------------------------------------------------------------------- */
/* Flat-points CCAs                                                            */
/* -------------------------------------------------------------------------- */

/** Every CCA currently marked flat, in ccaID order. */
export function listFlatRows(db: PrismaClient): Promise<CcaPointsConfig[]> {
  return db.ccaPointsConfig.findMany({
    where: { scope: { startsWith: "cca:" }, flatPoints: { not: null } },
    orderBy: { ccaID: "asc" },
  });
}

/** Marks a CCA flat at `flatPoints`; any waiver on the same row is left alone. */
export async function writeFlat(
  db: PrismaClient,
  ccaID: number,
  flatPoints: number,
  actorUserID: string,
  now: Date,
): Promise<void> {
  await db.ccaPointsConfig.upsert({
    where: { scope: ccaScope(ccaID) },
    create: {
      scope: ccaScope(ccaID),
      ccaID,
      flatPoints,
      updatedAt: now,
      updatedBy: actorUserID,
    },
    update: { flatPoints, updatedAt: now, updatedBy: actorUserID },
  });
}

/**
 * Removes the flat marking, returning whether the CCA was flat. A CCA that also
 * has a waiver keeps its row; otherwise the row goes.
 */
export async function clearFlat(
  db: PrismaClient,
  ccaID: number,
): Promise<boolean> {
  const scope = ccaScope(ccaID);
  const deleted = await db.ccaPointsConfig.deleteMany({
    where: { scope, ...filled("flatPoints"), AND: WAIVER_FIELDS.map(blank) },
  });
  if (deleted.count > 0) return true;
  const cleared = await db.ccaPointsConfig.updateMany({
    where: { scope, ...filled("flatPoints") },
    data: { flatPoints: null },
  });
  await deleteIfBlank(db, scope);
  return cleared.count > 0;
}
