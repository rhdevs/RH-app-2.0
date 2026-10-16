import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { firstDuplicate } from "~/lib/transcript/activities";
import type {
  volunteerActivityCreateInput,
  volunteerActivityUpdateInput,
  volunteerAttendanceSaveInput,
  volunteerPeopleSetInput,
  volunteerSessionAddInput,
  volunteerSessionUpdateInput,
} from "~/lib/transcript/manageInput";
import { isDateInAcademicYear } from "~/lib/transcript/academicYear";
import {
  MAX_VOLUNTEER_ACTIVITIES,
  MAX_VOLUNTEER_PEOPLE,
  MAX_VOLUNTEER_SESSIONS,
  grandTotal,
  nextSessionDefaults,
  personTotals,
  readKind,
  type VolunteerKind,
} from "~/lib/transcript/volunteer";
import { instantToSgDate, sgDateToInstant } from "~/lib/transcript/sgDate";
import { assertCanEditCcaYear } from "./editRights";
import { correctionSummary } from "~/lib/transcript/corrections";
import { assertCanEditForResidents, logCorrections } from "./residentRecords";
import { NOT_REMOVED } from "./loader";
import { actorLabels, lookupResidents, requireResident } from "./residents";

/**
 * VOLUNTEER ACTIVITIES of a volunteering CCA (one tagged
 * CcaProfile.isVolunteering: the four "RVC ..." CCAs), for one academic year.
 *
 *  - An activity is `regular` (sessions added over the year) or `oneoff`
 *    (exactly one session). People are any existing residents, not only members.
 *  - A tick (VolunteerAttendance) says a person attended a session; the row's
 *    presence is the state, so unticking deletes it. Hours per person =
 *    the sum, over active sessions they are ticked in, of the override or the
 *    session's hours. Removing an activity, session or person only sets
 *    removedAt/By, so everything can be restored.
 *
 * The caller has already checked access. Every write runs the one edit guard
 * (`assertCanEditCcaYear`) for the activity's own year and then requires the CCA
 * to still be tagged as volunteering (managers included). Reading never does:
 * an untagged CCA's activities still render on transcripts.
 */

const fail = (
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED",
  message: string,
) => new TRPCError({ code, message });

/** The CCA must be tagged as a volunteering CCA, managers included. */
export async function requireVolunteeringCca(db: PrismaClient, ccaID: number) {
  const profile = await db.ccaProfile.findUnique({
    where: { ccaID },
    select: { isVolunteering: true },
  });
  if (profile?.isVolunteering !== true) {
    throw fail("PRECONDITION_FAILED", "NOT_A_VOLUNTEERING_CCA");
  }
}

/** The edit guard for a year, then the volunteering tag. */
async function assertCanWrite(
  db: PrismaClient,
  actorUserID: string,
  ccaID: number,
  academicYear: string,
) {
  await assertCanEditCcaYear(db, { userID: actorUserID }, ccaID, academicYear);
  await requireVolunteeringCca(db, ccaID);
}

/**
 * The guard for a write that changes known residents' hours: the edit guard,
 * or (a manager, in a published year, for UNLOCKED residents only) a correction;
 * then the volunteering tag.
 */
async function assertCanWriteForResidents(
  db: PrismaClient,
  actorUserID: string,
  ccaID: number,
  academicYear: string,
  affectedUserIDs: readonly string[],
) {
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    { ccaID, academicYear, affectedUserIDs },
  );
  await requireVolunteeringCca(db, ccaID);
  return guard;
}

async function requireActivity(db: PrismaClient, id: string, ccaID: number) {
  const row = await db.volunteerActivity.findUnique({ where: { id } });
  if (!row || row.ccaID !== ccaID) {
    throw fail("NOT_FOUND", "ACTIVITY_NOT_FOUND");
  }
  return row;
}

