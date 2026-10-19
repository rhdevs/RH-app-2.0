import type { CcaPointsConfig, Prisma, PrismaClient } from "@prisma/client";

import {
  DEFAULT_RANGE,
  isIhgResult,
  isSportsCategory,
  isValidIhgCap,
  type Range,
} from "~/lib/points/constants";
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
 *   "cca:<ccaID>"  a per-CCA waiver (blank fields mean "use the default"),
 *                  a FLAT-points marking (`flatPoints`, null = not flat), a
 *                  points type (`ccaType`), an IHG config (`ihgResult` +
 *                  `ihgCap`) and JCRC's sport tick (`isSport`, null = follow
 *                  the category)
 *
 * One per-CCA row therefore has FIVE independent parts: waiver, flat, type, IHG
 * and sport. Each is cleared without reading the row first, and no clear may
 * delete a row that still holds another part — see `waiverRows`,
 * `removeOverride`, `clearFlat`, `deleteIfBlank` and `ALL_CONFIG_FIELDS`.
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

/** Longest stored string written to the log in full. */
const LOGGED_VALUE_MAX = 64;

/**
 * A stored config value, or null when it is blank or not valid. A non-blank
 * invalid value should never be in the table; if one is, say so in the log
 * (config only, never a score) rather than hiding it.
 */
export function validConfigValue<T>(
  ccaID: number,
  field: string,
  value: unknown,
  isValid: (v: unknown) => v is T,
): T | null {
  if (value === null || value === undefined) return null;
  if (isValid(value)) return value;
  const logged =
    typeof value === "string" && value.length > LOGGED_VALUE_MAX
      ? `${value.slice(0, LOGGED_VALUE_MAX)}…`
      : value;
  console.error(
    JSON.stringify({
      evt: "points_config_invalid_value",
      ccaID,
      field,
      value: logged,
    }),
  );
  return null;
}

/** The fields of a per-CCA row that decide what kind of row it is. */
export type ConfigRowLike = RangeOverride & {
  note: string | null;
  flatPoints: number | null;
  /** Optional so fixtures that predate type, IHG and sport still fit; unset reads as blank. */
  ccaType?: string | null;
  ihgResult?: string | null;
  ihgCap?: number | null;
  isSport?: boolean | null;
};

/** Flat when `flatPoints` is a number (0 is a valid flat value). */
export const isFlatRow = (row: ConfigRowLike | null): boolean =>
  row?.flatPoints !== null && row?.flatPoints !== undefined;

/** Has a points type. */
export const isTypeRow = (row: ConfigRowLike | null): boolean =>
  row?.ccaType !== null && row?.ccaType !== undefined;

/** Has any IHG config (a result, a cap, or both). */
export const isIhgRow = (row: ConfigRowLike | null): boolean =>
  (row?.ihgResult !== null && row?.ihgResult !== undefined) ||
  (row?.ihgCap !== null && row?.ihgCap !== undefined);

/** A valid result AND a valid cap: all a sport needs before entry may open. */
export const isIhgComplete = (row: ConfigRowLike | null): boolean =>
  isIhgResult(row?.ihgResult) && isValidIhgCap(row?.ihgCap);

/**
 * THE ONLY sports rule: JCRC's tick wins, otherwise the CCA's category decides.
 * Temporary: a later portfolio refactor will replace this.
 */
export const effectiveIsSport = (
  row: Pick<ConfigRowLike, "isSport"> | null,
  category: string | null,
): boolean => row?.isSport ?? isSportsCategory(category);

/**
 * The entry-open gate: names (in the order given) of every non-flat sport that
 * lacks a valid IHG result or cap. Flat sports are ignored: their members get a
 * flat value and no IHG.
 */
export function sportsMissingIhg(
  ccas: readonly { ccaID: number; ccaName: string; category: string | null }[],
  rows: readonly (ConfigRowLike & { ccaID: number | null })[],
): string[] {
  const rowById = new Map(rows.map((r) => [r.ccaID, r]));
  return ccas
    .filter((c) => {
      const row = rowById.get(c.ccaID) ?? null;
      return (
        effectiveIsSport(row, c.category) &&
        !isFlatRow(row) &&
        !isIhgComplete(row)
      );
    })
    .map((c) => c.ccaName);
}

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

