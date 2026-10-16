import type { CcaPointsConfig, PrismaClient } from "@prisma/client";

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
 *   "cca:<ccaID>"  a per-CCA waiver; blank fields mean "use the default"
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

/** Returns whether a row existed. */
export async function removeOverride(
  db: PrismaClient,
  ccaID: number,
): Promise<boolean> {
  const { count } = await db.ccaPointsConfig.deleteMany({
    where: { scope: ccaScope(ccaID) },
  });
  return count > 0;
}