async function requireSession(db: PrismaClient, id: string, ccaID: number) {
  const row = await db.volunteerSession.findUnique({ where: { id } });
  if (!row || row.ccaID !== ccaID) {
    throw fail("NOT_FOUND", "SESSION_NOT_FOUND");
  }
  return row;
}

/** The year an activity or session belongs to, so a router can run the guard first. */
export async function volunteerActivityYear(
  db: PrismaClient,
  activityID: string,
  ccaID: number,
): Promise<string> {
  return (await requireActivity(db, activityID, ccaID)).academicYear;
}

export async function volunteerSessionYear(
  db: PrismaClient,
  sessionID: string,
  ccaID: number,
): Promise<string> {
  return (await requireSession(db, sessionID, ccaID)).academicYear;
}

const blank = (s: string) => (s === "" ? null : s);

const activeCount = (
  db: Pick<PrismaClient, "volunteerActivity">,
  ccaID: number,
  academicYear: string,
) =>
  db.volunteerActivity.count({
    where: { academicYear, ccaID, ...NOT_REMOVED },
  });

const activeSessionCount = (
  db: Pick<PrismaClient, "volunteerSession">,
  activityID: string,
) => db.volunteerSession.count({ where: { activityID, ...NOT_REMOVED } });

/* ---- reading -------------------------------------------------------------- */

export interface VolunteerActivitySummary {
  id: string;
  title: string;
  kind: VolunteerKind;
  description: string;
  defaultHours: number | null;
  removed: boolean;
  removedByName: string | null;
  removedAt: Date | null;
  createdByName: string | null;
  updatedByName: string | null;
  peopleCount: number;
  /** Everyone's hours added up (active sessions and people only). */
  totalHours: number;
}

export interface VolunteerActivityList {
  activeCount: number;
  max: number;
  activities: VolunteerActivitySummary[];
}

/** The activities of one CCA and year, with people counts and total hours. */
export async function volunteerActivitiesList(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
  includeRemoved: boolean,
): Promise<VolunteerActivityList> {
  const [rows, count] = await Promise.all([
    db.volunteerActivity.findMany({
      where: {
        academicYear,
        ccaID,
        ...(includeRemoved ? {} : NOT_REMOVED),
      },
      orderBy: { createdAt: "asc" },
    }),
    activeCount(db, ccaID, academicYear),
  ]);
  const ids = rows.map((r) => r.id);
  const [people, sessions, ticks] = await Promise.all([
    db.volunteerPerson.findMany({
      where: { activityID: { in: ids }, ...NOT_REMOVED },
      select: { activityID: true, userID: true },
    }),
    db.volunteerSession.findMany({
      where: { activityID: { in: ids }, ...NOT_REMOVED },
      select: { id: true, activityID: true, hours: true },
    }),
    db.volunteerAttendance.findMany({
      where: { activityID: { in: ids } },
      select: {
        activityID: true,
        sessionID: true,
        userID: true,
        hoursOverride: true,
      },
    }),
  ]);
  const label = await actorLabels(
    db,
    rows.flatMap((r) => [r.createdBy, r.updatedBy, r.removedBy]),
  );
  const group = <T extends { activityID: string }>(list: T[], id: string) =>
    list.filter((x) => x.activityID === id);

  return {
    activeCount: count,
    max: MAX_VOLUNTEER_ACTIVITIES,
    activities: rows.map((r) => {
      const mine = group(people, r.id).map((p) => p.userID);
      const totals = personTotals({
        sessions: group(sessions, r.id),
        people: mine,
        attendance: group(ticks, r.id),
      });
      return {
        id: r.id,
        title: r.title,
        kind: readKind(r.kind),
        description: r.description ?? "",
        defaultHours: r.defaultHours ?? null,
        removed: r.removedAt != null,
        removedByName: label(r.removedBy),
        removedAt: r.removedAt ?? null,
        createdByName: label(r.createdBy),
        updatedByName: label(r.updatedBy),
        peopleCount: mine.length,
        totalHours: grandTotal(totals),
      };
    }),
  };
}

