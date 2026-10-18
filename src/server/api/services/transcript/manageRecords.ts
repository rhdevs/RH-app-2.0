import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { correctionSummary } from "~/lib/transcript/corrections";
import type { jcrcSaveForInput } from "~/lib/transcript/manageInput";
import { NOT_VOIDED } from "./loader";
import { requireCca } from "./manageAccess";
import {
  assertCanEditForResidents,
  assertStillCollecting,
  logCorrections,
} from "./residentRecords";
import {
  actorLabels,
  keysOf,
  lookupResidents,
  requireResident,
} from "./residents";

/**
 * The manager-side records: which CCAs are volunteering CCAs, Colours Awards,
 * and JCRC service records. Awards are voided, never deleted.
 */

/* ---- volunteering tags --------------------------------------------------- */

export async function ccaTagsList(db: PrismaClient) {
  const [ccas, profiles] = await Promise.all([
    db.cCA.findMany({ orderBy: { ccaName: "asc" } }),
    db.ccaProfile.findMany({ select: { ccaID: true, isVolunteering: true } }),
  ]);
  const tagged = new Map(
    profiles.map((p) => [p.ccaID, p.isVolunteering === true]),
  );
  return ccas.map((c) => ({
    ccaID: c.ccaID,
    ccaName: c.ccaName,
    category: c.category,
    isVolunteering: tagged.get(c.ccaID) ?? false,
  }));
}

/**
 * Tag or untag a volunteering CCA. Touches ONLY isVolunteering, updatedAt and
 * updatedBy on CcaProfile: never the description, logo or banner a head wrote.
 * Not tied to an academic year, so it is allowed at any time.
 */
export async function setVolunteering(
  db: PrismaClient,
  actorUserID: string,
  ccaID: number,
  isVolunteering: boolean,
  now: Date = new Date(),
) {
  await requireCca(db, ccaID);
  const stamp = { isVolunteering, updatedAt: now, updatedBy: actorUserID };
  await db.ccaProfile.upsert({
    where: { ccaID },
    create: { ccaID, ...stamp },
    update: stamp,
  });
  return { ccaID, isVolunteering };
}

/* ---- JCRC service -------------------------------------------------------- */

type JcrcFields = Omit<z.infer<typeof jcrcSaveForInput>, "userID">;

/**
 * Save a JCRC service record for the resident filed under `key`. `isPlaceholder`
 * is never touched (a new record takes the model's default, true). Stamps who
 * saved it (`actorUserID`: the member, or the manager acting for them) and when.
 */
export async function jcrcSave(
  db: PrismaClient,
  actorUserID: string,
  key: string,
  fields: JcrcFields,
  now: Date = new Date(),
) {
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    { academicYear: fields.academicYear, affectedUserIDs: [key] },
  );
  const current = await db.jcrcService.findUnique({
    where: {
      academicYear_userID: { academicYear: fields.academicYear, userID: key },
    },
    select: { removedAt: true },
  });
  if (current?.removedAt) {
    throw new TRPCError({ code: "CONFLICT", message: "JCRC_PAGE_REMOVED" });
  }
  const data = {
    portfolio: fields.portfolio,
    position: fields.position,
    description: fields.description,
    // A blank role or description is stored as absent, not as an empty string.
    contributions: fields.contributions.map((c) => ({
      activity: c.activity,
      role: c.role === "" ? null : c.role,
      description: c.description === "" ? null : c.description,
    })),
    testimonial: fields.testimonial,
    updatedAt: now,
    updatedBy: actorUserID,
  };
  await db.$transaction(async (tx) => {
    await assertStillCollecting(tx, fields.academicYear, guard);
    await tx.jcrcService.upsert({
      where: {
        academicYear_userID: { academicYear: fields.academicYear, userID: key },
      },
      create: { academicYear: fields.academicYear, userID: key, ...data },
      update: data,
    });
    await logCorrections(
      tx,
      guard,
      actorUserID,
      fields.academicYear,
      [
        {
          userID: key,
          summary: correctionSummary(
            "JCRC page",
            fields.position.trim() ? fields.position : "record",
            "saved",
          ),
        },
      ],
      now,
    );
  });
  return jcrcGet(db, key, fields.academicYear);
}

/**
 * Take a member's JCRC page off their transcript (soft: removedAt/removedBy,
 * never deleted) or put it back. A manager's act; in a published year the
 * resident must be unlocked, like any other correction.
 */
async function setJcrcRemoved(
  db: PrismaClient,
  actorUserID: string,
  fields: { userID: string; academicYear: string },
  removed: boolean,
  now: Date,
) {
  const resident = await requireResident(db, fields.userID);
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    { academicYear: fields.academicYear, affectedUserIDs: [resident.key] },
  );
  const row = await db.jcrcService.findUnique({
    where: {
      academicYear_userID: {
        academicYear: fields.academicYear,
        userID: resident.key,
      },
    },
  });
  if (!row)
    throw new TRPCError({ code: "NOT_FOUND", message: "RECORD_NOT_FOUND" });
  if (Boolean(row.removedAt) === removed) return { userID: resident.key };
  await db.$transaction(async (tx) => {
    await assertStillCollecting(tx, fields.academicYear, guard);
    await tx.jcrcService.update({
      where: { id: row.id },
      data: removed
        ? { removedAt: now, removedBy: actorUserID }
        : {
            removedAt: null,
            removedBy: null,
            updatedAt: now,
            updatedBy: actorUserID,
          },
    });
    await logCorrections(
      tx,
      guard,
      actorUserID,
      fields.academicYear,
      [
        {
          userID: resident.key,
          summary: correctionSummary(
            "JCRC page",
            row.position?.trim() ? row.position : "record",
            removed ? "removed" : "restored",
          ),
        },
      ],
      now,
    );
  });
  return { userID: resident.key };
}

export const jcrcRemove = (
  db: PrismaClient,
  actorUserID: string,
  fields: { userID: string; academicYear: string },
  now: Date = new Date(),
) => setJcrcRemoved(db, actorUserID, fields, true, now);

export const jcrcRestore = (
  db: PrismaClient,
  actorUserID: string,
  fields: { userID: string; academicYear: string },
  now: Date = new Date(),
) => setJcrcRemoved(db, actorUserID, fields, false, now);

export async function jcrcSaveFor(
  db: PrismaClient,
  actorUserID: string,
  fields: JcrcFields & { userID: string },
  now: Date = new Date(),
) {
  const resident = await requireResident(db, fields.userID);
  return jcrcSave(db, actorUserID, resident.key, fields, now);
}

export async function jcrcGet(
  db: PrismaClient,
  key: string,
  academicYear: string,
) {
  const row = await db.jcrcService.findUnique({
    where: { academicYear_userID: { academicYear, userID: key } },
  });
  return row
    ? {
        academicYear: row.academicYear,
        userID: row.userID,
        portfolio: row.portfolio ?? "",
        position: row.position ?? "",
        description: row.description ?? "",
        contributions: row.contributions.map((c) => ({
          activity: c.activity,
          role: c.role ?? "",
          description: c.description ?? "",
        })),
        testimonial: row.testimonial ?? "",
        isPlaceholder: row.isPlaceholder ?? true,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        removed: row.removedAt != null,
        removedAt: row.removedAt ?? null,
        removedBy: row.removedBy ?? null,
      }
    : null;
}
