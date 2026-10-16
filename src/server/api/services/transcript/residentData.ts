import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
  diffParticipants,
  readPeriod,
  type ActivityPeriod,
} from "~/lib/transcript/activities";
import { participantSummaries } from "~/lib/transcript/corrections";
import type {
  activityOptionsInput,
  awardsOfInput,
  participationRemoveInput,
  participationSetInput,
  residentScope,
} from "~/lib/transcript/residentInput";
import { instantToSgDate } from "~/lib/transcript/sgDate";
import {
  creditedHours,
  readKind,
  type VolunteerKind,
} from "~/lib/transcript/volunteer";
import { loadResidentCcaIDs, NOT_REMOVED, NOT_VOIDED } from "./loader";
import { assertCanEditForResidents, logCorrections } from "./residentRecords";
import { actorLabels, requireResident } from "./residents";

/**
 * What one resident has in each part of a year, for the correction screens, and
 * the one-person edits that need no screen of their own in the head tools (the
 * activity participation of ONE resident, on an activity of ANY CCA).
 *
 * Reads never change anything. Writes run the per-resident guard, so in a
 * published year they need the resident to be unlocked.
 */

const fail = (
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
  message: string,
) => new TRPCError({ code, message });

type Scope = z.infer<typeof residentScope>;

/* ---- activities they take part in ------------------------------------------ */

export interface ParticipationItem {
  activityID: string;
  ccaID: number;
  ccaName: string;
  title: string;
  period: ActivityPeriod;
  activityDescription: string;
  role: string;
  description: string;
  /** The resident's participation was removed. */
  removed: boolean;
  /** The activity itself was removed (it is on no transcript). */
  activityRemoved: boolean;
  /** The resident is a member of this CCA this year (else "Other involvement"). */
  isMember: boolean;
}

export async function participationList(
  db: PrismaClient,
  input: Scope,
  now: Date = new Date(),
): Promise<ParticipationItem[]> {
  const { key, memberCcaIDs } = await loadResidentCcaIDs(
    db,
    input.userID,
    input.academicYear,
    { now },
  );
  const mine = await db.ccaActivityParticipant.findMany({
    where: { academicYear: input.academicYear, userID: key },
  });
  if (mine.length === 0) return [];
  const activities = await db.ccaActivity.findMany({
    where: { id: { in: mine.map((p) => p.activityID) } },
  });
  const ccas = await db.cCA.findMany({
    where: { ccaID: { in: [...new Set(activities.map((a) => a.ccaID))] } },
    select: { ccaID: true, ccaName: true },
  });
  const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  const person = new Map(mine.map((p) => [p.activityID, p]));
  return activities
    .flatMap((a): ParticipationItem[] => {
      const p = person.get(a.id);
      const name = ccaName.get(a.ccaID);
      if (!p || !name) return [];
      return [
        {
          activityID: a.id,
          ccaID: a.ccaID,
          ccaName: name,
          title: a.title,
          period: readPeriod(a.period),
          activityDescription: a.description ?? "",
          role: p.role ?? "",
          description: p.description ?? "",
          removed: p.removedAt != null,
          activityRemoved: a.removedAt != null,
          isMember: memberCcaIDs.has(a.ccaID),
        },
      ];
    })
    .sort(
      (a, b) =>
        a.ccaName.localeCompare(b.ccaName, "en") ||
        a.title.localeCompare(b.title, "en"),
    );
}

export interface ActivityOption {
  id: string;
  ccaID: number;
  ccaName: string;
  title: string;
}

/** Every live activity of the year, for "add to an existing activity". */
export async function activityOptions(
  db: PrismaClient,
  input: z.infer<typeof activityOptionsInput>,
): Promise<ActivityOption[]> {
  const rows = await db.ccaActivity.findMany({
    where: { academicYear: input.academicYear, ...NOT_REMOVED },
  });
  const ccas = await db.cCA.findMany({
    where: { ccaID: { in: [...new Set(rows.map((r) => r.ccaID))] } },
    select: { ccaID: true, ccaName: true },
  });
  const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  return rows
    .flatMap((r): ActivityOption[] => {
      const name = ccaName.get(r.ccaID);
      return name
        ? [{ id: r.id, ccaID: r.ccaID, ccaName: name, title: r.title }]
        : [];
    })
    .sort(
      (a, b) =>
        a.ccaName.localeCompare(b.ccaName, "en") ||
        a.title.localeCompare(b.title, "en"),
    );
}