export interface VolunteerSessionView {
  id: string;
  /** Singapore calendar date, "2026-10-08". */
  date: string;
  hours: number;
  removed: boolean;
}

export interface VolunteerActivityDetail {
  id: string;
  academicYear: string;
  title: string;
  kind: VolunteerKind;
  description: string;
  defaultHours: number | null;
  removed: boolean;
  /** Oldest first; removed sessions are flagged, not hidden. */
  sessions: VolunteerSessionView[];
  people: Array<{ userID: string; displayName: string | null }>;
  /** Ticks on active sessions of active people. */
  cells: Array<{
    sessionID: string;
    userID: string;
    hoursOverride: number | null;
  }>;
  totals: Record<string, number>;
  totalHours: number;
  maxSessions: number;
  maxPeople: number;
}

/** One activity in full: its sessions, people and ticks, for the grid. */
export async function volunteerActivityGet(
  db: PrismaClient,
  activityID: string,
  ccaID: number,
): Promise<VolunteerActivityDetail> {
  const activity = await requireActivity(db, activityID, ccaID);
  const [sessions, people, ticks] = await Promise.all([
    db.volunteerSession.findMany({
      where: { activityID },
      orderBy: { date: "asc" },
    }),
    db.volunteerPerson.findMany({
      where: { activityID, ...NOT_REMOVED },
      orderBy: { addedAt: "asc" },
    }),
    db.volunteerAttendance.findMany({ where: { activityID } }),
  ]);
  const names = await lookupResidents(
    db,
    people.map((p) => p.userID),
  );
  const activeSessions = sessions.filter((s) => s.removedAt == null);
  const keys = people.map((p) => p.userID);
  const totals = personTotals({
    sessions: activeSessions,
    people: keys,
    attendance: ticks,
  });
  const live = new Set(activeSessions.map((s) => s.id));
  const who = new Set(keys);
  return {
    id: activity.id,
    academicYear: activity.academicYear,
    title: activity.title,
    kind: readKind(activity.kind),
    description: activity.description ?? "",
    defaultHours: activity.defaultHours ?? null,
    removed: activity.removedAt != null,
    sessions: sessions.map((s) => ({
      id: s.id,
      date: instantToSgDate(s.date),
      hours: s.hours,
      removed: s.removedAt != null,
    })),
    people: people.map((p) => ({
      userID: p.userID,
      displayName: names.get(p.userID)?.displayName ?? null,
    })),
    cells: ticks
      .filter((t) => live.has(t.sessionID) && who.has(t.userID))
      .map((t) => ({
        sessionID: t.sessionID,
        userID: t.userID,
        hoursOverride: t.hoursOverride ?? null,
      })),
    totals: Object.fromEntries(totals),
    totalHours: grandTotal(totals),
    maxSessions: MAX_VOLUNTEER_SESSIONS,
    maxPeople: MAX_VOLUNTEER_PEOPLE,
  };
}

/* ---- activities ----------------------------------------------------------- */

const sessionDate = (iso: string) => {
  const instant = sgDateToInstant(iso);
  if (!instant) throw fail("BAD_REQUEST", "INVALID_DATE");
  return instant;
};

function assertInYear(iso: string, academicYear: string) {
  if (!isDateInAcademicYear(iso, academicYear)) {
    throw fail("BAD_REQUEST", "DATE_OUTSIDE_ACADEMIC_YEAR");
  }
}

