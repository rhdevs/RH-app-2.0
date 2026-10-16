import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  clampRoleDuration,
  defaultMembershipDuration,
  defaultRoleDuration,
  isDuration,
  resolveEntry,
  roleFits,
  type Duration,
} from "~/lib/transcript/duration";
import type { rosterUpsertInput } from "~/lib/transcript/manageInput";
import type { z } from "zod";
import { instantToSgDate } from "~/lib/transcript/sgDate";
import { lookupResidents } from "./residents";
import {
  normaliseYearStatus,
  termAcademicYear,
  type FreezeReason,
  type YearStatus,
} from "~/lib/transcript/lifecycle";
import { activeFreeze, termYearOf } from "./freeze";
import { liveMembers } from "./liveRoster";
import { NOT_UNFROZEN } from "./loader";
import {
  correctionSummary,
  joinChanges,
  membershipChangeParts,
} from "~/lib/transcript/corrections";
import { assertCanEditForResidents, logCorrections } from "./residentRecords";
import { getPeriod } from "./periods";
import { actorLabels } from "./residents";

/**
 * A head's (or manager's) view and edits of ONE CCA's transcript annotations
 * for one academic year: how long each member was in, what role and for how
 * long, and the "Additional contribution" text.
 *
 * LIVE BEFORE PUBLISH, FROZEN AFTER. While the year is collecting the member
 * list is the live roster, read by the same resolver the publish step uses; once
 * published it is the frozen entries. Stored values are OVERRIDES; the derived
 * defaults are returned beside them so the screen can show both.
 */

export interface RosterRow {
  userID: string;
  displayName: string | null;
  isHead: boolean;
  defaultDuration: Duration | null;
  /** The stored override, or null for "use the default". */
  duration: Duration | null;
  defaultRoleLabel: string | null;
  roleLabel: string | null;
  defaultRoleDuration: Duration | null;
  roleDuration: Duration | null;
  extraContribution: string | null;
  /** What the transcript will actually say. */
  effective: {
    duration: Duration;
    roleLabel: string | null;
    roleDuration: Duration | null;
    extraContribution: string | null;
  };
}

export interface RosterList {
  status: YearStatus;
  sem2Start: string | null;
  /** Roster rows that could not be resolved to one person (never guessed at). */
  unresolved: number;
  rows: RosterRow[];
  /**
   * Where the list comes from: the FROZEN entries (the CCA has an active freeze
   * for this year), the LIVE members (this is the CCA's term year and it is not
   * frozen), or NONE (no member list was recorded for this year).
   */
  mode: "frozen" | "live" | "none";
  freeze: {
    reason: FreezeReason;
    frozenAt: Date;
    frozenByName: string | null;
    memberCount: number | null;
  } | null;
  /** The year this CCA is working on now (its oldest unfrozen year). */
  termAcademicYear: string;
}

const asDuration = (v: string | null | undefined): Duration | null =>
  isDuration(v) ? v : null;

const blankToNull = (v: string | null | undefined) =>
  v?.trim() ? v.trim() : null;

type StoredEntry = {
  userID: string;
  duration: string | null;
  roleLabel: string | null;
  roleDuration: string | null;
  extraContribution: string | null;
};

/** A frozen entry: it holds the settled values, so there are no defaults. */
function frozenRow(e: StoredEntry, displayName: string | null): RosterRow {
  const duration = asDuration(e.duration) ?? "full";
  const roleDuration = e.roleLabel?.trim()
    ? clampRoleDuration(duration, asDuration(e.roleDuration))
    : null;
  return {
    userID: e.userID,
    displayName,
    isHead: Boolean(e.roleLabel),
    defaultDuration: null,
    duration,
    defaultRoleLabel: null,
    roleLabel: blankToNull(e.roleLabel),
    defaultRoleDuration: null,
    roleDuration,
    extraContribution: blankToNull(e.extraContribution),
    effective: {
      duration,
      roleLabel: blankToNull(e.roleLabel),
      roleDuration,
      extraContribution: blankToNull(e.extraContribution),
    },
  };
}

/** The earliest accepted application among a person's keys. */
function earliestDecision(
  apps: ReadonlyArray<{ userID: string; decidedAt: Date | null }>,
  keys: readonly string[],
): Date | null {
  let decidedAt: Date | null = null;
  for (const a of apps) {
    if (!keys.includes(a.userID) || !a.decidedAt) continue;
    if (!decidedAt || a.decidedAt < decidedAt) decidedAt = a.decidedAt;
  }
  return decidedAt;
}

