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
import { yearMembers } from "./liveRoster";
import { NOT_UNFROZEN } from "./loader";
import {
  correctionSummary,
  joinChanges,
  membershipChangeParts,
} from "~/lib/transcript/corrections";
import {
  assertCanEditForResidents,
  assertCheckedResidents,
  assertStillCollecting,
  yearWrite,
  logCorrections,
} from "./residentRecords";
import { lockedFields } from "./freeze";
import { getPeriod } from "./periods";
import { actorLabels } from "./residents";

/**
 * A head's (or manager's) view and edits of ONE CCA's transcript annotations
 * for one academic year: how long each member was in, what role and for how
 * long, and the "Additional Contributions" text.
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
  /**
   * No longer in the CCA, but a saved role or period keeps them on this
   * year's list (collecting years only).
   */
  kept?: boolean;
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

/** The role a current head has by default, stored for a part-year role period. */
const HEAD_ROLE = "Head";

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
  kept?: boolean;
}): RosterRow {
  const { own } = m;
  return {
    userID: m.key,
    displayName: m.displayName,
    isHead: m.isHead,
    ...(m.kept && { kept: true }),
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

  const { members, unresolved } = await yearMembers(db, ccaID, academicYear);
  const allKeys = [...new Set(members.flatMap((m) => m.keys))];
  const [stored, names] = await Promise.all([
    db.transcriptRosterEntry.findMany({ where: { academicYear, ccaID } }),
    lookupResidents(db, allKeys),
  ]);
  const storedBy = new Map(stored.map((s) => [s.userID, s]));

  const rows = members.map((m) =>
    liveRow({
      key: m.key,
      displayName: m.displayName ?? names.get(m.key)?.displayName ?? null,
      isHead: m.isHead,
      own: savedChoices(storedBy.get(m.key)),
      kept: m.kept,
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
 * CCA's locked list; while collecting, someone on the year's list (a current
 * member, or someone a saved role or period keeps). Who may edit which year at
 * all is the edit guard's business.
 */
async function findTarget(
  db: PrismaClient,
  input: UpsertInput,
): Promise<{ key: string; keys: string[]; frozen: boolean; isHead: boolean }> {
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
    return {
      key: entry.userID,
      keys: [entry.userID],
      frozen: true,
      isHead: false,
    };
  }
  const { members } = await yearMembers(db, input.ccaID, input.academicYear);
  const member = members.find((m) => m.keys.includes(input.userID));
  if (!member) throw notAMember;
  // The same live-head input the lock resolves this member with.
  return {
    key: member.key,
    keys: member.keys,
    frozen: false,
    isHead: member.isHead,
  };
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
  target: { key: string; frozen: boolean; isHead: boolean },
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

  // With no role to show, no role period is stored, so there is nothing to fit.
  const shown = shownRole(
    target,
    row,
    input.roleLabel !== undefined ? { roleLabel: input.roleLabel } : {},
  );
  if (shown && roleDuration && !roleFits(membership, roleDuration)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "ROLE_PERIOD_OUTSIDE_MEMBERSHIP",
    });
  }
}

type RosterChanges = Partial<RosterAnnotation>;

/**
 * The role the entry will show after this change, or null: the one the
 * transcript would show. A current head's blank role is the "Head" default;
 * in an open year, it is the locked entry's own role.
 */
function shownRole(
  target: { frozen: boolean; isHead: boolean },
  current: RosterAnnotation | null,
  changes: RosterChanges,
) {
  const base = target.frozen ? current : savedChoices(current);
  const merged = { ...base, ...changes };
  return target.frozen
    ? blankToNull(merged.roleLabel)
    : resolveEntry(merged, { isHead: target.isHead }).roleLabel;
}

/**
 * A role period is stored only beside a role: when the role the entry will
 * have after this change is blank, its role period is stored as null. A
 * current head's blank role is the "Head" default, so their role period stays.
 */
function withoutOrphanRolePeriod(
  target: { frozen: boolean; isHead: boolean },
  current: RosterAnnotation | null,
  changes: RosterChanges,
): RosterChanges {
  return shownRole(target, current, changes)
    ? changes
    : { ...changes, roleDuration: null };
}

/**
 * A current head who saves only a Semester 1 or Semester 2 role period or
 * membership period, with the role left blank, has "Head" stored as the role,
 * explicitly. Their role is the "Head" default only while they head the CCA;
 * after a handover the default is gone, and "Head (Semester 1)" with it. A
 * stored "Head" stays if the period later goes back to a full year; clearing
 * the role and the periods together (Reset) stores neither.
 */
function withHeadRoleStored(
  target: { frozen: boolean; isHead: boolean },
  current: RosterAnnotation | null,
  changes: RosterChanges,
): RosterChanges {
  if (target.frozen || !target.isHead) return changes;
  const merged = { ...savedChoices(current), ...changes };
  const partYear = [merged.roleDuration, merged.duration].some(
    (d) => d === "sem1" || d === "sem2",
  );
  return partYear && !blankToNull(merged.roleLabel)
    ? { ...changes, roleLabel: HEAD_ROLE }
    : changes;
}

/**
 * What a save writes into an existing entry. In an open year (a correction)
 * the locked entry's own fields are changed. While collecting, an entry an Open
 * run has already locked keeps holding RESOLVED values, with the head's real
 * choices (this change on top) kept aside in `preFreeze`, so the year can be
 * opened from it as it is; an entry an earlier, part-way lock wrote into but no
 * longer holds goes back to the saved choices, with this change on top. Either
 * way a default a lock filled in never turns into a choice.
 */
function collectingUpdate(
  target: { frozen: boolean; isHead: boolean },
  current:
    | (RosterAnnotation & {
        frozen: boolean | null;
        preFreeze: RosterAnnotation | null;
      })
    | null,
  changes: RosterChanges,
  correction: boolean,
) {
  // A correction changes the locked entry's own fields, whatever was read of
  // the year before the guard.
  if (target.frozen || correction || !current) return changes;
  if (current.frozen === true) {
    const merged = { ...savedChoices(current)!, ...changes };
    return lockedFields(merged, { isHead: target.isHead });
  }
  if (current.preFreeze) {
    return {
      ...savedChoices(current),
      ...changes,
      preFreeze: { unset: true },
    };
  }
  return changes;
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
  const found = await findTarget(db, input);
  const guard = await assertCanEditForResidents(
    db,
    { userID: actorUserID },
    {
      ccaID: input.ccaID,
      academicYear: input.academicYear,
      affectedUserIDs: [found.key],
    },
  );
  // A correction is for an open year: if the year opened between the read
  // above and the guard, act on the LOCKED entry, never on the live list.
  const target =
    guard.correction && !found.frozen ? await findTarget(db, input) : found;
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
  };
  const stamp = { updatedBy: actorUserID, updatedAt: now };

  // Logged when it is a correction, or the actor's change to their own entry.
  const logged = guard.correction || target.key === actorUserID;

  const row = await yearWrite(db, async (tx) => {
    await assertStillCollecting(tx, input.academicYear, guard);
    assertCheckedResidents(guard, [target.key]);
    // Before the write, so the history can say what really changed. Read in
    // the transaction, so a retry diffs against what is there now.
    const before = logged
      ? await tx.transcriptRosterEntry.findUnique({
          where: {
            academicYear_userID_ccaID: {
              academicYear: input.academicYear,
              userID: target.key,
              ccaID: input.ccaID,
            },
          },
        })
      : null;
    // Read in the transaction, so a lock written since the checks above is seen.
    const current = await tx.transcriptRosterEntry.findUnique({
      where: {
        academicYear_userID_ccaID: {
          academicYear: input.academicYear,
          userID: target.key,
          ccaID: input.ccaID,
        },
      },
      select: {
        frozen: true,
        preFreeze: true,
        duration: true,
        roleLabel: true,
        roleDuration: true,
        extraContribution: true,
      },
    });
    const saved = withoutOrphanRolePeriod(
      target,
      current,
      withHeadRoleStored(target, current, changes),
    );
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
        ...saved,
        ...stamp,
      },
      update: {
        ...collectingUpdate(target, current, saved, guard.correction),
        ...stamp,
      },
    });
    if (logged) {
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
              joinChanges(
                membershipChangeParts(before, {
                  ...input,
                  // The "Head" stored for a head's part-year role period.
                  ...(saved.roleLabel !== undefined && {
                    roleLabel: saved.roleLabel,
                  }),
                }),
              ),
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