export async function volunteerActivityCreate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof volunteerActivityCreateInput>,
  now: Date = new Date(),
) {
  await assertCanWrite(db, actorUserID, input.ccaID, input.academicYear);
  return db.$transaction(async (tx) => {
    if (
      (await activeCount(tx, input.ccaID, input.academicYear)) >=
      MAX_VOLUNTEER_ACTIVITIES
    ) {
      throw fail("CONFLICT", `AT_MOST_${MAX_VOLUNTEER_ACTIVITIES}_ACTIVITIES`);
    }
    const activity = await tx.volunteerActivity.create({
      data: {
        academicYear: input.academicYear,
        ccaID: input.ccaID,
        title: input.title,
        kind: input.kind,
        description: blank(input.description),
        defaultHours: input.defaultHours ?? null,
        createdBy: actorUserID,
        createdAt: now,
      },
    });
    if (input.kind === "oneoff") {
      await tx.volunteerSession.create({
        data: {
          activityID: activity.id,
          academicYear: input.academicYear,
          ccaID: input.ccaID,
          date: sessionDate(input.date!),
          hours: input.hours!,
          createdBy: actorUserID,
          createdAt: now,
        },
      });
    }
    return { id: activity.id };
  });
}

export async function volunteerActivityUpdate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof volunteerActivityUpdateInput>,
  now: Date = new Date(),
) {
  const activity = await requireActivity(db, input.id, input.ccaID);
  await assertCanWrite(db, actorUserID, input.ccaID, activity.academicYear);
  if (activity.removedAt) throw fail("CONFLICT", "ACTIVITY_REMOVED");
  const oneoff = readKind(activity.kind) === "oneoff";
  if (!oneoff && (input.date !== undefined || input.hours !== undefined)) {
    throw fail("BAD_REQUEST", "DATE_ONLY_FOR_ONEOFF");
  }
  if (input.date !== undefined) assertInYear(input.date, activity.academicYear);

  await db.$transaction(async (tx) => {
    await tx.volunteerActivity.update({
      where: { id: activity.id },
      data: {
        title: input.title,
        description: blank(input.description),
        defaultHours: input.defaultHours ?? null,
        updatedBy: actorUserID,
        updatedAt: now,
      },
    });
    if (oneoff && (input.date !== undefined || input.hours !== undefined)) {
      const session = await tx.volunteerSession.findFirst({
        where: { activityID: activity.id, ...NOT_REMOVED },
      });
      if (session) {
        await tx.volunteerSession.update({
          where: { id: session.id },
          data: {
            ...(input.date !== undefined && { date: sessionDate(input.date) }),
            ...(input.hours !== undefined && { hours: input.hours }),
            updatedBy: actorUserID,
            updatedAt: now,
          },
        });
      }
    }
  });
  return { id: activity.id };
}

/** Soft remove. Removing a removed activity is a no-op. */
export async function volunteerActivityRemove(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  ccaID: number,
  now: Date = new Date(),
) {
  const activity = await requireActivity(db, id, ccaID);
  await assertCanWrite(db, actorUserID, ccaID, activity.academicYear);
  if (!activity.removedAt) {
    await db.volunteerActivity.update({
      where: { id },
      data: { removedAt: now, removedBy: actorUserID },
    });
  }
  return { id };
}

/** Undo a removal, unless that would put the CCA over its limit. */
export async function volunteerActivityRestore(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  ccaID: number,
  now: Date = new Date(),
) {
  const activity = await requireActivity(db, id, ccaID);
  await assertCanWrite(db, actorUserID, ccaID, activity.academicYear);
  if (!activity.removedAt) return { id };
  return db.$transaction(async (tx) => {
    if (
      (await activeCount(tx, ccaID, activity.academicYear)) >=
      MAX_VOLUNTEER_ACTIVITIES
    ) {
      throw fail("CONFLICT", `AT_MOST_${MAX_VOLUNTEER_ACTIVITIES}_ACTIVITIES`);
    }
    await tx.volunteerActivity.update({
      where: { id },
      data: {
        removedAt: null,
        removedBy: null,
        updatedBy: actorUserID,
        updatedAt: now,
      },
    });
    return { id };
  });
}

/* ---- sessions (regular activities) ------------------------------------------- */