/** A current member: stored overrides beside the derived defaults. */
function liveRow(m: {
  key: string;
  displayName: string | null;
  isHead: boolean;
  grantedAt: Date | null;
  own: StoredEntry | null;
  decidedAt: Date | null;
  sem2Start: Date | null;
}): RosterRow {
  const { own, decidedAt, sem2Start } = m;
  return {
    userID: m.key,
    displayName: m.displayName,
    isHead: m.isHead,
    defaultDuration: defaultMembershipDuration(decidedAt, sem2Start),
    duration: asDuration(own?.duration),
    defaultRoleLabel: m.isHead ? "Head" : null,
    roleLabel: blankToNull(own?.roleLabel),
    defaultRoleDuration: m.isHead
      ? defaultRoleDuration(m.grantedAt, sem2Start)
      : null,
    roleDuration: asDuration(own?.roleDuration),
    extraContribution: blankToNull(own?.extraContribution),
    effective: resolveEntry(
      own,
      { decidedAt, isHead: m.isHead, grantedAt: m.grantedAt },
      sem2Start,
    ),
  };
}

/**
 * ONE resident's roster row in each of the given CCAs (the CCAs they are a
 * member of for the year), built from that resident's own records in a few
 * batched reads instead of resolving each CCA's whole member list. The rows are
 * the ones `rosterList` gives for them.
 */
export async function rosterRowsFor(
  db: PrismaClient,
  key: string,
  keys: readonly string[],
  academicYear: string,
  ccaIDs: readonly number[],
  now: Date = new Date(),
): Promise<Map<number, { mode: "frozen" | "live"; row: RosterRow }>> {
  const out = new Map<number, { mode: "frozen" | "live"; row: RosterRow }>();
  if (ccaIDs.length === 0) return out;
  const ids = [...ccaIDs];
  const [period, freezes, entries, names] = await Promise.all([
    getPeriod(db, academicYear),
    db.ccaYearFreeze.findMany({
      where: { ccaID: { in: ids }, ...NOT_UNFROZEN },
      select: { ccaID: true, academicYear: true },
    }),
    db.transcriptRosterEntry.findMany({
      where: { academicYear, userID: key, ccaID: { in: ids } },
    }),
    lookupResidents(db, [key]),
  ]);
  const sem2Start = period?.sem2Start ?? null;
  const displayName = names.get(key)?.displayName ?? null;
  const frozenYears = new Map<number, Set<string>>();
  for (const f of freezes) {
    const set = frozenYears.get(f.ccaID) ?? new Set<string>();
    set.add(f.academicYear);
    frozenYears.set(f.ccaID, set);
  }
  const live: number[] = [];
  for (const ccaID of ids) {
    const years = frozenYears.get(ccaID) ?? new Set<string>();
    if (years.has(academicYear)) {
      const e = entries.find((x) => x.ccaID === ccaID && x.frozen);
      if (e) out.set(ccaID, { mode: "frozen", row: frozenRow(e, displayName) });
    } else if (termAcademicYear(years, now) === academicYear) {
      live.push(ccaID);
    }
  }
  if (live.length === 0) return out;
  const [heads, apps] = await Promise.all([
    db.ccaHead.findMany({
      where: { userID: { in: [...keys] }, ccaID: { in: live } },
      select: { ccaID: true, grantedAt: true },
    }),
    db.ccaApplication.findMany({
      where: {
        ccaID: { in: live },
        status: "accepted",
        userID: { in: [...keys] },
      },
      select: { ccaID: true, userID: true, decidedAt: true },
    }),
  ]);
  for (const ccaID of live) {
    const head = heads.find((h) => h.ccaID === ccaID) ?? null;
    out.set(ccaID, {
      mode: "live",
      row: liveRow({
        key,
        displayName,
        isHead: head !== null,
        grantedAt: head?.grantedAt ?? null,
        own: entries.find((x) => x.ccaID === ccaID) ?? null,
        decidedAt: earliestDecision(
          apps.filter((a) => a.ccaID === ccaID),
          keys,
        ),
        sem2Start,
      }),
    });
  }
  return out;
}

