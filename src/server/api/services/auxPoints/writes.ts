import { Prisma, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  AUX_PASTE_MAX_LINES,
  isValidAuxAmount,
  parseAmountLines,
  parseIdentifierLines,
  type IdentifierLine,
} from "~/lib/auxPoints";
import { writeAudit } from "~/server/api/routers/admin";
import type { AuditAction } from "~/server/api/services/roles";
import {
  resolveAuxIdentifiers,
  type ResolvedLine,
  type UnresolvedLine,
} from "./people";
import {
  assertCurrentAuxYear,
  readAuxYear,
  readAuxYearStartedAt,
  sgtMidnight,
} from "./year";

/**
 * Every AUX write. Each one checks the year is the current points year (past
 * years are read-only) and leaves an audit row: AUX counts towards points.
 * The caller has already checked the JCRC capability with a live role read.
 */

export type AuxActor = { userID: string; roles: string[]; now: Date };

const audit = (
  db: PrismaClient,
  actor: AuxActor,
  action: AuditAction,
  e: { targetEventID?: number; targetUserID?: string; reason?: string },
) =>
  writeAudit(db, {
    actorUserID: actor.userID,
    actorRoles: actor.roles,
    action,
    ...e,
  });

const notFound = (message: string) =>
  new TRPCError({ code: "NOT_FOUND", message });

const isUniqueClash = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

function pastedLines(text: string): IdentifierLine[] {
  const lines = parseIdentifierLines(text);
  if (lines.length > AUX_PASTE_MAX_LINES) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "AUX_TOO_MANY_LINES" });
  }
  return lines;
}

export type AddResult = {
  added: ResolvedLine[];
  already: ResolvedLine[];
  unknown: UnresolvedLine[];
};

/* ------------------------------------------------------------------ events */

const CLOSED_STATUSES = new Set(["canceled", "declined"]);

/**
 * Turns an event's AUX switch on (stamped with the current points year) or
 * off. Any JCRC member, any time, any CCA's event. A past year's AUX event is
 * read-only, so its switch cannot be turned off.
 */
export async function setEventAux(
  db: PrismaClient,
  actor: AuxActor,
  eventID: number,
  on: boolean,
): Promise<{ auxYear: string | null }> {
  const event = await db.event.findUnique({
    where: { eventID },
    select: { eventID: true, status: true, auxYear: true, startTime: true },
  });
  if (!event) throw notFound("EVENT_NOT_FOUND");

  if (on) {
    if (event.auxYear) {
      const current = await readAuxYear(db, actor.now);
      if (event.auxYear === current) return { auxYear: current };
      return moveToCurrentYear(db, actor, event, current);
    }
    if (CLOSED_STATUSES.has(event.status ?? "")) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "AUX_EVENT_CLOSED",
      });
    }
    const year = await readAuxYear(db, actor.now);
    const applied = await db.event.updateMany({
      where: {
        eventID,
        OR: [{ auxYear: null }, { auxYear: { isSet: false } }],
      },
      data: { auxYear: year, auxSetBy: actor.userID, auxSetAt: actor.now },
    });
    if (applied.count > 0) {
      await audit(db, actor, "aux.event.flag", {
        targetEventID: eventID,
        reason: year,
      });
    }
    return { auxYear: year };
  }

  if (!event.auxYear) return { auxYear: null };
  const year = await assertCurrentAuxYear(db, event.auxYear, actor.now);
  const applied = await db.event.updateMany({
    where: { eventID, auxYear: year },
    data: { auxYear: null, auxSetBy: actor.userID, auxSetAt: actor.now },
  });
  if (applied.count > 0) {
    await audit(db, actor, "aux.event.unflag", {
      targetEventID: eventID,
      reason: year,
    });
  }
  return { auxYear: null };
}

/**
 * An event flagged before "Start new points year" was pressed, but held
 * after it, belongs to the new year: flagging it again moves it there. An
 * event held before the new year began stays in its own, read-only year.
 */
async function moveToCurrentYear(
  db: PrismaClient,
  actor: AuxActor,
  event: { eventID: number; auxYear: string | null; startTime: number | null },
  current: string,
): Promise<{ auxYear: string }> {
  const startedAt = await readAuxYearStartedAt(db);
  const heldAfter =
    startedAt !== null &&
    event.startTime !== null &&
    event.startTime * 1000 >= startedAt.getTime();
  if (!heldAfter) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "AUX_YEAR_READ_ONLY",
    });
  }
  const applied = await db.event.updateMany({
    where: { eventID: event.eventID, auxYear: event.auxYear },
    data: { auxYear: current, auxSetBy: actor.userID, auxSetAt: actor.now },
  });
  if (applied.count > 0) {
    await audit(db, actor, "aux.event.flag", {
      targetEventID: event.eventID,
      reason: `${event.auxYear} -> ${current}`,
    });
  }
  return { auxYear: current };
}