async function requireRegularActive(
  db: PrismaClient,
  activityID: string,
  ccaID: number,
) {
  const activity = await requireActivity(db, activityID, ccaID);
  if (activity.removedAt) throw fail("CONFLICT", "ACTIVITY_REMOVED");
  if (readKind(activity.kind) === "oneoff") {
    throw fail("CONFLICT", "ONEOFF_HAS_ONE_SESSION");
  }
  return activity;
}

export async function volunteerSessionAdd(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof volunteerSessionAddInput>,
  now: Date = new Date(),
) {
  const activity = await requireRegularActive(
    db,
    input.activityID,
    input.ccaID,
  );
  await assertCanWrite(db, actorUserID, input.ccaID, activity.academicYear);
  return db.$transaction(async (tx) => {
    const active = await tx.volunteerSession.findMany({
      where: { activityID: activity.id, ...NOT_REMOVED },
      select: { date: true, hours: true },
    });
    if (active.length >= MAX_VOLUNTEER_SESSIONS) {
      throw fail("CONFLICT", `AT_MOST_${MAX_VOLUNTEER_SESSIONS}_SESSIONS`);
    }
    const defaults = nextSessionDefaults({
      sessions: active.map((s) => ({
        date: instantToSgDate(s.date),
        hours: s.hours,
      })),
      defaultHours: activity.defaultHours,
      today: instantToSgDate(now),
      academicYear: activity.academicYear,
    });
    const date = input.date ?? defaults.date;
    assertInYear(date, activity.academicYear);
    const session = await tx.volunteerSession.create({
      data: {
        activityID: activity.id,
        academicYear: activity.academicYear,
        ccaID: activity.ccaID,
        date: sessionDate(date),
        hours: input.hours ?? defaults.hours,
        createdBy: actorUserID,
        createdAt: now,
      },
    });
    return { id: session.id, date, hours: session.hours };
  });
}

export async function volunteerSessionUpdate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof volunteerSessionUpdateInput>,
  now: Date = new Date(),
) {
  const session = await requireSession(db, input.sessionID, input.ccaID);
  await assertCanWrite(db, actorUserID, input.ccaID, session.academicYear);
  if (session.removedAt) throw fail("CONFLICT", "SESSION_REMOVED");
  if (input.date !== undefined) assertInYear(input.date, session.academicYear);
  await db.volunteerSession.update({
    where: { id: session.id },
    data: {
      ...(input.date !== undefined && { date: sessionDate(input.date) }),
      ...(input.hours !== undefined && { hours: input.hours }),
      updatedBy: actorUserID,
      updatedAt: now,
    },
  });
  return { id: session.id };
}

async function sessionOfRegular(
  db: PrismaClient,
  sessionID: string,
  ccaID: number,
) {
  const session = await requireSession(db, sessionID, ccaID);
  await requireRegularActive(db, session.activityID, ccaID);
  return session;
}

export async function volunteerSessionRemove(
  db: PrismaClient,
  actorUserID: string,
  sessionID: string,
  ccaID: number,
  now: Date = new Date(),
) {
  const session = await sessionOfRegular(db, sessionID, ccaID);
  await assertCanWrite(db, actorUserID, ccaID, session.academicYear);
  if (!session.removedAt) {
    await db.volunteerSession.update({
      where: { id: sessionID },
      data: { removedAt: now, removedBy: actorUserID },
    });
  }
  return { id: sessionID };
}

export async function volunteerSessionRestore(
  db: PrismaClient,
  actorUserID: string,
  sessionID: string,
  ccaID: number,
  now: Date = new Date(),
) {
  const session = await sessionOfRegular(db, sessionID, ccaID);
  await assertCanWrite(db, actorUserID, ccaID, session.academicYear);
  if (!session.removedAt) return { id: sessionID };
  return db.$transaction(async (tx) => {
    if (
      (await activeSessionCount(tx, session.activityID)) >=
      MAX_VOLUNTEER_SESSIONS
    ) {
      throw fail("CONFLICT", `AT_MOST_${MAX_VOLUNTEER_SESSIONS}_SESSIONS`);
    }
    await tx.volunteerSession.update({
      where: { id: sessionID },
      data: {
        removedAt: null,
        removedBy: null,
        updatedBy: actorUserID,
        updatedAt: now,
      },
    });
    return { id: sessionID };
  });
}

