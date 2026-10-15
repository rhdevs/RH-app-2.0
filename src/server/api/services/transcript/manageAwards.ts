import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
  cleanCitation,
  matchesSearch,
  normalizeAwardName,
  planAssignment,
} from "~/lib/transcript/awards";
import type {
  awardTypeCreateInput,
  awardTypeUpdateInput,
  awardUpdateInput,
  awardsAssignInput,
  awardsListInput,
} from "~/lib/transcript/manageInput";
import { NOT_VOIDED } from "./loader";
import { assertWritable } from "./manageAccess";
import { actorLabels, lookupResidents, requireResident } from "./residents";

/**
 * AWARDS. A catalogue of award types (not year-bound), assigned to residents for
 * a year as one `Award` each, with `title` copied at assignment so a rename never
 * changes a past award. Removing an award sets voidedAt/By ("removed" on the
 * screens); nothing is deleted. The caller has already checked the actor is a
 * manager. Every write to a year's awards needs that year not to be published;
 * the catalogue is not year-bound.
 */

const fail = (
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
  message: string,
) => new TRPCError({ code, message });

/* ---- the catalogue ----------------------------------------------------------- */

const NOT_ARCHIVED = {
  OR: [{ archivedAt: null }, { archivedAt: { isSet: false } }],
};

export async function awardTypesList(
  db: PrismaClient,
  includeArchived: boolean,
) {
  const rows = await db.awardType.findMany({
    where: includeArchived ? {} : NOT_ARCHIVED,
    orderBy: { normalizedName: "asc" },
  });
  const [used, label] = await Promise.all([
    db.award.findMany({
      where: { awardTypeID: { in: rows.map((r) => r.id) }, ...NOT_VOIDED },
      select: { awardTypeID: true },
    }),
    actorLabels(
      db,
      rows.flatMap((r) => [r.createdBy, r.updatedBy, r.archivedBy]),
    ),
  ]);
  const counts = new Map<string, number>();
  for (const u of used) {
    if (u.awardTypeID) {
      counts.set(u.awardTypeID, (counts.get(u.awardTypeID) ?? 0) + 1);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    defaultCitation: r.defaultCitation ?? "",
    archived: r.archivedAt != null,
    archivedAt: r.archivedAt ?? null,
    archivedByName: label(r.archivedBy),
    createdByName: label(r.createdBy),
    updatedByName: label(r.updatedBy),
    updatedAt: r.updatedAt ?? r.createdAt ?? null,
    /** Active awards given from this entry, in every year. */
    awardCount: counts.get(r.id) ?? 0,
  }));
}

/** Another entry (archived or not) already has this name. */
async function assertNameFree(
  db: PrismaClient,
  normalizedName: string,
  exceptID: string | null,
) {
  const clash = await db.awardType.findUnique({ where: { normalizedName } });
  if (clash && clash.id !== exceptID) {
    throw fail("CONFLICT", "AWARD_NAME_TAKEN");
  }
}

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === "P2002";

export async function awardTypeCreate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof awardTypeCreateInput>,
  now: Date = new Date(),
) {
  const normalizedName = normalizeAwardName(input.name);
  await assertNameFree(db, normalizedName, null);
  try {
    const row = await db.awardType.create({
      data: {
        name: input.name,
        normalizedName,
        defaultCitation: input.defaultCitation,
        createdBy: actorUserID,
        createdAt: now,
      },
    });
    return { id: row.id };
  } catch (e) {
    if (isUniqueViolation(e)) throw fail("CONFLICT", "AWARD_NAME_TAKEN");
    throw e;
  }
}

async function requireType(db: PrismaClient, id: string) {
  const row = await db.awardType.findUnique({ where: { id } });
  if (!row) throw fail("NOT_FOUND", "AWARD_TYPE_NOT_FOUND");
  return row;
}