/** The event, which must be an AUX event of the current points year. */
async function currentAuxEvent(
  db: PrismaClient,
  eventID: number,
  now: Date,
): Promise<{ eventID: number; auxYear: string }> {
  const event = await db.event.findUnique({
    where: { eventID },
    select: { eventID: true, auxYear: true },
  });
  if (!event) throw notFound("EVENT_NOT_FOUND");
  if (!event.auxYear) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NOT_AN_AUX_EVENT",
    });
  }
  await assertCurrentAuxYear(db, event.auxYear, now);
  return { eventID, auxYear: event.auxYear };
}

/**
 * Adds pasted people to an AUX event's attendance as manual check-ins. Not
 * bound by the attendance switch or the door window: this is JCRC fixing the
 * record, before or after the event. Someone already checked in is reported,
 * not duplicated.
 */
export async function addEventAttendees(
  db: PrismaClient,
  actor: AuxActor,
  eventID: number,
  text: string,
): Promise<AddResult> {
  await currentAuxEvent(db, eventID, actor.now);
  const { found, unknown } = await resolveAuxIdentifiers(db, pastedLines(text));
  const ids = found.map((f) => f.userID);
  const [present, signups] = await Promise.all([
    db.eventAttendance.findMany({
      where: { eventID, userID: { in: ids } },
      select: { userID: true },
    }),
    db.eventSignup.findMany({
      where: { eventID, userID: { in: ids } },
      select: { userID: true },
    }),
  ]);
  const presentIDs = new Set(present.map((p) => p.userID));
  const signedUp = new Set(signups.map((s) => s.userID));
  const added: ResolvedLine[] = [];
  const already: ResolvedLine[] = found.filter((f) => presentIDs.has(f.userID));
  for (const f of found.filter((x) => !presentIDs.has(x.userID))) {
    try {
      await db.eventAttendance.create({
        data: {
          eventID,
          userID: f.userID,
          checkedInAt: actor.now,
          checkedInBy: actor.userID,
          method: "manual",
          wasSignedUp: signedUp.has(f.userID),
        },
      });
      added.push(f);
    } catch (err) {
      // Checked in at the door in the meantime: the row is there either way.
      if (!isUniqueClash(err)) throw err;
      already.push(f);
    }
  }
  if (added.length > 0) {
    await audit(db, actor, "aux.attendee.add", {
      targetEventID: eventID,
      reason: `added ${added.length}`,
    });
  }
  return { added, already, unknown };
}

export async function removeEventAttendee(
  db: PrismaClient,
  actor: AuxActor,
  eventID: number,
  userID: string,
): Promise<void> {
  await currentAuxEvent(db, eventID, actor.now);
  const gone = await db.eventAttendance.deleteMany({
    where: { eventID, userID },
  });
  if (gone.count === 0) throw notFound("ATTENDEE_NOT_FOUND");
  await audit(db, actor, "aux.attendee.remove", {
    targetEventID: eventID,
    targetUserID: userID,
  });
}

/* ----------------------------------------------------------------- records */

async function currentRecord(db: PrismaClient, id: string, now: Date) {
  const record = await db.auxRecord.findUnique({ where: { id } });
  if (!record) throw notFound("AUX_RECORD_NOT_FOUND");
  await assertCurrentAuxYear(db, record.academicYear, now);
  return record;
}

/** A record-only AUX event: something held before the app tracked it. */
export async function createRecord(
  db: PrismaClient,
  actor: AuxActor,
  input: { title: string; heldOn: string; text: string },
): Promise<{ id: string } & AddResult> {
  const year = await readAuxYear(db, actor.now);
  const heldOn = sgtMidnight(input.heldOn);
  const lines = pastedLines(input.text);
  const record = await db.auxRecord.create({
    data: {
      academicYear: year,
      title: input.title,
      heldOn,
      createdBy: actor.userID,
    },
  });
  await audit(db, actor, "aux.record.create", {
    reason: `${input.title} (${input.heldOn})`,
  });
  const result = await addToRecord(db, actor, record.id, year, lines);
  return { id: record.id, ...result };
}