/** Audit reasons for type, IHG, sport and the new year: config values and counts only. */
export const typeReason = (type: string | null): string =>
  `type ${type ?? "blank"}`;
export const ihgReason = (result: string | null, cap: number | null): string =>
  `IHG ${result ?? "blank"}; cap ${cap ?? "blank"}`;
/** The audit reason when starting a new year throws after entry was closed. */
export const NEW_YEAR_FAILED_REASON =
  "failed partway: entry closed first; IHG results may not be cleared";

export const newYearReason = (cleared: number): string =>
  `${cleared} IHG result(s) cleared; entry closed`;
export const sportReason = (isSport: boolean | null): string =>
  isSport === null ? "sport default" : isSport ? "sport yes" : "sport no";

/** Audit reason for a sandbox-bundle export: counts only, never a matric or a name. */
export function bundleExportReason(
  ccaCount: number,
  flatCcaCount: number,
  memberCount: number,
): string {
  return `${ccaCount} CCA(s), ${flatCcaCount} flat CCA(s), ${memberCount} member(s)`;
}

/* -------------------------------------------------------------------------- */
/* Database helpers                                                          */
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
 * test for both. The five parts of a per-CCA row (waiver, flat marking, type, IHG
 * config, sport tick) are each removed WITHOUT reading the row first: a
 * read-then-delete could wipe another part if it were written in between.
 * Instead the delete itself says "only when every other part is blank", and if
 * it matched nothing the one part is nulled in place.
 */
const blank = (field: string): Prisma.CcaPointsConfigWhereInput => ({
  OR: [{ [field]: null }, { [field]: { isSet: false } }],
});
const filled = (field: string): Prisma.CcaPointsConfigWhereInput => ({
  [field]: { not: null },
});
const WAIVER_FIELDS = ["meanMin", "meanMax", "sdMin", "sdMax", "note"] as const;
const TYPE_FIELDS = ["ccaType"] as const;
const IHG_FIELDS = ["ihgResult", "ihgCap"] as const;
const SPORT_FIELDS = ["isSport"] as const;
/** Every config field of a per-CCA row; a row with all of these blank is empty. */
const ALL_CONFIG_FIELDS = [
  ...WAIVER_FIELDS,
  "flatPoints",
  ...TYPE_FIELDS,
  ...IHG_FIELDS,
  ...SPORT_FIELDS,
] as const;
const anyWaiverField: Prisma.CcaPointsConfigWhereInput = {
  OR: WAIVER_FIELDS.map(filled),
};

/**
 * Two removals that run at once can each null their own part of a row that held
 * both, leaving a row with every config field blank: it means nothing, and
 * nothing would ever clean it up. So each removal ends by deleting the row if it
 * is now entirely blank. Whichever finishes last finds the empty row and removes it.
 */
async function deleteIfBlank(db: PrismaClient, scope: string): Promise<void> {
  await db.ccaPointsConfig.deleteMany({
    where: { scope, AND: ALL_CONFIG_FIELDS.map(blank) },
  });
}

/**
 * Removes the WAIVER, returning whether there was one. A CCA that also holds a
 * flat marking, a type, an IHG config or a sport tick keeps its row (only the
 * waiver fields are cleared); otherwise the row goes.
 */
