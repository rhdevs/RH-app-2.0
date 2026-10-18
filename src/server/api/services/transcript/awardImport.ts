import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
  IMPORT_CHUNK_SIZE,
  MAX_IMPORT_ROWS,
  SKIPPED_BY_USER,
  classifyRows,
  countByStatus,
  effectiveCitation,
  heldNameKey,
  heldTypeKey,
  undecided,
  unknownNames,
  type CatalogueEntry,
  type ClassifiedRow,
  type Decision,
} from "~/lib/transcript/awardImport";
import type {
  awardImportCommitInput,
  awardImportPreviewInput,
} from "~/lib/transcript/awardImport";
// The admin bulk wizard's own identifier resolvers, imported, not copied.
import { bulkResolver } from "~/server/api/routers/admin";
import { awardTypeCreate, isUniqueViolation } from "./manageAwards";
import { awardActiveKey } from "~/lib/transcript/awards";
import { retryWriteConflicts } from "~/lib/transcript/writeConflict";
import { NOT_VOIDED } from "./loader";
import { assertWritable } from "./manageAccess";
import { correctionSummary } from "~/lib/transcript/corrections";
import {
  assertCanEditForResidents,
  assertStillCollecting,
  logCorrections,
} from "./residentRecords";
import { lookupResidents } from "./residents";

/**
 * AWARDS CSV IMPORT. The client parses and maps the file; these procedures see
 * rows `{ identifier, award, citation }`.
 *
 *  - PREVIEW classifies every row (Ready, Not found, Duplicate, Invalid) and
 *    lists the award names that match no live catalogue entry.
 *  - COMMIT re-does ALL of it (resolution, duplicates, matching), never trusting
 *    the preview, creates the catalogue entries the user chose, then writes the
 *    Ready rows in chunks under ONE `AwardImportBatch`, so the whole upload can be
 *    undone. A row that became a duplicate since the preview is skipped, not failed.
 *
 * Identifiers resolve exactly as the admin bulk wizard resolves them (`bulkResolver`).
 */

const fail = (
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
  message: string,
) => new TRPCError({ code, message });

interface Prepared {
  rows: ClassifiedRow[];
  catalogue: Array<CatalogueEntry & { normalizedName: string }>;
  held: Set<string>;
}

async function prepare(
  db: PrismaClient,
  academicYear: string,
  rawRows: ReadonlyArray<{
    identifier: string;
    award: string;
    citation?: string | null;
  }>,
): Promise<Prepared> {
  if (rawRows.length > MAX_IMPORT_ROWS) {
    throw fail("BAD_REQUEST", "TOO_MANY_ROWS");
  }
  const rows = rawRows.map((r) => ({
    identifier: r.identifier.trim(),
    award: r.award,
    citation: r.citation ?? null,
  }));

  // One resolver for the request, then one resolution per row.
  const resolve = await bulkResolver(
    db,
    rows.map((r) => ({ identifier: r.identifier })),
  );
  const hits = new Map<string, string | null>();
  for (const r of rows) {
    if (r.identifier !== "" && !hits.has(r.identifier)) {
      hits.set(r.identifier, resolve(r.identifier)?.userID ?? null);
    }
  }
  const keys = [...new Set([...hits.values()].filter((k): k is string => !!k))];
  const people = await lookupResidents(db, keys);

  const [types, awards] = await Promise.all([
    db.awardType.findMany(),
    db.award.findMany({
      where: { academicYear, userID: { in: keys }, ...NOT_VOIDED },
      select: { userID: true, awardTypeID: true, title: true },
    }),
  ]);
  const held = new Set<string>();
  for (const a of awards) {
    if (a.awardTypeID) held.add(heldTypeKey(a.userID, a.awardTypeID));
    if (a.title) held.add(heldNameKey(a.userID, a.title));
  }
  const catalogue = types.map((t) => ({
    id: t.id,
    name: t.name,
    normalizedName: t.normalizedName,
    defaultCitation: t.defaultCitation ?? null,
    archived: t.archivedAt != null,
  }));

  const classified = classifyRows({
    rows,
    resident: (identifier) => {
      const key = hits.get(identifier);
      const person = key ? people.get(key) : undefined;
      return key && person
        ? { userID: key, displayName: person.displayName }
        : null;
    },
    catalogue,
    held,
  });
  return { rows: classified, catalogue, held };
}