export async function updateRecord(
  db: PrismaClient,
  actor: AuxActor,
  input: { id: string; title: string; heldOn: string },
): Promise<void> {
  const record = await currentRecord(db, input.id, actor.now);
  await db.auxRecord.update({
    where: { id: record.id },
    data: {
      title: input.title,
      heldOn: sgtMidnight(input.heldOn),
      updatedBy: actor.userID,
      updatedAt: actor.now,
    },
  });
  await audit(db, actor, "aux.record.edit", {
    reason: `${input.title} (${input.heldOn})`,
  });
}

/** Deletes a record-only event and its list. */
export async function deleteRecord(
  db: PrismaClient,
  actor: AuxActor,
  id: string,
): Promise<void> {
  const record = await currentRecord(db, id, actor.now);
  // Attendees first: a failure then leaves a record with a shorter list,
  // never attendees counted for a record that is gone.
  const attendees = await db.auxRecordAttendee.deleteMany({
    where: { recordID: id },
  });
  await db.auxRecord.delete({ where: { id } });
  // Sweep anyone added between the two deletes, so no orphan is counted.
  await db.auxRecordAttendee.deleteMany({ where: { recordID: id } });
  await audit(db, actor, "aux.record.delete", {
    reason: `${record.title}: ${attendees.count} attendees`,
  });
}

async function addToRecord(
  db: PrismaClient,
  actor: AuxActor,
  recordID: string,
  year: string,
  lines: readonly IdentifierLine[],
): Promise<AddResult> {
  const { found, unknown } = await resolveAuxIdentifiers(db, lines);
  const present = await db.auxRecordAttendee.findMany({
    where: { recordID, userID: { in: found.map((f) => f.userID) } },
    select: { userID: true },
  });
  const presentIDs = new Set(present.map((p) => p.userID));
  const added: ResolvedLine[] = [];
  const already: ResolvedLine[] = found.filter((f) => presentIDs.has(f.userID));
  for (const f of found.filter((x) => !presentIDs.has(x.userID))) {
    try {
      await db.auxRecordAttendee.create({
        data: {
          recordID,
          academicYear: year,
          userID: f.userID,
          addedBy: actor.userID,
          addedAt: actor.now,
        },
      });
      added.push(f);
    } catch (err) {
      if (!isUniqueClash(err)) throw err;
      already.push(f);
    }
  }
  if (added.length > 0) {
    await audit(db, actor, "aux.attendee.add", {
      reason: `record ${recordID}: added ${added.length}`,
    });
  }
  return { added, already, unknown };
}

export async function addRecordAttendees(
  db: PrismaClient,
  actor: AuxActor,
  recordID: string,
  text: string,
): Promise<AddResult> {
  const record = await currentRecord(db, recordID, actor.now);
  return addToRecord(
    db,
    actor,
    record.id,
    record.academicYear,
    pastedLines(text),
  );
}

export async function removeRecordAttendee(
  db: PrismaClient,
  actor: AuxActor,
  recordID: string,
  userID: string,
): Promise<void> {
  await currentRecord(db, recordID, actor.now);
  const gone = await db.auxRecordAttendee.deleteMany({
    where: { recordID, userID },
  });
  if (gone.count === 0) throw notFound("ATTENDEE_NOT_FOUND");
  await audit(db, actor, "aux.attendee.remove", {
    targetUserID: userID,
    reason: `record ${recordID}`,
  });
}

/* ------------------------------------------------------------------ awards */

export type AwardInput = { amount: number; reason: string; awardedOn: string };

function checkAmount(amount: number): void {
  if (!isValidAuxAmount(amount)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "AUX_BAD_AMOUNT" });
  }
}

const awardReason = (a: AwardInput) =>
  `${a.amount} for ${a.reason} (${a.awardedOn})`;

export async function createAward(
  db: PrismaClient,
  actor: AuxActor,
  input: AwardInput & { userID: string },
): Promise<{ id: string }> {
  checkAmount(input.amount);
  const year = await readAuxYear(db, actor.now);
  const { found } = await resolveAuxIdentifiers(db, [
    { line: 1, raw: input.userID },
  ]);
  const userID = found[0]?.userID;
  if (!userID) throw notFound("RESIDENT_NOT_FOUND");
  const awardedOn = sgtMidnight(input.awardedOn);
  const twins = await alreadyAwarded(
    db,
    year,
    [userID],
    input.reason,
    awardedOn,
  );
  if (twins.size > 0) {
    throw new TRPCError({ code: "CONFLICT", message: "AUX_AWARD_DUPLICATE" });
  }
  const award = await db.auxAward.create({
    data: {
      academicYear: year,
      userID,
      amount: input.amount,
      reason: input.reason,
      awardedOn,
      createdBy: actor.userID,
      createdAt: actor.now,
    },
  });
  await audit(db, actor, "aux.award.create", {
    targetUserID: userID,
    reason: awardReason(input),
  });
  return { id: award.id };
}

