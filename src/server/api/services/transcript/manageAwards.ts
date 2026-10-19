import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
  awardActiveKey,
  effectiveBatchStatus,
  cleanCitation,
  isSelfRecorded,
  matchesSearch,
  normalizeAwardName,
  planAssignment,
  removedAwardKey,
} from "~/lib/transcript/awards";
import type {
  awardTypeCreateInput,
  awardTypeUpdateInput,
  awardUpdateInput,
  awardsAssignInput,
  awardsListInput,
} from "~/lib/transcript/manageInput";
import { NOT_VOIDED } from "./loader";
import { correctionSummary } from "~/lib/transcript/corrections";
import {
  assertCanEditForResidents,
  assertStillCollecting,
  yearWrite,
  logCorrections,
} from "./residentRecords";
import { actorLabels, lookupResidents, requireResidents } from "./residents";

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

export const isUniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === "P2002";

/** A big bulk write is a few awards at a time, so no transaction runs long. */
const ROW_CHUNK = 50;
const BULK_TX = { timeout: 60_000, maxWait: 10_000 } as const;

async function inChunks<T>(
  items: readonly T[],
  write: (item: T) => Promise<unknown>,
) {
  for (let i = 0; i < items.length; i += ROW_CHUNK) {
    await Promise.all(items.slice(i, i + ROW_CHUNK).map(write));
  }
}

