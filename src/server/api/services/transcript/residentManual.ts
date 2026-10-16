import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
  correctionSummary,
  joinChanges,
  membershipChangeParts,
} from "~/lib/transcript/corrections";
import { isDuration, type Duration } from "~/lib/transcript/duration";
import {
  manualProblem,
  shadowedManualCcas,
} from "~/lib/transcript/manualMembership";
import type {
  manualListInput,
  manualRefInput,
  manualSaveInput,
  residentScope,
} from "~/lib/transcript/residentInput";
import { loadResidentCcaIDs, NOT_REMOVED } from "./loader";
import { requireCca } from "./manageAccess";
import { rosterRowsFor, type RosterRow } from "./manageRoster";
import {
  assertCanEditForResidents,
  recordResidentEvent,
} from "./residentRecords";
import { actorLabels, keysOf, requireResident } from "./residents";

/**
 * A resident's CCA memberships for one year, for the correction screens: the
 * ones the membership data gives them (roster entries, frozen or live) and the
 * MANUAL entries a manager added for a resident the data misses. Manual rows are
 * never deleted: removing one sets removedAt/removedBy, and it can be restored.
 */

const fail = (
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
  message: string,
) => new TRPCError({ code, message });

const asDuration = (v: string | null | undefined): Duration | null =>
  isDuration(v) ? v : null;

/* ---- reading --------------------------------------------------------------- */

export interface RosterMembership {
  ccaID: number;
  ccaName: string;
  category: string;
  /** "frozen" (the year's list is recorded) or "live" (still the current list). */
  mode: "frozen" | "live";
  row: RosterRow;
}

export interface ManualMembershipView {
  ccaID: number;
  ccaName: string;
  category: string;
  duration: Duration | null;
  roleLabel: string | null;
  roleDuration: Duration | null;
  extraContribution: string | null;
  removed: boolean;
  /** A roster entry exists for the same CCA, so this entry is ignored. */
  alsoInRoster: boolean;
  createdByName: string | null;
  createdAt: Date | null;
  updatedByName: string | null;
  updatedAt: Date | null;
  removedByName: string | null;
  removedAt: Date | null;
}

export interface ResidentMemberships {
  userID: string;
  roster: RosterMembership[];
  manual: ManualMembershipView[];
}

export async function residentMemberships(
  db: PrismaClient,
  input: z.infer<typeof manualListInput>,
  now: Date = new Date(),
): Promise<ResidentMemberships> {
  const { key, rosterCcaIDs } = await loadResidentCcaIDs(
    db,
    input.userID,
    input.academicYear,
    { now },
  );
  const manualRows = await db.manualMembership.findMany({
    where: {
      academicYear: input.academicYear,
      userID: key,
      ...(input.includeRemoved ? {} : NOT_REMOVED),
    },
    orderBy: { createdAt: "asc" },
  });
  const ccaIDs = [
    ...new Set([...rosterCcaIDs, ...manualRows.map((m) => m.ccaID)]),
  ];
  const [ccas, label] = await Promise.all([
    db.cCA.findMany({ where: { ccaID: { in: ccaIDs } } }),
    actorLabels(
      db,
      manualRows.flatMap((m) => [m.createdBy, m.updatedBy, m.removedBy]),
    ),
  ]);
  const ccaBy = new Map(ccas.map((c) => [c.ccaID, c]));

  const rows = await rosterRowsFor(
    db,
    key,
    await keysOf(db, key),
    input.academicYear,
    rosterCcaIDs,
    now,
  );
  const roster: RosterMembership[] = [];
  for (const ccaID of rosterCcaIDs) {
    const cca = ccaBy.get(ccaID);
    const found = rows.get(ccaID);
    if (!cca || !found) continue;
    roster.push({
      ccaID,
      ccaName: cca.ccaName,
      category: cca.category,
      mode: found.mode,
      row: found.row,
    });
  }

  const shadowed = shadowedManualCcas(rosterCcaIDs, manualRows);
  const manual = manualRows.flatMap((m): ManualMembershipView[] => {
    const cca = ccaBy.get(m.ccaID);
    if (!cca) return [];
    return [
      {
        ccaID: m.ccaID,
        ccaName: cca.ccaName,
        category: cca.category,
        duration: asDuration(m.duration),
        roleLabel: m.roleLabel?.trim() ? m.roleLabel : null,
        roleDuration: asDuration(m.roleDuration),
        extraContribution: m.extraContribution?.trim()
          ? m.extraContribution
          : null,
        removed: m.removedAt != null,
        alsoInRoster: shadowed.has(m.ccaID),
        createdByName: label(m.createdBy),
        createdAt: m.createdAt ?? null,
        updatedByName: label(m.updatedBy),
        updatedAt: m.updatedAt ?? null,
        removedByName: label(m.removedBy),
        removedAt: m.removedAt ?? null,
      },
    ];
  });
  return { userID: key, roster, manual };
}