/**
 * Who already has an award with this reason and date this year: the same
 * award given twice (a double click, a retried paste) is refused, not added.
 */
async function alreadyAwarded(
  db: PrismaClient,
  year: string,
  userIDs: string[],
  reason: string,
  awardedOn: Date,
): Promise<Set<string>> {
  if (userIDs.length === 0) return new Set();
  const rows = await db.auxAward.findMany({
    where: { academicYear: year, userID: { in: userIDs }, reason, awardedOn },
    select: { userID: true },
  });
  return new Set(rows.map((r) => r.userID));
}

/**
 * Carried-over totals: "identifier, amount" per line, each becoming one award
 * with the same reason and date. A line with a bad amount or an unknown person
 * is listed back and nothing is written for it; a person who already has an
 * award with this reason and date is listed as already done.
 */
export async function importAwards(
  db: PrismaClient,
  actor: AuxActor,
  input: { text: string; reason: string; awardedOn: string },
): Promise<{
  added: (ResolvedLine & { amount: number })[];
  already: ResolvedLine[];
  unknown: UnresolvedLine[];
  badAmount: IdentifierLine[];
}> {
  const year = await readAuxYear(db, actor.now);
  const awardedOn = sgtMidnight(input.awardedOn);
  const lines = parseAmountLines(input.text);
  if (lines.length > AUX_PASTE_MAX_LINES) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "AUX_TOO_MANY_LINES" });
  }
  const badAmount = lines
    .filter((l) => l.amount === null)
    .map(({ line, raw }) => ({ line, raw }));
  const amounts = new Map(
    lines.flatMap((l) => (l.amount === null ? [] : [[l.line, l.amount]])),
  );
  const { found, unknown } = await resolveAuxIdentifiers(
    db,
    lines
      .filter((l) => l.amount !== null)
      .map(({ line, raw }) => ({ line, raw })),
  );
  const twins = await alreadyAwarded(
    db,
    year,
    found.map((f) => f.userID),
    input.reason,
    awardedOn,
  );
  const already = found.filter((f) => twins.has(f.userID));
  const added = found
    .filter((f) => !twins.has(f.userID))
    .map((f) => ({ ...f, amount: amounts.get(f.line)! }));
  if (added.length > 0) {
    await db.auxAward.createMany({
      data: added.map((a) => ({
        academicYear: year,
        userID: a.userID,
        amount: a.amount,
        reason: input.reason,
        awardedOn,
        createdBy: actor.userID,
        createdAt: actor.now,
      })),
    });
    await audit(db, actor, "aux.award.create", {
      reason: `imported ${added.length} for ${input.reason} (${input.awardedOn})`,
    });
  }
  return { added, already, unknown, badAmount };
}

async function currentAward(db: PrismaClient, id: string, now: Date) {
  const award = await db.auxAward.findUnique({ where: { id } });
  if (!award) throw notFound("AUX_AWARD_NOT_FOUND");
  await assertCurrentAuxYear(db, award.academicYear, now);
  return award;
}

export async function updateAward(
  db: PrismaClient,
  actor: AuxActor,
  input: AwardInput & { id: string },
): Promise<void> {
  checkAmount(input.amount);
  const award = await currentAward(db, input.id, actor.now);
  await db.auxAward.update({
    where: { id: award.id },
    data: {
      amount: input.amount,
      reason: input.reason,
      awardedOn: sgtMidnight(input.awardedOn),
      updatedBy: actor.userID,
      updatedAt: actor.now,
    },
  });
  await audit(db, actor, "aux.award.edit", {
    targetUserID: award.userID,
    reason: `${award.amount} -> ${awardReason(input)}`,
  });
}

export async function deleteAward(
  db: PrismaClient,
  actor: AuxActor,
  id: string,
): Promise<void> {
  const award = await currentAward(db, id, actor.now);
  await db.auxAward.delete({ where: { id } });
  await audit(db, actor, "aux.award.delete", {
    targetUserID: award.userID,
    reason: `${award.amount} for ${award.reason}`,
  });
}