export async function awardImportPreview(
  db: PrismaClient,
  input: z.infer<typeof awardImportPreviewInput>,
) {
  await assertWritable(db, input.academicYear);
  const { rows, catalogue } = await prepare(db, input.academicYear, input.rows);
  return {
    rows,
    counts: countByStatus(rows),
    unknown: unknownNames(rows),
    /** What "Use existing" can pick: live entries, then archived ones. */
    types: catalogue
      .filter((t) => !t.archived)
      .map((t) => ({ id: t.id, name: t.name, archived: false }))
      .sort((a, b) => a.name.localeCompare(b.name, "en")),
    archivedTypes: catalogue
      .filter((t) => t.archived)
      .map((t) => ({ id: t.id, name: t.name, archived: true }))
      .sort((a, b) => a.name.localeCompare(b.name, "en")),
  };
}

export interface SkippedRow {
  row: number;
  identifier: string;
  award: string;
  reason: string;
}

/** 200 rows and their history lines in one transaction. */
const CHUNK_TX = { timeout: 30_000, maxWait: 10_000 } as const;

const ALREADY_HAS = "Already has this award for the year.";

/**
 * Set a batch's status and counts. If this write fails it is logged (batch,
 * year, error code and name only, never a message that could carry names) and
 * thrown, so the caller decides what the manager sees.
 */
async function markBatch(
  db: PrismaClient,
  batchId: string,
  academicYear: string,
  data: { status: string; importedCount: number; skippedCount: number },
) {
  try {
    await db.awardImportBatch.update({ where: { id: batchId }, data });
  } catch (error) {
    const e = error as { code?: unknown; name?: unknown };
    console.error(
      JSON.stringify({
        evt: "award_batch_mark_failed",
        batchId,
        academicYear,
        code: typeof e.code === "string" ? e.code : "UNKNOWN",
        name: typeof e.name === "string" ? e.name : typeof error,
      }),
    );
    throw error;
  }
}