/* ---- writing --------------------------------------------------------------- */

type SaveInput = z.infer<typeof manualSaveInput>;
type RefInput = z.infer<typeof manualRefInput>;
type Scope = z.infer<typeof residentScope>;

const uniqueWhere = (academicYear: string, userID: string, ccaID: number) => ({
  academicYear_userID_ccaID: { academicYear, userID, ccaID },
});

/** The guard for a manual-entry write: a manager, and unlocked if published. */
async function guardManual(
  db: PrismaClient,
  actorUserID: string,
  scope: Scope,
  key: string,
) {
  await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    { academicYear: scope.academicYear, affectedUserIDs: [key] },
  );
}

/**
 * Add a manual entry, or edit the one that exists (one per resident, CCA and
 * year). Fields left out are untouched; null or blank clears one. The role
 * period must fit inside the membership period. A removed entry must be
 * restored first.
 */
export async function manualSave(
  db: PrismaClient,
  actorUserID: string,
  input: SaveInput,
  now: Date = new Date(),
) {
  const resident = await requireResident(db, input.userID);
  const cca = await requireCca(db, input.ccaID);
  await guardManual(db, actorUserID, input, resident.key);

  const where = uniqueWhere(input.academicYear, resident.key, input.ccaID);
  const existing = await db.manualMembership.findUnique({ where });
  if (existing?.removedAt) throw fail("CONFLICT", "MANUAL_REMOVED");

  const problem = manualProblem({
    duration:
      input.duration !== undefined
        ? input.duration
        : asDuration(existing?.duration),
    roleDuration:
      input.roleDuration !== undefined
        ? input.roleDuration
        : asDuration(existing?.roleDuration),
  });
  if (problem) throw fail("BAD_REQUEST", problem);

  const changes = {
    ...(input.duration !== undefined && { duration: input.duration }),
    ...(input.roleLabel !== undefined && { roleLabel: input.roleLabel }),
    ...(input.roleDuration !== undefined && {
      roleDuration: input.roleDuration,
    }),
    ...(input.extraContribution !== undefined && {
      extraContribution: input.extraContribution,
    }),
  };
  if (existing) {
    await db.manualMembership.update({
      where,
      data: { ...changes, updatedBy: actorUserID, updatedAt: now },
    });
  } else {
    await db.manualMembership.create({
      data: {
        academicYear: input.academicYear,
        userID: resident.key,
        ccaID: input.ccaID,
        ...changes,
        createdBy: actorUserID,
        createdAt: now,
      },
    });
  }
  await recordResidentEvent(db, {
    academicYear: input.academicYear,
    userID: resident.key,
    action: existing ? "manual_edit" : "manual_add",
    summary: correctionSummary(
      "Manual entry",
      cca.ccaName,
      existing ? joinChanges(membershipChangeParts(existing, input)) : "added",
    ),
    actor: actorUserID,
    at: now,
  });
  return { userID: resident.key, ccaID: input.ccaID };
}

async function setManualRemoved(
  db: PrismaClient,
  actorUserID: string,
  input: RefInput,
  removed: boolean,
  now: Date,
) {
  const resident = await requireResident(db, input.userID);
  const cca = await requireCca(db, input.ccaID);
  await guardManual(db, actorUserID, input, resident.key);
  const where = uniqueWhere(input.academicYear, resident.key, input.ccaID);
  const row = await db.manualMembership.findUnique({ where });
  if (!row) throw fail("NOT_FOUND", "RECORD_NOT_FOUND");
  if (Boolean(row.removedAt) === removed) {
    return { userID: resident.key, ccaID: input.ccaID };
  }
  await db.manualMembership.update({
    where,
    data: removed
      ? { removedAt: now, removedBy: actorUserID }
      : {
          removedAt: null,
          removedBy: null,
          updatedBy: actorUserID,
          updatedAt: now,
        },
  });
  await recordResidentEvent(db, {
    academicYear: input.academicYear,
    userID: resident.key,
    action: removed ? "manual_remove" : "manual_restore",
    summary: correctionSummary(
      "Manual entry",
      cca.ccaName,
      removed ? "removed" : "restored",
    ),
    actor: actorUserID,
    at: now,
  });
  return { userID: resident.key, ccaID: input.ccaID };
}

export const manualRemove = (
  db: PrismaClient,
  actorUserID: string,
  input: RefInput,
  now: Date = new Date(),
) => setManualRemoved(db, actorUserID, input, true, now);

export const manualRestore = (
  db: PrismaClient,
  actorUserID: string,
  input: RefInput,
  now: Date = new Date(),
) => setManualRemoved(db, actorUserID, input, false, now);