export async function rosterList(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
  now: Date = new Date(),
): Promise<RosterList> {
  const [period, freezes] = await Promise.all([
    getPeriod(db, academicYear),
    db.ccaYearFreeze.findMany({ where: { ccaID, ...NOT_UNFROZEN } }),
  ]);
  const sem2Start = period?.sem2Start ?? null;
  const term = termAcademicYear(
    new Set(freezes.map((f) => f.academicYear)),
    now,
  );
  const frozen = freezes.find((f) => f.academicYear === academicYear) ?? null;
  const label = frozen ? await actorLabels(db, [frozen.frozenBy]) : null;
  const base = {
    status: normaliseYearStatus(period?.status),
    sem2Start: sem2Start ? instantToSgDate(sem2Start) : null,
    termAcademicYear: term,
    freeze:
      frozen && label
        ? {
            reason: frozen.reason as FreezeReason,
            frozenAt: frozen.frozenAt,
            frozenByName: label(frozen.frozenBy),
            memberCount: frozen.memberCount ?? null,
          }
        : null,
  };

  if (frozen) {
    const entries = await db.transcriptRosterEntry.findMany({
      where: { academicYear, ccaID, frozen: true },
    });
    const names = await lookupResidents(
      db,
      entries.map((e) => e.userID),
    );
    const rows = entries.map((e) =>
      frozenRow(e, names.get(e.userID)?.displayName ?? null),
    );
    return { ...base, unresolved: 0, rows: sortRows(rows), mode: "frozen" };
  }

  // Not frozen, and not the year this CCA is working on: no list was recorded.
  if (academicYear !== term) {
    return { ...base, unresolved: 0, rows: [], mode: "none" };
  }

  const { members, unresolved } = await liveMembers(db, ccaID);
  const allKeys = [...new Set(members.flatMap((m) => m.keys))];
  const [stored, apps, names] = await Promise.all([
    db.transcriptRosterEntry.findMany({ where: { academicYear, ccaID } }),
    db.ccaApplication.findMany({
      where: { ccaID, status: "accepted", userID: { in: allKeys } },
      select: { userID: true, decidedAt: true },
    }),
    lookupResidents(db, allKeys),
  ]);
  const storedBy = new Map(stored.map((s) => [s.userID, s]));

  const rows = members.map(({ entry, key, keys }) =>
    liveRow({
      key,
      displayName: entry.displayName ?? names.get(key)?.displayName ?? null,
      isHead: entry.isHead,
      grantedAt: entry.grantedAt,
      own: storedBy.get(key) ?? null,
      decidedAt: earliestDecision(apps, keys),
      sem2Start,
    }),
  );
  return { ...base, unresolved, rows: sortRows(rows), mode: "live" };
}

const sortRows = (rows: RosterRow[]) =>
  [...rows].sort(
    (a, b) =>
      Number(b.isHead) - Number(a.isHead) ||
      (a.displayName ?? a.userID).localeCompare(
        b.displayName ?? b.userID,
        "en",
      ),
  );

type UpsertInput = z.infer<typeof rosterUpsertInput>;

/**
 * Who an edit is about. In a FROZEN list it must be someone on the frozen list;
 * otherwise a current member of the CCA, and only for the year the CCA is
 * working on (a year it has moved past has no list to edit).
 */
async function findTarget(
  db: PrismaClient,
  input: UpsertInput,
  now: Date,
): Promise<{ key: string; keys: string[]; frozen: boolean }> {
  const notAMember = new TRPCError({
    code: "BAD_REQUEST",
    message: "NOT_A_MEMBER",
  });
  if (await activeFreeze(db, input.ccaID, input.academicYear)) {
    const entry = await db.transcriptRosterEntry.findFirst({
      where: {
        academicYear: input.academicYear,
        ccaID: input.ccaID,
        userID: input.userID,
        frozen: true,
      },
    });
    if (!entry) throw notAMember;
    return { key: entry.userID, keys: [entry.userID], frozen: true };
  }
  if ((await termYearOf(db, input.ccaID, now)) !== input.academicYear) {
    throw notAMember;
  }
  const { members } = await liveMembers(db, input.ccaID);
  const live = members.find((m) => m.keys.includes(input.userID));
  if (!live) throw notAMember;
  return { key: live.key, keys: live.keys, frozen: false };
}