async function requireLiveActivity(
  db: PrismaClient,
  id: string,
  academicYear: string,
) {
  const activity = await db.ccaActivity.findUnique({ where: { id } });
  if (!activity || activity.academicYear !== academicYear) {
    throw fail("NOT_FOUND", "ACTIVITY_NOT_FOUND");
  }
  if (activity.removedAt) throw fail("CONFLICT", "ACTIVITY_REMOVED");
  return activity;
}

/**
 * Add the resident to an activity, or change their role and description, or
 * bring back a removed participation. Only this resident's row is touched.
 */
export async function participationSet(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof participationSetInput>,
  now: Date = new Date(),
) {
  const resident = await requireResident(db, input.userID);
  const activity = await requireLiveActivity(
    db,
    input.activityID,
    input.academicYear,
  );
  const row = await db.ccaActivityParticipant.findFirst({
    where: { activityID: activity.id, userID: resident.key },
  });
  const planned = diffParticipants(
    row
      ? [
          {
            id: row.id,
            userID: row.userID,
            role: row.role ?? null,
            description: row.description ?? null,
            removed: row.removedAt != null,
          },
        ]
      : [],
    [
      {
        userID: resident.key,
        role: input.role,
        description: input.description,
      },
    ],
  );
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      ccaID: activity.ccaID,
      academicYear: activity.academicYear,
      affectedUserIDs: [resident.key],
    },
  );
  const text = {
    role: input.role === "" ? null : input.role,
    description: input.description === "" ? null : input.description,
  };
  await db.$transaction(async (tx) => {
    if (!row) {
      await tx.ccaActivityParticipant.create({
        data: {
          activityID: activity.id,
          academicYear: activity.academicYear,
          ccaID: activity.ccaID,
          userID: resident.key,
          ...text,
          addedBy: actorUserID,
          addedAt: now,
        },
      });
    } else if (row.removedAt) {
      await tx.ccaActivityParticipant.update({
        where: { id: row.id },
        data: {
          ...text,
          removedAt: null,
          removedBy: null,
          updatedBy: actorUserID,
          updatedAt: now,
        },
      });
    } else if (planned.update.length > 0) {
      await tx.ccaActivityParticipant.update({
        where: { id: row.id },
        data: { ...text, updatedBy: actorUserID, updatedAt: now },
      });
    }
    if (
      planned.add.length + planned.restore.length + planned.update.length >
      0
    ) {
      await tx.ccaActivity.update({
        where: { id: activity.id },
        data: { updatedBy: actorUserID, updatedAt: now },
      });
    }
    await logCorrections(
      tx,
      guard,
      actorUserID,
      activity.academicYear,
      participantSummaries("Activities", activity.title, planned),
      now,
    );
  });
  return { activityID: activity.id, userID: resident.key };
}

/** Take the resident off an activity (soft: it can be restored by setting it again). */
export async function participationRemove(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof participationRemoveInput>,
  now: Date = new Date(),
) {
  const resident = await requireResident(db, input.userID);
  const activity = await requireLiveActivity(
    db,
    input.activityID,
    input.academicYear,
  );
  const row = await db.ccaActivityParticipant.findFirst({
    where: { activityID: activity.id, userID: resident.key },
  });
  if (!row) throw fail("NOT_FOUND", "RECORD_NOT_FOUND");
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      ccaID: activity.ccaID,
      academicYear: activity.academicYear,
      affectedUserIDs: [resident.key],
    },
  );
  await db.$transaction(async (tx) => {
    if (!row.removedAt) {
      await tx.ccaActivityParticipant.update({
        where: { id: row.id },
        data: { removedAt: now, removedBy: actorUserID },
      });
      await tx.ccaActivity.update({
        where: { id: activity.id },
        data: { updatedBy: actorUserID, updatedAt: now },
      });
      await logCorrections(
        tx,
        guard,
        actorUserID,
        activity.academicYear,
        participantSummaries("Activities", activity.title, {
          add: [],
          restore: [],
          update: [],
          remove: [{ userID: resident.key }],
        }),
        now,
      );
    }
  });
  return { activityID: activity.id, userID: resident.key };
}

