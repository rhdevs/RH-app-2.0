import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
  MAX_ACTIVITIES,
  MAX_PARTICIPANTS,
  diffParticipants,
  firstDuplicate,
  readPeriod,
  type ActivityPeriod,
  type DesiredParticipant,
} from "~/lib/transcript/activities";
import type {
  activityCreateInput,
  activityUpdateInput,
  participantsSetInput,
} from "~/lib/transcript/manageInput";
import { participantSummaries } from "~/lib/transcript/corrections";
import { NOT_REMOVED } from "./loader";
import { assertCanEditForResidents, logCorrections } from "./residentRecords";
import { actorLabels, lookupResidents, requireResident } from "./residents";

/**
 * A CCA's ACTIVITIES for one academic year, and who took part in each.
 *
 * The caller has already checked access and called `assertCanEditCcaYear` for
 * every write. Nothing here is ever deleted: removing an activity or a
 * participant sets removedAt/removedBy, and a removed row never renders on a
 * transcript. Everything is an additive record in our own collections.
 */

const fail = (
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
  message: string,
) => new TRPCError({ code, message });

export interface ActivityParticipantView {
  userID: string;
  displayName: string | null;
  role: string;
  description: string;
}

export interface ActivityView {
  id: string;
  title: string;
  description: string;
  period: ActivityPeriod;
  removed: boolean;
  createdByName: string | null;
  createdAt: Date | null;
  updatedByName: string | null;
  updatedAt: Date | null;
  removedByName: string | null;
  removedAt: Date | null;
  participants: ActivityParticipantView[];
}

export interface ActivityList {
  /** Active (not removed) activities: the number the 20 limit counts. */
  activeCount: number;
  max: number;
  activities: ActivityView[];
}

const activeCount = (
  db: Pick<PrismaClient, "ccaActivity">,
  ccaID: number,
  academicYear: string,
) => db.ccaActivity.count({ where: { academicYear, ccaID, ...NOT_REMOVED } });

/** The activities of one CCA and year, with their active participants. */
export async function activitiesList(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
  includeRemoved: boolean,
): Promise<ActivityList> {
  const [rows, count] = await Promise.all([
    db.ccaActivity.findMany({
      where: {
        academicYear,
        ccaID,
        ...(includeRemoved ? {} : NOT_REMOVED),
      },
      orderBy: { createdAt: "asc" },
    }),
    activeCount(db, ccaID, academicYear),
  ]);
  const people = await db.ccaActivityParticipant.findMany({
    where: {
      activityID: { in: rows.map((r) => r.id) },
      ...NOT_REMOVED,
    },
    orderBy: { addedAt: "asc" },
  });

  const [names, label] = await Promise.all([
    lookupResidents(
      db,
      people.map((p) => p.userID),
    ),
    actorLabels(
      db,
      rows.flatMap((r) => [r.createdBy, r.updatedBy, r.removedBy]),
    ),
  ]);

  const byActivity = new Map<string, ActivityParticipantView[]>();
  for (const p of people) {
    const list = byActivity.get(p.activityID) ?? [];
    list.push({
      userID: p.userID,
      displayName: names.get(p.userID)?.displayName ?? null,
      role: p.role ?? "",
      description: p.description ?? "",
    });
    byActivity.set(p.activityID, list);
  }

  return {
    activeCount: count,
    max: MAX_ACTIVITIES,
    activities: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description ?? "",
      period: readPeriod(r.period),
      removed: r.removedAt != null,
      createdByName: label(r.createdBy),
      createdAt: r.createdAt ?? null,
      updatedByName: label(r.updatedBy),
      updatedAt: r.updatedAt ?? null,
      removedByName: label(r.removedBy),
      removedAt: r.removedAt ?? null,
      participants: byActivity.get(r.id) ?? [],
    })),
  };
}

/** The activity, for the CCA the caller named; NOT_FOUND for any other CCA. */
async function requireActivity(db: PrismaClient, id: string, ccaID: number) {
  const row = await db.ccaActivity.findUnique({ where: { id } });
  if (!row || row.ccaID !== ccaID) {
    throw fail("NOT_FOUND", "ACTIVITY_NOT_FOUND");
  }
  return row;
}

const tooMany = () => fail("CONFLICT", `AT_MOST_${MAX_ACTIVITIES}_ACTIVITIES`);

export async function activityCreate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof activityCreateInput>,
  now: Date = new Date(),
) {
  return db.$transaction(async (tx) => {
    if (
      (await activeCount(tx, input.ccaID, input.academicYear)) >= MAX_ACTIVITIES
    ) {
      throw tooMany();
    }
    const row = await tx.ccaActivity.create({
      data: {
        academicYear: input.academicYear,
        ccaID: input.ccaID,
        title: input.title,
        description: input.description === "" ? null : input.description,
        period: input.period,
        createdBy: actorUserID,
        createdAt: now,
      },
    });
    return { id: row.id, academicYear: row.academicYear };
  });
}

/** The year an activity belongs to, so the caller can run the edit guard on it. */
export async function activityYear(
  db: PrismaClient,
  id: string,
  ccaID: number,
): Promise<string> {
  return (await requireActivity(db, id, ccaID)).academicYear;
}

export async function activityUpdate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof activityUpdateInput>,
  now: Date = new Date(),
) {
  const row = await requireActivity(db, input.id, input.ccaID);
  if (row.removedAt) throw fail("CONFLICT", "ACTIVITY_REMOVED");
  await db.ccaActivity.update({
    where: { id: row.id },
    data: {
      title: input.title,
      description: input.description === "" ? null : input.description,
      period: input.period,
      updatedBy: actorUserID,
      updatedAt: now,
    },
  });
  return { id: row.id };
}