/** Up to 300 people or 20,000 ticks, one write each: more than the default 5 seconds. */
const SAVE_TX = { timeout: 30_000, maxWait: 10_000 } as const;

/* ---- people ---------------------------------------------------------------- */

/**
 * REPLACE the activity's active people with the list given: new people are
 * added, missing ones soft-removed, a removed person listed again gets their
 * row back. Each must be an existing resident. Their ticks are kept either way,
 * but only active people count.
 */
export async function volunteerPeopleSet(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof volunteerPeopleSetInput>,
  now: Date = new Date(),
) {
  const activity = await requireActivity(db, input.activityID, input.ccaID);
  if (activity.removedAt) throw fail("CONFLICT", "ACTIVITY_REMOVED");
  if (firstDuplicate(input.userIDs)) {
    throw fail("BAD_REQUEST", "DUPLICATE_PARTICIPANT");
  }
  const keys = await Promise.all(
    input.userIDs.map(async (id) => (await requireResident(db, id)).key),
  );
  if (firstDuplicate(keys)) throw fail("BAD_REQUEST", "DUPLICATE_PARTICIPANT");
  const wanted = new Set(keys);

  // Who this change touches: people added or restored, and people dropped.
  const stored = await db.volunteerPerson.findMany({
    where: { activityID: activity.id },
  });
  const storedBy = new Map(stored.map((e) => [e.userID, e]));
  const summaries = [
    ...keys
      .filter((k) => !storedBy.has(k) || storedBy.get(k)!.removedAt)
      .map((userID) => ({
        userID,
        summary: correctionSummary("Volunteer hours", activity.title, "added"),
      })),
    ...stored
      .filter((e) => !e.removedAt && !wanted.has(e.userID))
      .map((e) => ({
        userID: e.userID,
        summary: correctionSummary(
          "Volunteer hours",
          activity.title,
          "removed",
        ),
      })),
  ];
  const guard = await assertCanWriteForResidents(
    db,
    actorUserID,
    input.ccaID,
    activity.academicYear,
    summaries.map((x) => x.userID),
  );

  const result = await db.$transaction(async (tx) => {
    const existing = await tx.volunteerPerson.findMany({
      where: { activityID: activity.id },
    });
    const byUser = new Map(existing.map((e) => [e.userID, e]));
    let added = 0;
    let removed = 0;
    for (const key of keys) {
      const row = byUser.get(key);
      if (!row) {
        await tx.volunteerPerson.create({
          data: {
            activityID: activity.id,
            academicYear: activity.academicYear,
            ccaID: activity.ccaID,
            userID: key,
            addedBy: actorUserID,
            addedAt: now,
          },
        });
        added += 1;
      } else if (row.removedAt) {
        await tx.volunteerPerson.update({
          where: { id: row.id },
          data: { removedAt: null, removedBy: null },
        });
        added += 1;
      }
    }
    for (const row of existing) {
      if (!row.removedAt && !wanted.has(row.userID)) {
        await tx.volunteerPerson.update({
          where: { id: row.id },
          data: { removedAt: now, removedBy: actorUserID },
        });
        removed += 1;
      }
    }
    await tx.volunteerActivity.update({
      where: { id: activity.id },
      data: { updatedBy: actorUserID, updatedAt: now },
    });
    const out = { id: activity.id, added, removed };
    await logCorrections(
      tx,
      guard,
      actorUserID,
      activity.academicYear,
      summaries,
      now,
    );
    return out;
  }, SAVE_TX);
  return result;
}

/* ---- attendance ----------------------------------------------------------- */

