import type { PrismaClient } from "@prisma/client";
import type { z } from "zod";
import type { jcrcSaveForInput } from "~/lib/transcript/manageInput";
import { NOT_VOIDED } from "./loader";
import { assertWritable, requireCca } from "./manageAccess";
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