/** Rename or change the default citation. Past awards keep the name they were given. */
export async function awardTypeUpdate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof awardTypeUpdateInput>,
  now: Date = new Date(),
) {
  await requireType(db, input.id);
  const normalizedName = normalizeAwardName(input.name);
  await assertNameFree(db, normalizedName, input.id);
  try {
    await db.awardType.update({
      where: { id: input.id },
      data: {
        name: input.name,
        normalizedName,
        defaultCitation: input.defaultCitation,
        updatedBy: actorUserID,
        updatedAt: now,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw fail("CONFLICT", "AWARD_NAME_TAKEN");
    throw e;
  }
  return { id: input.id };
}

export async function awardTypeArchive(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const row = await requireType(db, id);
  if (!row.archivedAt) {
    await db.awardType.update({
      where: { id },
      data: { archivedAt: now, archivedBy: actorUserID },
    });
  }
  return { id };
}

export async function awardTypeRestore(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const row = await requireType(db, id);
  if (row.archivedAt) {
    await db.awardType.update({
      where: { id },
      data: {
        archivedAt: null,
        archivedBy: null,
        updatedBy: actorUserID,
        updatedAt: now,
      },
    });
  }
  return { id };
}

/* ---- assigning -------------------------------------------------------------------- */

/**
 * Give one award to many residents, in one transaction. A resident who already
 * has it for the year (an active award of the same entry, or of the same name
 * with no entry) is skipped and named in the result.
 */
export async function awardsAssign(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof awardsAssignInput>,
  now: Date = new Date(),
) {
  await assertWritable(db, input.academicYear);
  const type = await requireType(db, input.awardTypeID);
  if (type.archivedAt) throw fail("CONFLICT", "AWARD_TYPE_ARCHIVED");

  const people = await Promise.all(
    input.recipients.map(async (r) => ({
      resident: await requireResident(db, r.userID),
      citation: r.citation,
    })),
  );
  const recipients = people.map((p) => ({
    userID: p.resident.key,
    displayName: p.resident.displayName,
    citation: p.citation,
  }));

  return db.$transaction(async (tx) => {
    const existing = await tx.award.findMany({
      where: {
        academicYear: input.academicYear,
        userID: { in: recipients.map((r) => r.userID) },
        ...NOT_VOIDED,
      },
      select: { userID: true, awardTypeID: true, title: true },
    });
    const plan = planAssignment(
      existing.map((e) => ({
        userID: e.userID,
        awardTypeID: e.awardTypeID ?? null,
        title: e.title ?? null,
      })),
      { id: type.id, name: type.name },
      recipients,
    );
    if (plan.create.length > 0) {
      await tx.award.createMany({
        data: plan.create.map((r) => ({
          academicYear: input.academicYear,
          userID: r.userID,
          title: type.name,
          citation: cleanCitation(r.citation) ?? type.defaultCitation ?? null,
          awardTypeID: type.id,
          recordedBy: actorUserID,
          recordedAt: now,
        })),
      });
    }
    return {
      assigned: plan.create.length,
      assignedNames: plan.create.map((r) => r.displayName ?? r.userID),
      skipped: plan.skipped.map((r) => ({
        userID: r.userID,
        displayName: r.displayName,
      })),
    };
  });
}

/* ---- the awards of a year ------------------------------------------------------------- */

export async function awardsList(
  db: PrismaClient,
  input: z.infer<typeof awardsListInput>,
) {
  const rows = await db.award.findMany({
    where: {
      academicYear: input.academicYear,
      ...(input.includeRemoved ? {} : NOT_VOIDED),
    },
    orderBy: { recordedAt: "desc" },
  });
  const [names, label] = await Promise.all([
    lookupResidents(
      db,
      rows.map((r) => r.userID),
    ),
    actorLabels(
      db,
      rows.flatMap((r) => [r.recordedBy, r.updatedBy, r.voidedBy]),
    ),
  ]);
  const search = input.search?.trim() ?? "";
  return rows
    .map((r) => ({
      id: r.id,
      userID: r.userID,
      displayName: names.get(r.userID)?.displayName ?? null,
      title: r.title ?? "Award",
      citation: r.citation ?? "",
      awardTypeID: r.awardTypeID ?? null,
      importBatchID: r.importBatchID ?? null,
      removed: r.voidedAt != null,
      recordedByName: label(r.recordedBy),
      recordedAt: r.recordedAt ?? null,
      updatedByName: label(r.updatedBy),
      updatedAt: r.updatedAt ?? null,
      removedByName: label(r.voidedBy),
      removedAt: r.voidedAt ?? null,
    }))
    .filter((r) => matchesSearch(r, search));
}

async function requireAward(db: PrismaClient, id: string) {
  const row = await db.award.findUnique({ where: { id } });
  if (!row) throw fail("NOT_FOUND", "RECORD_NOT_FOUND");
  return row;
}

export async function awardUpdate(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof awardUpdateInput>,
  now: Date = new Date(),
) {
  const award = await requireAward(db, input.id);
  await assertWritable(db, award.academicYear);
  if (award.voidedAt) throw fail("CONFLICT", "AWARD_REMOVED");
  await db.award.update({
    where: { id: award.id },
    data: {
      title: input.title,
      citation: input.citation,
      updatedBy: actorUserID,
      updatedAt: now,
    },
  });
  return { id: award.id };
}

export async function awardRemove(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const award = await requireAward(db, id);
  await assertWritable(db, award.academicYear);
  if (!award.voidedAt) {
    await db.award.update({
      where: { id },
      data: { voidedAt: now, voidedBy: actorUserID },
    });
  }
  return { id };
}

/** Does this person already hold an ACTIVE award that makes `award` a duplicate? */
async function activeTwin(
  db: Pick<PrismaClient, "award">,
  award: {
    id: string;
    academicYear: string;
    userID: string;
    awardTypeID: string | null;
    title: string | null;
  },
) {
  const others = await db.award.findMany({
    where: {
      academicYear: award.academicYear,
      userID: award.userID,
      id: { not: award.id },
      ...NOT_VOIDED,
    },
    select: { awardTypeID: true, title: true },
  });
  const key = normalizeAwardName(award.title ?? "");
  return others.some((o) =>
    award.awardTypeID
      ? o.awardTypeID === award.awardTypeID
      : o.awardTypeID === null && normalizeAwardName(o.title ?? "") === key,
  );
}

/** Undo a removal, unless the person now has the same award from another row. */
export async function awardRestore(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const award = await requireAward(db, id);
  await assertWritable(db, award.academicYear);
  if (!award.voidedAt) return { id };
  if (await activeTwin(db, award)) throw fail("CONFLICT", "AWARD_DUPLICATE");
  await db.award.update({
    where: { id },
    data: {
      voidedAt: null,
      voidedBy: null,
      updatedBy: actorUserID,
      updatedAt: now,
    },
  });
  return { id };
}

/** Every id must exist; every year they belong to must not be published. */
async function bulkTargets(db: PrismaClient, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const rows = await db.award.findMany({ where: { id: { in: unique } } });
  if (rows.length !== unique.length) {
    throw fail("NOT_FOUND", "RECORD_NOT_FOUND");
  }
  for (const year of new Set(rows.map((r) => r.academicYear))) {
    await assertWritable(db, year);
  }
  return rows;
}

export async function awardsBulkRemove(
  db: PrismaClient,
  actorUserID: string,
  ids: readonly string[],
  now: Date = new Date(),
) {
  const rows = await bulkTargets(db, ids);
  const live = rows.filter((r) => !r.voidedAt).map((r) => r.id);
  if (live.length > 0) {
    await db.award.updateMany({
      where: { id: { in: live } },
      data: { voidedAt: now, voidedBy: actorUserID },
    });
  }
  return { removed: live.length };
}

/** Restore each removed award that would not duplicate an active one; name the rest. */
export async function awardsBulkRestore(
  db: PrismaClient,
  actorUserID: string,
  ids: readonly string[],
  now: Date = new Date(),
) {
  const rows = await bulkTargets(db, ids);
  const removed = rows.filter((r) => r.voidedAt);
  const restorable: string[] = [];
  const skipped: string[] = [];
  const names = await lookupResidents(
    db,
    removed.map((r) => r.userID),
  );
  const claimed: Array<(typeof rows)[number]> = [];
  for (const r of removed) {
    const twinInDb = await activeTwin(db, r);
    const twinInBatch = claimed.some(
      (c) =>
        c.academicYear === r.academicYear &&
        c.userID === r.userID &&
        (r.awardTypeID
          ? c.awardTypeID === r.awardTypeID
          : normalizeAwardName(c.title ?? "") ===
            normalizeAwardName(r.title ?? "")),
    );
    if (twinInDb || twinInBatch) {
      skipped.push(
        `${names.get(r.userID)?.displayName ?? r.userID} (${r.title ?? "Award"})`,
      );
    } else {
      restorable.push(r.id);
      claimed.push(r);
    }
  }
  if (restorable.length > 0) {
    await db.award.updateMany({
      where: { id: { in: restorable } },
      data: {
        voidedAt: null,
        voidedBy: null,
        updatedBy: actorUserID,
        updatedAt: now,
      },
    });
  }
  return { restored: restorable.length, skipped };
}

/* ---- upload history ------------------------------------------------------------------------ */

export async function awardBatchesList(db: PrismaClient, academicYear: string) {
  const rows = await db.awardImportBatch.findMany({
    where: { academicYear },
    orderBy: { createdAt: "desc" },
  });
  const [label, live] = await Promise.all([
    actorLabels(
      db,
      rows.flatMap((r) => [r.createdBy, r.undoneBy]),
    ),
    db.award.findMany({
      where: {
        importBatchID: { in: rows.map((r) => r.id) },
        ...NOT_VOIDED,
      },
      select: { importBatchID: true },
    }),
  ]);
  const active = new Map<string, number>();
  for (const a of live) {
    if (a.importBatchID) {
      active.set(a.importBatchID, (active.get(a.importBatchID) ?? 0) + 1);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    fileName: r.fileName ?? "",
    rowCount: r.rowCount,
    importedCount: r.importedCount,
    skippedCount: r.skippedCount,
    createdByName: label(r.createdBy),
    createdAt: r.createdAt ?? null,
    undone: r.undoneAt != null,
    undoneAt: r.undoneAt ?? null,
    undoneByName: label(r.undoneBy),
    /** Awards of this upload that are still active (what an undo would remove). */
    activeCount: active.get(r.id) ?? 0,
  }));
}

/**
 * Undo an upload: soft-remove every award of it that is still active, and mark
 * the batch undone. Awards already removed one by one are left alone. A batch
 * cannot be undone twice (the claim is a compare-and-set).
 */
export async function awardBatchUndo(
  db: PrismaClient,
  actorUserID: string,
  batchId: string,
  now: Date = new Date(),
) {
  const batch = await db.awardImportBatch.findUnique({
    where: { id: batchId },
  });
  if (!batch) throw fail("NOT_FOUND", "BATCH_NOT_FOUND");
  await assertWritable(db, batch.academicYear);
  return db.$transaction(async (tx) => {
    const claimed = await tx.awardImportBatch.updateMany({
      where: {
        id: batchId,
        OR: [{ undoneAt: null }, { undoneAt: { isSet: false } }],
      },
      data: { undoneAt: now, undoneBy: actorUserID },
    });
    if (claimed.count !== 1) throw fail("CONFLICT", "BATCH_ALREADY_UNDONE");
    const result = await tx.award.updateMany({
      where: { importBatchID: batchId, ...NOT_VOIDED },
      data: { voidedAt: now, voidedBy: actorUserID },
    });
    return { id: batchId, removed: result.count };
  });
}