/** Soft remove. Removing a removed activity is a no-op. */
export async function activityRemove(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  ccaID: number,
  now: Date = new Date(),
) {
  const row = await requireActivity(db, id, ccaID);
  if (!row.removedAt) {
    await db.ccaActivity.update({
      where: { id },
      data: { removedAt: now, removedBy: actorUserID },
    });
  }
  return { id };
}

/** Undo a removal, unless that would put the CCA over the limit. */
export async function activityRestore(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  ccaID: number,
  now: Date = new Date(),
) {
  const row = await requireActivity(db, id, ccaID);
  if (!row.removedAt) return { id };
  return db.$transaction(async (tx) => {
    if ((await activeCount(tx, ccaID, row.academicYear)) >= MAX_ACTIVITIES) {
      throw tooMany();
    }
    await tx.ccaActivity.update({
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

/**
 * Resolve the wanted people to existing residents, under their canonical key.
 * A key that names nobody is rejected; two keys that name the same person are a
 * duplicate.
 */
async function resolveDesired(
  db: PrismaClient,
  rows: z.infer<typeof participantsSetInput>["participants"],
): Promise<DesiredParticipant[]> {
  const typed = firstDuplicate(rows.map((r) => r.userID));
  if (typed) throw fail("BAD_REQUEST", "DUPLICATE_PARTICIPANT");
  const keys = await Promise.all(
    rows.map((r) => requireResident(db, r.userID)),
  );
  const resolved = rows.map((r, i) => ({
    userID: keys[i]!.key,
    role: r.role,
    description: r.description,
  }));
  if (firstDuplicate(resolved.map((r) => r.userID))) {
    throw fail("BAD_REQUEST", "DUPLICATE_PARTICIPANT");
  }
  return resolved;
}

/** Up to 200 people, one write each: more than Prisma's default 5 seconds. */
const PEOPLE_TX = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * REPLACE the activity's active participants with the list given, in one
 * transaction: new people are added, people missing are soft-removed, a person
 * removed earlier and listed again gets their row back, and a row is rewritten
 * only if its role or description changed. Anyone in the hall may take part.
 */
export async function participantsSet(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof participantsSetInput>,
  now: Date = new Date(),
) {
  if (input.participants.length > MAX_PARTICIPANTS) {
    throw fail("BAD_REQUEST", `AT_MOST_${MAX_PARTICIPANTS}_PARTICIPANTS`);
  }
  const activity = await requireActivity(db, input.id, input.ccaID);
  if (activity.removedAt) throw fail("CONFLICT", "ACTIVITY_REMOVED");
  const desired = await resolveDesired(db, input.participants);

  const asExisting = (
    rows: Awaited<ReturnType<typeof db.ccaActivityParticipant.findMany>>,
  ) =>
    rows.map((e) => ({
      id: e.id,
      userID: e.userID,
      role: e.role ?? null,
      description: e.description ?? null,
      removed: e.removedAt != null,
    }));
  // Who this change touches, worked out here from the stored rows: the guard
  // lets a manager correct a PUBLISHED year only for residents it names.
  const planned = diffParticipants(
    asExisting(
      await db.ccaActivityParticipant.findMany({
        where: { activityID: activity.id },
      }),
    ),
    desired,
  );
  const summaries = participantSummaries("Activities", activity.title, planned);
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      ccaID: activity.ccaID,
      academicYear: activity.academicYear,
      affectedUserIDs: summaries.map((s) => s.userID),
    },
  );

  const result = await db.$transaction(async (tx) => {
    const existing = await tx.ccaActivityParticipant.findMany({
      where: { activityID: activity.id },
    });
    const diff = diffParticipants(asExisting(existing), desired);
    const text = (d: DesiredParticipant) => ({
      role: d.role === "" ? null : d.role,
      description: d.description === "" ? null : d.description,
    });

    for (const d of diff.add) {
      await tx.ccaActivityParticipant.create({
        data: {
          activityID: activity.id,
          academicYear: activity.academicYear,
          ccaID: activity.ccaID,
          userID: d.userID,
          ...text(d),
          addedBy: actorUserID,
          addedAt: now,
        },
      });
    }
    for (const d of diff.restore) {
      await tx.ccaActivityParticipant.update({
        where: { id: d.id },
        data: {
          ...text(d),
          removedAt: null,
          removedBy: null,
          updatedBy: actorUserID,
          updatedAt: now,
        },
      });
    }
    for (const d of diff.update) {
      await tx.ccaActivityParticipant.update({
        where: { id: d.id },
        data: { ...text(d), updatedBy: actorUserID, updatedAt: now },
      });
    }
    for (const r of diff.remove) {
      await tx.ccaActivityParticipant.update({
        where: { id: r.id },
        data: { removedAt: now, removedBy: actorUserID },
      });
    }
    await tx.ccaActivity.update({
      where: { id: activity.id },
      data: { updatedBy: actorUserID, updatedAt: now },
    });
    return {
      id: activity.id,
      added: diff.add.length + diff.restore.length,
      updated: diff.update.length,
      removed: diff.remove.length,
      unchanged: diff.unchanged,
    };
  }, PEOPLE_TX);
  await logCorrections(
    db,
    guard,
    actorUserID,
    activity.academicYear,
    summaries,
    now,
  );
  return result;
}