export async function awardImportCommit(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof awardImportCommitInput>,
  now: Date = new Date(),
) {
  const { rows, catalogue, held } = await prepare(
    db,
    input.academicYear,
    input.rows,
  );
  const skippedByUser = new Set(input.skipRows ?? []);
  const decisions: Decision[] = input.decisions;

  // Who the import may touch: every resident on a Ready row not skipped. Checked
  // before anything is written, so a refusal leaves the catalogue alone too.
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      academicYear: input.academicYear,
      affectedUserIDs: rows
        .filter((r) => r.status === "ready" && !skippedByUser.has(r.row))
        .map((r) => r.userID!),
    },
  );

  // Every new name among the rows that would be imported needs a decision.
  const unknown = unknownNames(rows, skippedByUser);
  if (undecided(unknown, decisions).length > 0) {
    throw fail("BAD_REQUEST", "UNDECIDED_AWARD_NAMES");
  }
  const byID = new Map(catalogue.map((t) => [t.id, t]));
  const byName = new Map(catalogue.map((t) => [t.normalizedName, t]));
  const chosen = new Map(decisions.map((d) => [d.nameKey, d]));

  // Check every decision before anything is written.
  for (const u of unknown) {
    const d = chosen.get(u.nameKey)!;
    if (d.action === "existing" && !byID.has(d.awardTypeID)) {
      throw fail("NOT_FOUND", "AWARD_TYPE_GONE");
    }
    if (d.action === "create" && byName.has(u.nameKey)) {
      throw fail("CONFLICT", "AWARD_NAME_TAKEN");
    }
  }

  // New catalogue entries first (no default citation); "existing" keeps an
  // archived entry archived.
  const typeFor = new Map<
    string,
    { id: string; name: string; defaultCitation: string | null }
  >();
  const created: string[] = [];
  for (const u of unknown) {
    const d = chosen.get(u.nameKey)!;
    if (d.action === "create") {
      const made = await awardTypeCreate(
        db,
        actorUserID,
        { name: u.name, defaultCitation: null },
        now,
      );
      typeFor.set(u.nameKey, {
        id: made.id,
        name: u.name,
        defaultCitation: null,
      });
      created.push(u.name);
    } else {
      const t = byID.get(d.awardTypeID)!;
      typeFor.set(u.nameKey, {
        id: t.id,
        name: t.name,
        defaultCitation: t.defaultCitation,
      });
    }
  }

  const skipped: SkippedRow[] = [];
  const toWrite: Array<{
    userID: string;
    title: string;
    citation: string | null;
    awardTypeID: string;
    source: ClassifiedRow;
  }> = [];
  const seen = new Set<string>();
  const skip = (r: ClassifiedRow, reason: string) =>
    skipped.push({
      row: r.row,
      identifier: r.identifier,
      award: r.award,
      reason,
    });

  for (const r of rows) {
    if (r.status !== "ready") {
      skip(r, r.reason ?? "Not imported.");
      continue;
    }
    if (skippedByUser.has(r.row)) {
      skip(r, SKIPPED_BY_USER);
      continue;
    }
    const type = r.typeID ? byID.get(r.typeID)! : typeFor.get(r.nameKey)!;
    // The final check, by the entry the row ended up with.
    const userID = r.userID!;
    const dup =
      held.has(heldTypeKey(userID, type.id)) ||
      held.has(heldNameKey(userID, type.name));
    if (dup) {
      skip(r, ALREADY_HAS);
      continue;
    }
    const once = `${userID}|${type.id}`;
    if (seen.has(once)) {
      skip(r, "Listed earlier in the file.");
      continue;
    }
    seen.add(once);
    toWrite.push({
      userID,
      title: type.name,
      citation: effectiveCitation(r.citation, type.defaultCitation),
      awardTypeID: type.id,
      source: r,
    });
  }

  const batch = await db.awardImportBatch.create({
    data: {
      academicYear: input.academicYear,
      fileName: input.fileName?.trim() || null,
      rowCount: rows.length,
      importedCount: 0,
      skippedCount: skipped.length,
      // "importing" until the last chunk is written (then complete or partial).
      status: "importing",
      createdBy: actorUserID,
      createdAt: now,
    },
  });

  // Chunk by chunk, each with its own history lines in the same transaction. A
  // chunk that fails after earlier ones were written leaves a PARTIAL batch that
  // says what was written, so History can show it and Undo removes exactly it.
  const rowFor = (a: (typeof toWrite)[number]) => ({
    academicYear: input.academicYear,
    userID: a.userID,
    title: a.title,
    citation: a.citation,
    awardTypeID: a.awardTypeID,
    importBatchID: batch.id,
    recordedBy: actorUserID,
    recordedAt: now,
    activeKey: awardActiveKey({
      academicYear: input.academicYear,
      userID: a.userID,
      awardTypeID: a.awardTypeID,
      title: a.title,
    }),
  });
  const lineFor = (a: (typeof toWrite)[number]) => ({
    userID: a.userID,
    summary: correctionSummary("Awards", a.title, "assigned (upload)"),
  });
  let imported = 0;
  try {
    for (let i = 0; i < toWrite.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = toWrite.slice(i, i + IMPORT_CHUNK_SIZE);
      try {
        await retryWriteConflicts(() =>
          db.$transaction(async (tx) => {
            await assertStillCollecting(tx, input.academicYear, guard);
            await tx.award.createMany({ data: chunk.map(rowFor) });
            await logCorrections(
              tx,
              guard,
              actorUserID,
              input.academicYear,
              chunk.map(lineFor),
              now,
            );
          }, CHUNK_TX),
        );
        imported += chunk.length;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Someone gave one of these awards at the same moment (another upload,
        // or a double-submit). One duplicate aborts the whole chunk, so write it
        // row by row: that row is skipped, the others are imported.
        for (const a of chunk) {
          try {
            await retryWriteConflicts(() =>
              db.$transaction(async (tx) => {
                await assertStillCollecting(tx, input.academicYear, guard);
                await tx.award.create({ data: rowFor(a) });
                await logCorrections(
                  tx,
                  guard,
                  actorUserID,
                  input.academicYear,
                  [lineFor(a)],
                  now,
                );
              }, CHUNK_TX),
            );
            imported += 1;
          } catch (error2) {
            if (!isUniqueViolation(error2)) throw error2;
            skip(a.source, ALREADY_HAS);
          }
        }
      }
    }
  } catch (error) {
    // Say what was written. If even that cannot be saved the failure is logged,
    // and the manager still sees the partial-upload message, never a bare error.
    await markBatch(db, batch.id, input.academicYear, {
      status: "partial",
      importedCount: imported,
      skippedCount: rows.length - imported,
    }).catch(() => undefined);
    throw new TRPCError({
      code: "CONFLICT",
      message: `UPLOAD_PARTIAL:${imported}`,
      cause: error,
    });
  }
  // Every award is written: a status that cannot be saved must not turn this
  // into an error. Try twice (each failure is logged); then report success, and
  // History will show the batch as interrupted with the count of what it wrote.
  const complete = {
    status: "complete",
    importedCount: imported,
    skippedCount: rows.length - imported,
  };
  try {
    await markBatch(db, batch.id, input.academicYear, complete);
  } catch {
    await markBatch(db, batch.id, input.academicYear, complete).catch(
      () => undefined,
    );
  }

  return {
    batchId: batch.id,
    imported,
    skipped: skipped.sort((a, b) => a.row - b.row),
    created,
  };
}