/**
 * A role must fit inside the membership. Works out the membership period that
 * will be in force after this change (the override, else the default from when
 * the application was accepted), and the role period that will be in force, and
 * refuses a role period that sticks out of it.
 */
async function assertRoleFitsMembership(
  db: PrismaClient,
  input: UpsertInput,
  target: { key: string; keys: string[]; frozen: boolean },
) {
  const [existing, period, apps] = await Promise.all([
    db.transcriptRosterEntry.findUnique({
      where: {
        academicYear_userID_ccaID: {
          academicYear: input.academicYear,
          userID: target.key,
          ccaID: input.ccaID,
        },
      },
    }),
    getPeriod(db, input.academicYear),
    db.ccaApplication.findMany({
      where: {
        ccaID: input.ccaID,
        status: "accepted",
        userID: { in: target.keys },
      },
      select: { decidedAt: true },
    }),
  ]);
  let decidedAt: Date | null = null;
  for (const a of apps) {
    if (a.decidedAt && (!decidedAt || a.decidedAt < decidedAt)) {
      decidedAt = a.decidedAt;
    }
  }
  const duration =
    input.duration !== undefined
      ? input.duration
      : asDuration(existing?.duration);
  const roleDuration =
    input.roleDuration !== undefined
      ? input.roleDuration
      : asDuration(existing?.roleDuration);
  // A frozen entry already holds the resolved membership period.
  const membership = target.frozen
    ? (duration ?? "full")
    : (duration ??
      defaultMembershipDuration(decidedAt, period?.sem2Start ?? null));

  if (roleDuration && !roleFits(membership, roleDuration)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "ROLE_PERIOD_OUTSIDE_MEMBERSHIP",
    });
  }
}

/**
 * Set or clear one member's overrides. The edit guard applies (a published year
 * only for a manager correcting an unlocked resident) and the user
 * must be a CURRENT member of THIS CCA (the same resolver publish uses). Fields
 * left out are untouched; null or blank clears one.
 */
export async function rosterUpsert(
  db: PrismaClient,
  actorUserID: string,
  input: UpsertInput,
  now: Date = new Date(),
) {
  const target = await findTarget(db, input, now);
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      ccaID: input.ccaID,
      academicYear: input.academicYear,
      affectedUserIDs: [target.key],
    },
  );
  await assertRoleFitsMembership(db, input, target);

  const changes = {
    ...(input.duration !== undefined && { duration: input.duration }),
    ...(input.roleLabel !== undefined && { roleLabel: input.roleLabel }),
    ...(input.roleDuration !== undefined && {
      roleDuration: input.roleDuration,
    }),
    ...(input.extraContribution !== undefined && {
      extraContribution: input.extraContribution,
    }),
    updatedBy: actorUserID,
    updatedAt: now,
  };

  // Before the write, so the history can say what really changed.
  const before = guard.correction
    ? await db.transcriptRosterEntry.findUnique({
        where: {
          academicYear_userID_ccaID: {
            academicYear: input.academicYear,
            userID: target.key,
            ccaID: input.ccaID,
          },
        },
      })
    : null;

  const row = await db.$transaction(async (tx) => {
    const row = await tx.transcriptRosterEntry.upsert({
      where: {
        academicYear_userID_ccaID: {
          academicYear: input.academicYear,
          userID: target.key,
          ccaID: input.ccaID,
        },
      },
      create: {
        academicYear: input.academicYear,
        userID: target.key,
        ccaID: input.ccaID,
        frozen: false,
        ...changes,
      },
      update: changes,
    });
    if (guard.correction) {
      const cca = await tx.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaName: true },
      });
      await logCorrections(
        tx,
        guard,
        actorUserID,
        input.academicYear,
        [
          {
            userID: target.key,
            summary: correctionSummary(
              "Roster",
              cca?.ccaName ?? `CCA ${input.ccaID}`,
              joinChanges(membershipChangeParts(before, input)),
            ),
          },
        ],
        now,
      );
    }
    return row;
  });
  return {
    userID: row.userID,
    ccaID: row.ccaID,
    academicYear: row.academicYear,
    duration: asDuration(row.duration),
    roleLabel: blankToNull(row.roleLabel),
    roleDuration: asDuration(row.roleDuration),
    extraContribution: blankToNull(row.extraContribution),
  };
}