/* ---- volunteer hours --------------------------------------------------------- */

export interface VolunteerCell {
  sessionID: string;
  /** Singapore calendar date, "2026-10-03". */
  date: string;
  hours: number;
  ticked: boolean;
  hoursOverride: number | null;
}

export interface VolunteerItem {
  activityID: string;
  ccaID: number;
  ccaName: string;
  title: string;
  kind: VolunteerKind;
  totalHours: number;
  sessions: VolunteerCell[];
}

/** The volunteer activities the resident is a person of, with a cell per session. */
export async function volunteerOf(
  db: PrismaClient,
  input: Scope,
): Promise<VolunteerItem[]> {
  const resident = await requireResident(db, input.userID);
  const people = await db.volunteerPerson.findMany({
    where: {
      academicYear: input.academicYear,
      userID: resident.key,
      ...NOT_REMOVED,
    },
    select: { activityID: true },
  });
  if (people.length === 0) return [];
  const ids = people.map((p) => p.activityID);
  const [activities, sessions, ticks] = await Promise.all([
    db.volunteerActivity.findMany({
      where: { id: { in: ids }, ...NOT_REMOVED },
    }),
    db.volunteerSession.findMany({
      where: { activityID: { in: ids }, ...NOT_REMOVED },
      orderBy: { date: "asc" },
    }),
    db.volunteerAttendance.findMany({
      where: { userID: resident.key, activityID: { in: ids } },
    }),
  ]);
  const ccas = await db.cCA.findMany({
    where: { ccaID: { in: [...new Set(activities.map((a) => a.ccaID))] } },
    select: { ccaID: true, ccaName: true },
  });
  const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  const tickOf = new Map(ticks.map((t) => [t.sessionID, t]));
  return activities
    .flatMap((a): VolunteerItem[] => {
      const name = ccaName.get(a.ccaID);
      if (!name) return [];
      const cells = sessions
        .filter((s) => s.activityID === a.id)
        .map((s): VolunteerCell => {
          const t = tickOf.get(s.id);
          return {
            sessionID: s.id,
            date: instantToSgDate(s.date),
            hours: s.hours,
            ticked: t !== undefined,
            hoursOverride: t?.hoursOverride ?? null,
          };
        });
      const total = cells.reduce(
        (sum, c) =>
          sum + (c.ticked ? creditedHours(c.hours, c.hoursOverride) : 0),
        0,
      );
      return [
        {
          activityID: a.id,
          ccaID: a.ccaID,
          ccaName: name,
          title: a.title,
          kind: readKind(a.kind),
          totalHours: Math.round(total * 100) / 100,
          sessions: cells,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.ccaName.localeCompare(b.ccaName, "en") ||
        a.title.localeCompare(b.title, "en"),
    );
}

/* ---- awards -------------------------------------------------------------------- */

export interface ResidentAward {
  id: string;
  title: string;
  citation: string;
  awardTypeID: string | null;
  removed: boolean;
  recordedByName: string | null;
  recordedAt: Date | null;
  updatedByName: string | null;
  updatedAt: Date | null;
  removedByName: string | null;
  removedAt: Date | null;
}

export async function awardsOf(
  db: PrismaClient,
  input: z.infer<typeof awardsOfInput>,
): Promise<ResidentAward[]> {
  const resident = await requireResident(db, input.userID);
  const rows = await db.award.findMany({
    where: {
      academicYear: input.academicYear,
      userID: resident.key,
      ...(input.includeRemoved ? {} : NOT_VOIDED),
    },
    orderBy: { recordedAt: "desc" },
  });
  const label = await actorLabels(
    db,
    rows.flatMap((r) => [r.recordedBy, r.updatedBy, r.voidedBy]),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "Award",
    citation: r.citation ?? "",
    awardTypeID: r.awardTypeID ?? null,
    removed: r.voidedAt != null,
    recordedByName: label(r.recordedBy),
    recordedAt: r.recordedAt ?? null,
    updatedByName: label(r.updatedBy),
    updatedAt: r.updatedAt ?? null,
    removedByName: label(r.voidedBy),
    removedAt: r.voidedAt ?? null,
  }));
}