/** Soft-remove awards, freeing each one's unique key in the same write. */
async function voidAwards(
  tx: Pick<PrismaClient, "award">,
  rows: ReadonlyArray<{ id: string; activeKey: string }>,
  actorUserID: string,
  now: Date,
) {
  await inChunks(rows, (r) =>
    tx.award.update({
      where: { id: r.id },
      data: {
        voidedAt: now,
        voidedBy: actorUserID,
        activeKey: removedAwardKey(r.activeKey, r.id),
      },
    }),
  );
}

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
  const type = await requireType(db, input.awardTypeID);
  if (type.archivedAt) throw fail("CONFLICT", "AWARD_TYPE_ARCHIVED");

  const residents = await requireResidents(
    db,
    input.recipients.map((r) => r.userID),
  );
  const people = input.recipients.map((r) => ({
    resident: residents.get(r.userID)!,
    citation: r.citation,
  }));
  const recipients = people.map((p) => ({
    userID: p.resident.key,
    displayName: p.resident.displayName,
    citation: p.citation,
  }));
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      academicYear: input.academicYear,
      affectedUserIDs: recipients.map((r) => r.userID),
    },
  );

  const rowFor = (r: (typeof recipients)[number]) => ({
    academicYear: input.academicYear,
    userID: r.userID,
    title: type.name,
    citation: cleanCitation(r.citation) ?? type.defaultCitation ?? null,
    awardTypeID: type.id,
    recordedBy: actorUserID,
    recordedAt: now,
    activeKey: awardActiveKey({
      academicYear: input.academicYear,
      userID: r.userID,
      awardTypeID: type.id,
      title: type.name,
    }),
  });
  const lineFor = (r: (typeof recipients)[number]) => ({
    userID: r.userID,
    summary: correctionSummary("Awards", type.name, "assigned"),
  });

  /** Who already has this award for the year, and so who is given it now. */
  const planWith = async (client: Pick<PrismaClient, "award">) => {
    const existing = await client.award.findMany({
      where: {
        academicYear: input.academicYear,
        userID: { in: recipients.map((r) => r.userID) },
        ...NOT_VOIDED,
      },
      select: { userID: true, awardTypeID: true, title: true },
    });
    return planAssignment(
      existing.map((e) => ({
        userID: e.userID,
        awardTypeID: e.awardTypeID ?? null,
        title: e.title ?? null,
      })),
      { id: type.id, name: type.name },
      recipients,
    );
  };

  // One transaction for everyone, retried by yearWrite when it loses a write
  // conflict (the plan is read again inside it each time).
  let result: { created: typeof recipients; skipped: typeof recipients };
  try {
    result = await yearWrite(db, async (tx) => {
      await assertStillCollecting(tx, input.academicYear, guard);
      const plan = await planWith(tx);
      if (plan.create.length > 0) {
        await tx.award.createMany({ data: plan.create.map(rowFor) });
      }
      await logCorrections(
        tx,
        guard,
        actorUserID,
        input.academicYear,
        plan.create.map(lineFor),
        now,
      );
      return { created: plan.create, skipped: plan.skipped };
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Someone gave one of these awards at the same moment (a double-submit,
    // or another manager). A duplicate aborts the whole write, so go person by
    // person: the ones who already have it are skipped, the rest are given it.
    // Each person is its own yearWrite, and nothing retries this loop as a
    // whole, so an award given here is always reported as assigned.
    const plan = await planWith(db);
    const created: typeof recipients = [];
    const raced: typeof recipients = [];
    for (const r of plan.create) {
      try {
        await yearWrite(db, async (tx) => {
          await assertStillCollecting(tx, input.academicYear, guard);
          await tx.award.create({ data: rowFor(r) });
          await logCorrections(
            tx,
            guard,
            actorUserID,
            input.academicYear,
            [lineFor(r)],
            now,
          );
        });
        created.push(r);
      } catch (e2) {
        if (!isUniqueViolation(e2)) throw e2;
        raced.push(r);
      }
    }
    result = { created, skipped: [...plan.skipped, ...raced] };
  }
  return {
    assigned: result.created.length,
    assignedNames: result.created.map((r) => r.displayName ?? r.userID),
    skipped: result.skipped.map((r) => ({
      userID: r.userID,
      displayName: r.displayName,
    })),
  };
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
      /** The manager recorded, edited or removed their own award (shown, never blocked). */
      selfRecorded: isSelfRecorded(r),
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
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    { academicYear: award.academicYear, affectedUserIDs: [award.userID] },
  );
  if (award.voidedAt) throw fail("CONFLICT", "AWARD_REMOVED");
  // An award with no catalogue entry is unique by its title, so renaming it
  // moves its key; one with an entry keeps its key whatever the title says.
  const activeKey = award.awardTypeID
    ? award.activeKey
    : awardActiveKey({
        academicYear: award.academicYear,
        userID: award.userID,
        awardTypeID: null,
        title: input.title,
      });
  try {
    await yearWrite(db, async (tx) => {
      await assertStillCollecting(tx, award.academicYear, guard);
      // The check and the write are one step: an edit that lost a race with a
      // remove changes nothing, so it cannot put the active key back.
      const written = await tx.award.updateMany({
        where: { id: award.id, ...NOT_VOIDED },
        data: {
          title: input.title,
          citation: input.citation,
          activeKey,
          updatedBy: actorUserID,
          updatedAt: now,
        },
      });
      if (written.count !== 1) throw fail("CONFLICT", "AWARD_REMOVED");
      await logCorrections(
        tx,
        guard,
        actorUserID,
        award.academicYear,
        [
          {
            userID: award.userID,
            summary: correctionSummary("Awards", input.title, "edited"),
          },
        ],
        now,
      );
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw fail("CONFLICT", "AWARD_DUPLICATE");
    throw e;
  }
  return { id: award.id };
}

export async function awardRemove(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const award = await requireAward(db, id);
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    { academicYear: award.academicYear, affectedUserIDs: [award.userID] },
  );
  if (!award.voidedAt) {
    await yearWrite(db, async (tx) => {
      await assertStillCollecting(tx, award.academicYear, guard);
      await voidAwards(tx, [award], actorUserID, now);
      await logCorrections(
        tx,
        guard,
        actorUserID,
        award.academicYear,
        [
          {
            userID: award.userID,
            summary: correctionSummary(
              "Awards",
              award.title ?? "Award",
              "removed",
            ),
          },
        ],
        now,
      );
    });
  }
  return { id };
}

/** The unique key an award takes back when it is restored. */
const keyOf = (r: {
  academicYear: string;
  userID: string;
  awardTypeID: string | null;
  title: string | null;
}) =>
  awardActiveKey({
    academicYear: r.academicYear,
    userID: r.userID,
    awardTypeID: r.awardTypeID ?? null,
    title: r.title ?? null,
  });

/**
 * Undo a removal, unless the person now has the same award from another row:
 * the unique key refuses, whoever got there first.
 */
export async function awardRestore(
  db: PrismaClient,
  actorUserID: string,
  id: string,
  now: Date = new Date(),
) {
  const award = await requireAward(db, id);
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    { academicYear: award.academicYear, affectedUserIDs: [award.userID] },
  );
  if (!award.voidedAt) return { id };
  try {
    await yearWrite(db, async (tx) => {
      await assertStillCollecting(tx, award.academicYear, guard);
      await tx.award.update({
        where: { id },
        data: {
          voidedAt: null,
          voidedBy: null,
          activeKey: keyOf(award),
          updatedBy: actorUserID,
          updatedAt: now,
        },
      });
      await logCorrections(
        tx,
        guard,
        actorUserID,
        award.academicYear,
        [
          {
            userID: award.userID,
            summary: correctionSummary(
              "Awards",
              award.title ?? "Award",
              "restored",
            ),
          },
        ],
        now,
      );
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw fail("CONFLICT", "ALREADY_HAS_AWARD");
    throw e;
  }
  return { id };
}

/**
 * Every id must exist, and the guard must pass for each year they belong to,
 * for exactly the residents holding them. Returns the rows and, per year, the
 * guard result, so the caller can log corrections for the rows it changes.
 */
async function bulkTargets(
  db: PrismaClient,
  actorUserID: string,
  ids: readonly string[],
) {
  const unique = [...new Set(ids)];
  const rows = await db.award.findMany({ where: { id: { in: unique } } });
  if (rows.length !== unique.length) {
    throw fail("NOT_FOUND", "RECORD_NOT_FOUND");
  }
  const guards = new Map<string, { correction: boolean }>();
  for (const year of new Set(rows.map((r) => r.academicYear))) {
    guards.set(
      year,
      await assertCanEditForResidents(
        db,
        { userID: actorUserID },
        {
          academicYear: year,
          affectedUserIDs: rows
            .filter((r) => r.academicYear === year)
            .map((r) => r.userID),
        },
      ),
    );
  }
  return { rows, guards };
}

/** The in-transaction year check for every year a bulk change touches. */
async function assertYearsStillCollecting(
  tx: Pick<PrismaClient, "transcriptPeriod">,
  guards: Map<string, { correction: boolean }>,
) {
  for (const [year, guard] of guards) {
    await assertStillCollecting(tx, year, guard);
  }
}

/** Log a bulk change's corrections, year by year. */
async function logBulk(
  db: Pick<PrismaClient, "residentEvent">,
  actorUserID: string,
  guards: Map<string, { correction: boolean }>,
  changed: ReadonlyArray<{
    academicYear: string;
    userID: string;
    title: string | null;
  }>,
  verb: string,
  now: Date,
) {
  for (const [year, guard] of guards) {
    await logCorrections(
      db,
      guard,
      actorUserID,
      year,
      changed
        .filter((c) => c.academicYear === year)
        .map((c) => ({
          userID: c.userID,
          summary: correctionSummary("Awards", c.title ?? "Award", verb),
        })),
      now,
    );
  }
}

export async function awardsBulkRemove(
  db: PrismaClient,
  actorUserID: string,
  ids: readonly string[],
  now: Date = new Date(),
) {
  const { rows, guards } = await bulkTargets(db, actorUserID, ids);
  const live = rows.filter((r) => !r.voidedAt);
  if (live.length > 0) {
    await yearWrite(
      db,
      async (tx) => {
        await assertYearsStillCollecting(tx, guards);
        await voidAwards(tx, live, actorUserID, now);
        await logBulk(tx, actorUserID, guards, live, "removed", now);
      },
      BULK_TX,
    );
  }
  return { removed: live.length };
}

/**
 * Restore each removed award that would not duplicate an active one; name the
 * rest. The people's active awards are read ONCE and compared in memory; the
 * unique key still settles a race, and then that award alone is skipped.
 */
export async function awardsBulkRestore(
  db: PrismaClient,
  actorUserID: string,
  ids: readonly string[],
  now: Date = new Date(),
) {
  const { rows, guards } = await bulkTargets(db, actorUserID, ids);
  const removed = rows.filter((r) => r.voidedAt);
  const skipped: string[] = [];
  const names = await lookupResidents(
    db,
    removed.map((r) => r.userID),
  );
  const heldNow =
    removed.length === 0
      ? []
      : await db.award.findMany({
          where: {
            academicYear: {
              in: [...new Set(removed.map((r) => r.academicYear))],
            },
            userID: { in: [...new Set(removed.map((r) => r.userID))] },
            ...NOT_VOIDED,
          },
          select: {
            academicYear: true,
            userID: true,
            awardTypeID: true,
            title: true,
          },
        });
  const taken = new Set(heldNow.map(keyOf));
  const label = (r: (typeof removed)[number]) =>
    `${names.get(r.userID)?.displayName ?? r.userID} (${r.title ?? "Award"})`;
  const restorable: typeof removed = [];
  for (const r of removed) {
    const key = keyOf(r);
    if (taken.has(key)) {
      skipped.push(label(r));
    } else {
      taken.add(key);
      restorable.push(r);
    }
  }

  const restoreData = (r: (typeof removed)[number]) => ({
    voidedAt: null,
    voidedBy: null,
    activeKey: keyOf(r),
    updatedBy: actorUserID,
    updatedAt: now,
  });
  let restored = restorable.length;
  if (restorable.length > 0) {
    try {
      await yearWrite(
        db,
        async (tx) => {
          await assertYearsStillCollecting(tx, guards);
          await inChunks(restorable, (r) =>
            tx.award.update({ where: { id: r.id }, data: restoreData(r) }),
          );
          await logBulk(tx, actorUserID, guards, restorable, "restored", now);
        },
        BULK_TX,
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Someone restored or gave one of them meanwhile: go one by one.
      restored = 0;
      for (const r of restorable) {
        try {
          await yearWrite(db, async (tx) => {
            await assertStillCollecting(
              tx,
              r.academicYear,
              guards.get(r.academicYear)!,
            );
            await tx.award.update({
              where: { id: r.id },
              data: restoreData(r),
            });
            await logBulk(tx, actorUserID, guards, [r], "restored", now);
          });
          restored += 1;
        } catch (e2) {
          if (!isUniqueViolation(e2)) throw e2;
          skipped.push(label(r));
        }
      }
    }
  }
  return { restored, skipped };
}

/* ---- upload history ------------------------------------------------------------------------ */

export async function awardBatchesList(
  db: PrismaClient,
  academicYear: string,
  now: Date = new Date(),
) {
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
      where: { importBatchID: { in: rows.map((r) => r.id) } },
      select: { importBatchID: true, userID: true, voidedAt: true },
    }),
  ]);
  const active = new Map<string, number>();
  const selfUploaded = new Set<string>();
  for (const a of live) {
    if (!a.importBatchID) continue;
    if (!a.voidedAt) {
      active.set(a.importBatchID, (active.get(a.importBatchID) ?? 0) + 1);
    }
    const batch = rows.find((r) => r.id === a.importBatchID);
    if (batch && batch.createdBy === a.userID) selfUploaded.add(batch.id);
  }
  const written = new Map<string, number>();
  for (const a of live) {
    if (a.importBatchID) {
      written.set(a.importBatchID, (written.get(a.importBatchID) ?? 0) + 1);
    }
  }
  return rows.map((r) => {
    const status = effectiveBatchStatus(r.status, r.createdAt, now);
    // An interrupted upload never saved its counts: count what it wrote.
    const interrupted = status === "interrupted";
    return {
      id: r.id,
      fileName: r.fileName ?? "",
      rowCount: r.rowCount,
      importedCount: interrupted ? (written.get(r.id) ?? 0) : r.importedCount,
      skippedCount: interrupted
        ? Math.max(0, r.rowCount - (written.get(r.id) ?? 0))
        : r.skippedCount,
      createdByName: label(r.createdBy),
      createdAt: r.createdAt ?? null,
      status,
      /** The uploader is one of the people the upload gave awards to. */
      selfRecorded: selfUploaded.has(r.id),
      undone: r.undoneAt != null,
      undoneAt: r.undoneAt ?? null,
      undoneByName: label(r.undoneBy),
      /** Awards of this upload that are still active (what an undo would remove). */
      activeCount: active.get(r.id) ?? 0,
    };
  });
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
  // Rows written after the undo would escape it, so wait while the upload is
  // still being written. One cut off long ago ("interrupted") can be undone.
  if (
    effectiveBatchStatus(batch.status, batch.createdAt, now) === "importing"
  ) {
    throw fail("CONFLICT", "BATCH_IN_PROGRESS");
  }
  // Who the undo touches: everyone still holding an active award of the upload.
  const active = await db.award.findMany({
    where: { importBatchID: batchId, ...NOT_VOIDED },
    select: { id: true, activeKey: true, userID: true, title: true },
  });
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      academicYear: batch.academicYear,
      affectedUserIDs: active.map((a) => a.userID),
    },
  );
  const undone = await yearWrite(
    db,
    async (tx) => {
      await assertStillCollecting(tx, batch.academicYear, guard);
      const claimed = await tx.awardImportBatch.updateMany({
        where: {
          id: batchId,
          OR: [{ undoneAt: null }, { undoneAt: { isSet: false } }],
        },
        data: { undoneAt: now, undoneBy: actorUserID },
      });
      if (claimed.count !== 1) throw fail("CONFLICT", "BATCH_ALREADY_UNDONE");
      // Each award gives back its unique key as it is removed.
      await voidAwards(tx, active, actorUserID, now);
      await logCorrections(
        tx,
        guard,
        actorUserID,
        batch.academicYear,
        active.map((a) => ({
          userID: a.userID,
          summary: correctionSummary(
            "Awards",
            a.title ?? "Award",
            "removed (upload undone)",
          ),
        })),
        now,
      );
      return { id: batchId, removed: active.length };
    },
    BULK_TX,
  );
  return undone;
}