/**
 * Apply a batch of ticks and un-ticks in ONE transaction. Each change must name
 * an ACTIVE session and an ACTIVE person of this activity; one that does not
 * rejects the whole batch and changes nothing. For a tick, an omitted override
 * keeps the existing one and null clears it.
 */
export async function volunteerAttendanceSave(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof volunteerAttendanceSaveInput>,
  now: Date = new Date(),
) {
  const activity = await requireActivity(db, input.activityID, input.ccaID);
  if (activity.removedAt) throw fail("CONFLICT", "ACTIVITY_REMOVED");

  const pairs = input.changes.map((c) => `${c.sessionID}:${c.userID}`);
  if (firstDuplicate(pairs)) throw fail("BAD_REQUEST", "DUPLICATE_CHANGE");

  // Who this change touches: everyone named in the change set.
  const perUser = new Map<string, number>();
  for (const c of input.changes) {
    perUser.set(c.userID, (perUser.get(c.userID) ?? 0) + 1);
  }
  const summaries = [...perUser].map(([userID, count]) => ({
    userID,
    summary: correctionSummary(
      "Volunteer hours",
      activity.title,
      `attendance changed (${count} ${count === 1 ? "session" : "sessions"})`,
    ),
  }));
  const guard = await assertCanWriteForResidents(
    db,
    actorUserID,
    input.ccaID,
    activity.academicYear,
    [...perUser.keys()],
  );

  const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const [sessions, people, existing] = await Promise.all([
      tx.volunteerSession.findMany({
        where: { activityID: activity.id, ...NOT_REMOVED },
        select: { id: true },
      }),
      tx.volunteerPerson.findMany({
        where: { activityID: activity.id, ...NOT_REMOVED },
        select: { userID: true },
      }),
      tx.volunteerAttendance.findMany({ where: { activityID: activity.id } }),
    ]);
    const liveSessions = new Set(sessions.map((s) => s.id));
    const livePeople = new Set(people.map((p) => p.userID));
    for (const c of input.changes) {
      if (!liveSessions.has(c.sessionID) || !livePeople.has(c.userID)) {
        throw fail("BAD_REQUEST", "INVALID_ATTENDANCE");
      }
    }

    const have = new Map(
      existing.map((e) => [`${e.sessionID}:${e.userID}`, e]),
    );
    const toDelete: string[] = [];
    const toCreate: Prisma.VolunteerAttendanceCreateManyInput[] = [];
    const toUpdate: Array<{ id: string; hoursOverride: number | null }> = [];
    for (const c of input.changes) {
      const row = have.get(`${c.sessionID}:${c.userID}`);
      if (!c.attended) {
        if (row) toDelete.push(row.id);
      } else if (!row) {
        toCreate.push({
          sessionID: c.sessionID,
          activityID: activity.id,
          academicYear: activity.academicYear,
          ccaID: activity.ccaID,
          userID: c.userID,
          hoursOverride: c.hoursOverride ?? null,
          markedBy: actorUserID,
          markedAt: now,
        });
      } else if (
        c.hoursOverride !== undefined &&
        (row.hoursOverride ?? null) !== c.hoursOverride
      ) {
        toUpdate.push({ id: row.id, hoursOverride: c.hoursOverride });
      }
    }

    if (toDelete.length > 0) {
      await tx.volunteerAttendance.deleteMany({
        where: { id: { in: toDelete } },
      });
    }
    if (toCreate.length > 0) {
      await tx.volunteerAttendance.createMany({ data: toCreate });
    }
    for (const u of toUpdate) {
      await tx.volunteerAttendance.update({
        where: { id: u.id },
        data: {
          hoursOverride: u.hoursOverride,
          markedBy: actorUserID,
          markedAt: now,
        },
      });
    }
    const out = {
      created: toCreate.length,
      updated: toUpdate.length,
      deleted: toDelete.length,
    };
    await logCorrections(
      tx,
      guard,
      actorUserID,
      activity.academicYear,
      summaries,
      now,
    );
    return out;
  }, SAVE_TX);
  return result;
}
