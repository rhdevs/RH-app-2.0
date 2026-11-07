import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { auxYearOf } from "~/lib/auxPoints";
import { isRealIsoDate } from "~/lib/transcript/academicYear";
import { readDefaultRow } from "~/server/api/services/ccaPointsConfig";

/** The points year AUX is counting towards right now. */
export async function readAuxYear(
  db: PrismaClient,
  now: Date,
): Promise<string> {
  const row = await readDefaultRow(db);
  return auxYearOf(row?.pointsYear, now);
}

/** When "Start new points year" was last pressed, or null if never. */
export async function readAuxYearStartedAt(
  db: PrismaClient,
): Promise<Date | null> {
  const row = await readDefaultRow(db);
  return row?.yearStartedAt ?? null;
}

/**
 * Refuses a write to any year but the current points year: earlier years stay
 * stored and readable, never changed.
 */
export async function assertCurrentAuxYear(
  db: PrismaClient,
  year: string | null,
  now: Date,
): Promise<string> {
  const current = await readAuxYear(db, now);
  if (year !== current) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "AUX_YEAR_READ_ONLY",
    });
  }
  return current;
}

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** "2026-09-12" -> midnight that day in Singapore, as a UTC instant. */
export function sgtMidnight(isoDate: string): Date {
  if (!isRealIsoDate(isoDate)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "AUX_BAD_DATE" });
  }
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - SGT_OFFSET_MS);
}

/** The inverse of sgtMidnight, for showing a stored date back in a form. */
export function sgtIsoDate(date: Date): string {
  return new Date(date.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}
