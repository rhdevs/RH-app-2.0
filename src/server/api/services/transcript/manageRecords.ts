import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import type {
  awardCreateInput,
  jcrcSaveForInput,
} from "~/lib/transcript/manageInput";
import { NOT_VOIDED } from "./loader";
import { assertWritable, requireCca } from "./manageAccess";
import { keysOf, lookupResidents, requireResident } from "./residents";

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

/* ---- awards -------------------------------------------------------------- */

export async function awardsList(
  db: PrismaClient,
  academicYear: string,
  userID: string | undefined,
  includeVoided: boolean,
) {
  const keys = userID ? await keysOf(db, userID) : null;
  const rows = await db.award.findMany({
    where: {
      academicYear,
      ...(keys ? { userID: { in: keys } } : {}),
      ...(includeVoided ? {} : NOT_VOIDED),
    },
    orderBy: { recordedAt: "desc" },
  });
  const names = await lookupResidents(db, [
    ...rows.map((r) => r.userID),
    ...rows.flatMap((r) => [r.recordedBy ?? "", r.voidedBy ?? ""]),
  ]);
  return rows.map((r) => ({
    id: r.id,
    userID: r.userID,
    displayName: names.get(r.userID)?.displayName ?? null,
    recordedByName: names.get(r.recordedBy ?? "")?.displayName ?? null,
    voidedByName: names.get(r.voidedBy ?? "")?.displayName ?? null,
    title: r.title,
    citation: r.citation,
    ceremony: r.ceremony,
    recordedBy: r.recordedBy,
    recordedAt: r.recordedAt,
    voidedAt: r.voidedAt,
    voidedBy: r.voidedBy,
  }));
}

export async function awardCreate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof awardCreateInput>,
  now: Date = new Date(),
) {
  await assertWritable(db, input.academicYear);
  const resident = await requireResident(db, input.userID);
  const row = await db.award.create({
    data: {
      academicYear: input.academicYear,
      userID: resident.key,
      title: input.title,
      citation: input.citation,
      recordedBy: actorUserID,
      recordedAt: now,
    },
  });
  return { id: row.id };
}

/** Void an award. It stays in the database, with who voided it and when. */
export async function awardVoid(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const award = await db.award.findUnique({ where: { id } });
  if (!award) {
    throw new TRPCError({ code: "NOT_FOUND", message: "RECORD_NOT_FOUND" });
  }
  await assertWritable(db, award.academicYear);
  if (!award.voidedAt) {
    await db.award.update({
      where: { id },
      data: { voidedAt: now, voidedBy: actorUserID },
    });
  }
  return { id, voided: true as const };
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
  await assertWritable(db, fields.academicYear);
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
  await db.jcrcService.upsert({
    where: {
      academicYear_userID: { academicYear: fields.academicYear, userID: key },
    },
    create: { academicYear: fields.academicYear, userID: key, ...data },
    update: data,
  });
  return jcrcGet(db, key, fields.academicYear);
}

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
      }
    : null;
}
