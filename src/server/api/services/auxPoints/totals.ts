import type { PrismaClient } from "@prisma/client";

import { tallyAux, type AuxTotal } from "~/lib/auxPoints";
import { actorLabels } from "~/server/api/services/transcript/residents";
import { auxPeople, type AuxPerson } from "./people";
import { sgtIsoDate } from "./year";

/** The events flagged AUX for a points year, newest first. */
export function auxEventsOf(db: PrismaClient, year: string) {
  return db.event.findMany({
    where: { auxYear: year },
    select: {
      eventID: true,
      ccaID: true,
      title: true,
      startTime: true,
      status: true,
      auxSetAt: true,
    },
    orderBy: { startTime: "desc" },
  });
}

/** Every source of AUX in a year, one row per AUX (awards carry an amount). */
async function sourcesOf(db: PrismaClient, year: string) {
  const events = await db.event.findMany({
    where: { auxYear: year },
    select: { eventID: true },
  });
  const eventIDs = events.map((e) => e.eventID);
  const [eventCheckIns, recordAttendees, awards] = await Promise.all([
    eventIDs.length === 0
      ? Promise.resolve([])
      : db.eventAttendance.findMany({
          where: { eventID: { in: eventIDs } },
          select: { userID: true },
        }),
    db.auxRecordAttendee.findMany({
      where: { academicYear: year },
      select: { userID: true },
    }),
    db.auxAward.findMany({
      where: { academicYear: year },
      select: { userID: true, amount: true },
    }),
  ]);
  return { eventCheckIns, recordAttendees, awards };
}

export type AuxTotalRow = AuxTotal & AuxPerson;

/** Each resident's AUX for the year, with name and matric, by name. */
export async function auxTotals(
  db: PrismaClient,
  year: string,
): Promise<AuxTotalRow[]> {
  const totals = tallyAux(await sourcesOf(db, year));
  const people = await auxPeople(
    db,
    totals.map((t) => t.userID),
  );
  return totals
    .map((t) => ({
      ...t,
      ...(people.get(t.userID) ?? { name: null, matric: null }),
    }))
    .sort((a, b) =>
      (a.name ?? a.userID).localeCompare(b.name ?? b.userID, "en"),
    );
}

/** The years that hold any AUX record, plus the current one, newest first. */
export async function auxYears(
  db: PrismaClient,
  current: string,
): Promise<string[]> {
  const [events, records, awards] = await Promise.all([
    db.event.findMany({
      where: { auxYear: { not: null } },
      select: { auxYear: true },
      distinct: ["auxYear"],
    }),
    db.auxRecord.findMany({
      select: { academicYear: true },
      distinct: ["academicYear"],
    }),
    db.auxAward.findMany({
      select: { academicYear: true },
      distinct: ["academicYear"],
    }),
  ]);
  const years = new Set<string>([current]);
  for (const e of events) if (e.auxYear) years.add(e.auxYear);
  for (const r of [...records, ...awards]) years.add(r.academicYear);
  return [...years].sort().reverse();
}

/** Where one resident's AUX for the year came from. */
export async function auxDetail(
  db: PrismaClient,
  year: string,
  userID: string,
) {
  const events = await auxEventsOf(db, year);
  const titles = new Map(events.map((e) => [e.eventID, e]));
  const [checkIns, records, awards] = await Promise.all([
    events.length === 0
      ? Promise.resolve([])
      : db.eventAttendance.findMany({
          where: { userID, eventID: { in: events.map((e) => e.eventID) } },
          select: { eventID: true, checkedInAt: true, method: true },
        }),
    db.auxRecordAttendee.findMany({
      where: { academicYear: year, userID },
      select: { recordID: true },
    }),
    db.auxAward.findMany({
      where: { academicYear: year, userID },
      orderBy: { awardedOn: "asc" },
    }),
  ]);
  const recordRows =
    records.length === 0
      ? []
      : await db.auxRecord.findMany({
          where: { id: { in: records.map((r) => r.recordID) } },
          orderBy: { heldOn: "asc" },
        });
  const label = await actorLabels(
    db,
    awards.flatMap((a) => [a.createdBy, a.updatedBy]),
  );
  return {
    events: checkIns
      .map((c) => ({
        eventID: c.eventID,
        title: titles.get(c.eventID)?.title ?? `Event #${c.eventID}`,
        startTime: titles.get(c.eventID)?.startTime ?? null,
        method: c.method ?? "qr",
        checkedInAt: c.checkedInAt,
      }))
      .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0)),
    records: recordRows.map((r) => ({
      id: r.id,
      title: r.title,
      heldOn: sgtIsoDate(r.heldOn),
    })),
    awards: awards.map((a) => ({
      id: a.id,
      amount: a.amount,
      reason: a.reason,
      awardedOn: sgtIsoDate(a.awardedOn),
      createdBy: label(a.createdBy),
      updatedBy: label(a.updatedBy),
    })),
  };
}