export async function removeOverride(
  db: PrismaClient,
  ccaID: number,
): Promise<boolean> {
  const scope = ccaScope(ccaID);
  const deleted = await db.ccaPointsConfig.deleteMany({
    where: {
      scope,
      AND: [
        blank("flatPoints"),
        ...TYPE_FIELDS.map(blank),
        ...IHG_FIELDS.map(blank),
        ...SPORT_FIELDS.map(blank),
        anyWaiverField,
      ],
    },
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
 * has a waiver, a type, an IHG config or a sport tick keeps its row; otherwise
 * the row goes.
 */
export async function clearFlat(
  db: PrismaClient,
  ccaID: number,
): Promise<boolean> {
  const scope = ccaScope(ccaID);
  const deleted = await db.ccaPointsConfig.deleteMany({
    where: {
      scope,
      ...filled("flatPoints"),
      AND: [
        ...WAIVER_FIELDS,
        ...TYPE_FIELDS,
        ...IHG_FIELDS,
        ...SPORT_FIELDS,
      ].map(blank),
    },
  });
  if (deleted.count > 0) return true;
  const cleared = await db.ccaPointsConfig.updateMany({
    where: { scope, ...filled("flatPoints") },
    data: { flatPoints: null },
  });
  await deleteIfBlank(db, scope);
  return cleared.count > 0;
}

/* -------------------------------------------------------------------------- */
/* Type, IHG, sport and the new points year                                    */
/* -------------------------------------------------------------------------- */

/** Sets (or, with null, clears) a CCA's points type; the other parts are left alone. */
export async function writeType(
  db: PrismaClient,
  ccaID: number,
  ccaType: string | null,
  actorUserID: string,
  now: Date,
): Promise<void> {
  await db.ccaPointsConfig.upsert({
    where: { scope: ccaScope(ccaID) },
    create: {
      scope: ccaScope(ccaID),
      ccaID,
      ccaType,
      updatedAt: now,
      updatedBy: actorUserID,
    },
    update: { ccaType, updatedAt: now, updatedBy: actorUserID },
  });
  await deleteIfBlank(db, ccaScope(ccaID));
}

/** Sets a sport's IHG result and cap together (null, null clears both). */
export async function writeIhg(
  db: PrismaClient,
  ccaID: number,
  ihg: { ihgResult: string | null; ihgCap: number | null },
  actorUserID: string,
  now: Date,
): Promise<void> {
  await db.ccaPointsConfig.upsert({
    where: { scope: ccaScope(ccaID) },
    create: {
      scope: ccaScope(ccaID),
      ccaID,
      ...ihg,
      updatedAt: now,
      updatedBy: actorUserID,
    },
    update: { ...ihg, updatedAt: now, updatedBy: actorUserID },
  });
  await deleteIfBlank(db, ccaScope(ccaID));
}

/** Sets JCRC's sport tick; null goes back to the category default. */
export async function writeSport(
  db: PrismaClient,
  ccaID: number,
  isSport: boolean | null,
  actorUserID: string,
  now: Date,
): Promise<void> {
  await db.ccaPointsConfig.upsert({
    where: { scope: ccaScope(ccaID) },
    create: {
      scope: ccaScope(ccaID),
      ccaID,
      isSport,
      updatedAt: now,
      updatedBy: actorUserID,
    },
    update: { isSport, updatedAt: now, updatedBy: actorUserID },
  });
  await deleteIfBlank(db, ccaScope(ccaID));
}

/**
 * Starts a new points year: closes points entry, nulls every IHG result (caps stay),
 * then deletes any per-CCA row left with every config field blank. Returns
 * how many results were cleared. Types, caps, sport ticks, waivers, flat values
 * and the default range are kept.
 */
export async function startNewPointsYear(
  db: PrismaClient,
  actorUserID: string,
  now: Date,
): Promise<number> {
  // Close first: if clearing the results then fails, entry is shut, not open
  // with sports missing their IHG result.
  await writeEntryOpen(db, false, actorUserID, now);
  const cleared = await db.ccaPointsConfig.updateMany({
    where: { scope: { startsWith: "cca:" }, ihgResult: { not: null } },
    data: { ihgResult: null, updatedAt: now, updatedBy: actorUserID },
  });
  await db.ccaPointsConfig.deleteMany({
    where: {
      scope: { startsWith: "cca:" },
      AND: ALL_CONFIG_FIELDS.map(blank),
    },
  });
  return cleared.count;
}
