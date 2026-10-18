import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  clampRoleDuration,
  isDuration,
  resolveEntry,
  roleFits,
  savedChoices,
  type Duration,
  type RosterAnnotation,
} from "~/lib/transcript/duration";
import type { rosterUpsertInput } from "~/lib/transcript/manageInput";
import type { z } from "zod";
import { lookupResidents } from "./residents";
import {
  normaliseYearStatus,
  type FreezeReason,
  type YearStatus,
} from "~/lib/transcript/lifecycle";
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
 * defaults are returned beside them so the screen can show both. While
 * collecting, an entry's overrides are its SAVED choices (`savedChoices`): an
 * Open transcripts that stopped part way may have written resolved values into
 * it, and those are not the head's choices.
 */

export interface RosterRow {
  userID: string;
  displayName: string | null;
  isHead: boolean;
  /** "full" on a live list (the default a row goes back to); null on a locked one. */
  defaultDuration: Duration | null;
  /** The stored choice, or null for the default (a full year). */
  duration: Duration | null;
  defaultRoleLabel: string | null;
  roleLabel: string | null;
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
  /** Roster rows that could not be resolved to one person (never guessed at). */
  unresolved: number;
  rows: RosterRow[];
  /**
   * Where the list comes from: the LOCKED entries (transcripts for the year are
   * open), the LIVE members (the year is still collecting), or NONE (open, but
   * this CCA had no list saved).
   */
  mode: "frozen" | "live" | "none";
  freeze: {
    reason: FreezeReason;
    frozenAt: Date;
    frozenByName: string | null;
    memberCount: number | null;
  } | null;
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

/** A current member: saved choices beside the defaults (a full year, "Head"). */
function liveRow(m: {
  key: string;
  displayName: string | null;
  isHead: boolean;
  own: RosterAnnotation | null;
}): RosterRow {
  const { own } = m;
  return {
    userID: m.key,
    displayName: m.displayName,
    isHead: m.isHead,
    defaultDuration: "full",
    duration: asDuration(own?.duration),
    defaultRoleLabel: m.isHead ? "Head" : null,
    roleLabel: blankToNull(own?.roleLabel),
    roleDuration: asDuration(own?.roleDuration),
    extraContribution: blankToNull(own?.extraContribution),
    effective: resolveEntry(own, { isHead: m.isHead }),
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
  // Kept for callers; which list is read depends only on the year's status.
  _now: Date = new Date(),
): Promise<Map<number, { mode: "frozen" | "live"; row: RosterRow }>> {
  const out = new Map<number, { mode: "frozen" | "live"; row: RosterRow }>();
  if (ccaIDs.length === 0) return out;
  const ids = [...ccaIDs];
  const [period, entries, names] = await Promise.all([
    getPeriod(db, academicYear),
    db.transcriptRosterEntry.findMany({
      where: { academicYear, userID: key, ccaID: { in: ids } },
    }),
    lookupResidents(db, [key]),
  ]);
  const displayName = names.get(key)?.displayName ?? null;
  // An open (published) year reads the locked lists; otherwise the live ones.
  const published = normaliseYearStatus(period?.status) === "published";
  const live: number[] = [];
  for (const ccaID of ids) {
    if (published) {
      const e = entries.find((x) => x.ccaID === ccaID && x.frozen);
      if (e) out.set(ccaID, { mode: "frozen", row: frozenRow(e, displayName) });
    } else {
      live.push(ccaID);
    }
  }
  if (live.length === 0) return out;
  const heads = await db.ccaHead.findMany({
    where: { userID: { in: [...keys] }, ccaID: { in: live } },
    select: { ccaID: true },
  });
  for (const ccaID of live) {
    const head = heads.find((h) => h.ccaID === ccaID) ?? null;
    out.set(ccaID, {
      mode: "live",
      row: liveRow({
        key,
        displayName,
        isHead: head !== null,
        own: savedChoices(entries.find((x) => x.ccaID === ccaID)),
      }),
    });
  }
  return out;
}

export async function rosterList(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
  // Kept for callers; which list is read depends only on the year's status.
  _now: Date = new Date(),
): Promise<RosterList> {
  const period = await getPeriod(db, academicYear);
  const published = normaliseYearStatus(period?.status) === "published";
  // An open (published) year shows the list as it was locked; a collecting
  // year shows the live list.
  const frozen = published
    ? await db.ccaYearFreeze.findFirst({
        where: { ccaID, academicYear, ...NOT_UNFROZEN },
      })
    : null;
  const label = frozen ? await actorLabels(db, [frozen.frozenBy]) : null;
  const base = {
    status: normaliseYearStatus(period?.status),
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

  // Open, but this CCA had no list saved (it did not exist then): no members.
  if (published) {
    return { ...base, unresolved: 0, rows: [], mode: "none" };
  }

  const { members, unresolved } = await liveMembers(db, ccaID);
  const allKeys = [...new Set(members.flatMap((m) => m.keys))];
  const [stored, names] = await Promise.all([
    db.transcriptRosterEntry.findMany({ where: { academicYear, ccaID } }),
    lookupResidents(db, allKeys),
  ]);
  const storedBy = new Map(stored.map((s) => [s.userID, s]));

  const rows = members.map(({ entry, key }) =>
    liveRow({
      key,
      displayName: entry.displayName ?? names.get(key)?.displayName ?? null,
      isHead: entry.isHead,
      own: savedChoices(storedBy.get(key)),
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
 * Who an edit is about. In an open (published) year it must be someone on the
 * CCA's locked list; while collecting, a current member of the CCA (the live
 * list). Who may edit which year at all is the edit guard's business.
 */
async function findTarget(
  db: PrismaClient,
  input: UpsertInput,
): Promise<{ key: string; keys: string[]; frozen: boolean }> {
  const notAMember = new TRPCError({
    code: "BAD_REQUEST",
    message: "NOT_A_MEMBER",
  });
  const period = await getPeriod(db, input.academicYear);
  if (normaliseYearStatus(period?.status) === "published") {
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
  target: { key: string; frozen: boolean },
) {
  const row = await db.transcriptRosterEntry.findUnique({
    where: {
      academicYear_userID_ccaID: {
        academicYear: input.academicYear,
        userID: target.key,
        ccaID: input.ccaID,
      },
    },
  });
  // A locked entry holds the settled values; otherwise the saved choices.
  const existing = target.frozen ? row : savedChoices(row);
  const duration =
    input.duration !== undefined
      ? input.duration
      : asDuration(existing?.duration);
  const roleDuration =
    input.roleDuration !== undefined
      ? input.roleDuration
      : asDuration(existing?.roleDuration);
  // No stored choice means a full year.
  const membership = duration ?? "full";

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
  const target = await findTarget(db, input);
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
  // While collecting, an entry an earlier, part-way Open wrote resolved values
  // into goes back to the head's saved choices, with this change on top, so a
  // default that lock filled in never turns into a choice.
  const kept = target.frozen
    ? null
    : await db.transcriptRosterEntry.findUnique({
        where: {
          academicYear_userID_ccaID: {
            academicYear: input.academicYear,
            userID: target.key,
            ccaID: input.ccaID,
          },
        },
        select: { preFreeze: true },
      });
  const update = kept?.preFreeze
    ? {
        ...savedChoices({ preFreeze: kept.preFreeze }),
        ...changes,
        preFreeze: { unset: true },
      }
    : changes;

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
      update,
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
