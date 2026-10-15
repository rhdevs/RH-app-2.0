import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import type { volunteerCreateInput } from "~/lib/transcript/manageInput";
import { NOT_VOIDED } from "./loader";
import {
  assertWritable,
  requireCcaAccess,
  requireManager,
} from "./manageAccess";
import { lookupResidents, requireResident } from "./residents";

/**
 * Volunteer hours. Recorded by the head of a VOLUNTEERING CCA (one tagged
 * CcaProfile.isVolunteering: the four "RVC ..." CCAs) or by a manager, for ANY
 * existing resident, not only that CCA's members. Never deleted: a mistake is
 * VOIDED. Every write needs the academic year to be collecting.
 */

/** The CCA must be tagged as a volunteering CCA, managers included. */
export async function requireVolunteeringCca(db: PrismaClient, ccaID: number) {
  const profile = await db.ccaProfile.findUnique({
    where: { ccaID },
    select: { isVolunteering: true },
  });
  if (profile?.isVolunteering !== true) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NOT_A_VOLUNTEERING_CCA",
    });
  }
}

export async function volunteerList(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
) {
  const rows = await db.volunteerRecord.findMany({
    where: { ccaID, academicYear, ...NOT_VOIDED },
    orderBy: { recordedAt: "desc" },
  });
  const names = await lookupResidents(db, [
    ...rows.map((r) => r.userID),
    ...rows.map((r) => r.recordedBy ?? ""),
  ]);
  return rows.map((r) => ({
    id: r.id,
    userID: r.userID,
    displayName: names.get(r.userID)?.displayName ?? null,
    kind: r.kind,
    activity: r.activity,
    activityDate: r.activityDate
      ? r.activityDate.toISOString().slice(0, 10)
      : null,
    hours: r.hours,
    recordedBy: r.recordedBy,
    recordedByName: names.get(r.recordedBy ?? "")?.displayName ?? null,
    recordedAt: r.recordedAt,
  }));
}

export async function volunteerCreate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof volunteerCreateInput>,
  now: Date = new Date(),
) {
  await assertWritable(db, input.academicYear);
  await requireVolunteeringCca(db, input.ccaID);
  const resident = await requireResident(db, input.userID);

  const row = await db.volunteerRecord.create({
    data: {
      academicYear: input.academicYear,
      userID: resident.key,
      ccaID: input.ccaID,
      kind: input.kind,
      activity: input.activity,
      // UTC midnight, so the stored calendar date reads back unchanged.
      activityDate:
        input.kind === "oneoff" && input.activityDate
          ? new Date(`${input.activityDate}T00:00:00Z`)
          : null,
      hours: input.hours,
      recordedBy: actorUserID,
      recordedAt: now,
    },
  });
  return { id: row.id };
}

/** Void (never delete). Allowed for the head of the record's CCA, or a manager. */
export async function volunteerVoid(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const record = await db.volunteerRecord.findUnique({ where: { id } });
  if (!record) {
    throw new TRPCError({ code: "NOT_FOUND", message: "RECORD_NOT_FOUND" });
  }
  if (record.ccaID === null) {
    // No CCA to head: only a manager may touch it.
    await requireManager(db, actorUserID);
  } else {
    await requireCcaAccess(db, actorUserID, record.ccaID);
  }
  await assertWritable(db, record.academicYear);
  if (record.voidedAt) return { id, voided: true as const };
  await db.volunteerRecord.update({
    where: { id },
    data: { voidedAt: now, voidedBy: actorUserID },
  });
  return { id, voided: true as const };
}
