import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  resolveEntry,
  savedChoices,
  type RosterAnnotation,
} from "~/lib/transcript/duration";
import {
  FREEZE_STATE_LABEL,
  normaliseYearStatus,
  type FreezeReason,
} from "~/lib/transcript/lifecycle";
import type { RosterUnresolved } from "~/server/api/services/ccaRoster";
import { keptBySavedEntry, liveMembers } from "./liveRoster";
import { NOT_UNFROZEN } from "./loader";
import { ORDINARY_WRITE, touchYear } from "./residentRecords";
import { actorLabels } from "./residents";
import { retryYearConflicts } from "./yearRetry";

/**
 * LOCKING ("FREEZING") A CCA'S MEMBER LIST FOR A YEAR.
 *
 * Member lists are set by the August application period, so a CCA's list for a
 * year is its LIVE list until "Open transcripts" locks every CCA's list for
 * that year, so the next August recruitment cannot change the transcripts. A
 * lock writes one frozen TranscriptRosterEntry for every live member (and for
 * everyone a saved role or period keeps in the list, see keptBySavedEntry), resolved
 * exactly as the head's screen shows them (overrides, else defaults, with the
 * role inside the membership), and one CcaYearFreeze record, in ONE
 * transaction. Nothing else locks a list: head changes never do.
 *
 * A lock ALWAYS works from the current list, even when the CCA was already
 * locked by an earlier Open transcripts that stopped part way: the year is
 * still collecting, heads may have changed the list or the records since, and
 * the published transcript must show what they see now. The choices a head
 * saved are kept aside in `preFreeze` the first time a lock overwrites an
 * entry, so a lock run again starts from those choices, not from a default
 * ("Head") an earlier lock filled in.
 *
 * Nothing here ever writes CCA / UserCCA / User.
 */

/** Rows per write, so one call never carries thousands of documents. */
export const WRITE_CHUNK = 1000;

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Updates that write the same values, as one `{ ids, data }` per distinct
 * payload and at most WRITE_CHUNK ids each. Most members share a payload (a
 * full year, no role, no extra), so a lock needs a handful of round trips
 * rather than one per member.
 */
export function groupByPayload<D extends object>(
  updates: ReadonlyArray<{ id: string; data: D }>,
): Array<{ ids: string[]; data: D }> {
  const byPayload = new Map<string, { ids: string[]; data: D }>();
  for (const u of updates) {
    const key = JSON.stringify(u.data);
    const group = byPayload.get(key);
    if (group) group.ids.push(u.id);
    else byPayload.set(key, { ids: [u.id], data: u.data });
  }
  return [...byPayload.values()].flatMap((g) =>
    chunked(g.ids, WRITE_CHUNK).map((ids) => ({ ids, data: g.data })),
  );
}

/**
 * The most ONE CCA lock may take, every retry included. Open transcripts stops
 * starting locks after OPEN_STEP_BUDGET_MS, so a request lasts at most that
 * plus one lock; the two add up to 50 s, inside the route's 60 s limit.
 */
export const LOCK_MAX_MS = 35_000;
/** The lock transaction's wait for a connection, and its run time, at most. */
export const LOCK_TX_MAX_WAIT_MS = 5_000;
export const LOCK_TX_TIMEOUT_MS = 25_000;
/** The lock's retries stop starting once they would pass this. */
export const LOCK_RETRY_CAP_MS = LOCK_MAX_MS;
/** A transaction given less time than this is not started: the lock gives up. */
const LOCK_MIN_TX_MS = 2_000;

const isDuplicateKey = (error: unknown) =>
  (error as { code?: string }).code === "P2002";

export interface FreezeResult {
  kind: "frozen";
  academicYear: string;
  memberCount: number;
  /**
   * Roster rows not locked: members the resolver could not match to a
   * person, and extra accounts of a person already counted once.
   */
  unresolvedCount: number;
  reason: FreezeReason;
  /** The CCA had a lock from an earlier run; this one replaced it. */
  replaced: boolean;
}

/**
 * A lock that lost a race: a unique key collided (a roster entry or the lock
 * record was written meanwhile), so the transaction rolled back and the CCA is
 * NOT locked by this try. Labelled as a transient transaction error, so
 * retryWriteConflicts runs the lock again from a fresh read; after the bound
 * it is thrown, and Open transcripts reports the CCA as failed.
 */
function freezeRaceError(cause: unknown): Error {
  return Object.assign(
    new Error("FREEZE_RACE: the member list changed while it was being saved"),
    { errorLabels: ["TransientTransactionError"], cause },
  );
}

export interface FreezeInput {
  ccaID: number;
  /** The year whose transcripts are being opened. */
  academicYear: string;
  actorUserID: string;
  now?: Date;
  /** The Open transcripts run this lock belongs to, stored on the lock record. */
  openRunID?: string;
}

/** Members not matched that a lock record names, at most. */
export const UNRESOLVED_MEMBERS_KEPT = 50;

/**
 * The members not matched, for the lock record: the raw key, and for a key
 * several accounts claim, those accounts' names (as the roster labels them).
 */
async function unresolvedMembers(
  db: PrismaClient,
  entries: ReadonlyArray<RosterUnresolved>,
) {
  const kept = entries.slice(0, UNRESOLVED_MEMBERS_KEPT);
  const ids = [...new Set(kept.flatMap((e) => e.candidateUserIds))];
  const users =
    ids.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, email: true, displayName: true },
        });
  const name = new Map(
    users.map((u) => [u.id, u.displayName ?? u.email ?? u.id]),
  );
  return kept.map((e) => ({
    key: e.key,
    reason: e.reason,
    names:
      e.reason === "AMBIGUOUS_KEY"
        ? e.candidateUserIds.map((id) => name.get(id) ?? id)
        : [],
  }));
}

/**
 * Lock a CCA's member list for a year, as part of Open transcripts, from the
 * CURRENT list. A lock the CCA already has for the year (from a run that
 * stopped part way) is replaced, with its locked entries, in the same
 * transaction. A lock that loses a write conflict, or a race with a roster
 * save, is run again from the start.
 */
export function freezeCca(
  db: PrismaClient,
  input: FreezeInput,
): Promise<FreezeResult> {
  const deadline = Date.now() + LOCK_MAX_MS;
  return retryYearConflicts(() => freezeOnce(db, input, deadline), {
    hardCapMs: LOCK_RETRY_CAP_MS,
  });
}

async function freezeOnce(
  db: PrismaClient,
  input: FreezeInput,
  deadline: number,
): Promise<FreezeResult> {
  const now = input.now ?? new Date();
  const { academicYear } = input;

  const period = await db.transcriptPeriod.findUnique({
    where: { academicYear },
  });
  if (normaliseYearStatus(period?.status) === "published") {
    throw new TRPCError({ code: "FORBIDDEN", message: "PERIOD_PUBLISHED" });
  }

  // Who is in the CCA (upstream data), read first; the transcript entries are
  // read INSIDE the transaction, so the diff below and the writes come from one
  // consistent view and a head's save in between cannot slip past.
  const live = await liveMembers(db, input.ccaID);
  // Each person once: two accounts that resolve to the same person are one
  // member; the extra ones are counted with the unmatched rows.
  const byKey = new Map<string, (typeof live.members)[number]>();
  for (const m of live.members) if (!byKey.has(m.key)) byKey.set(m.key, m);
  const members = [...byKey.values()];
  const unresolved = live.unresolved + (live.members.length - members.length);
  const notMatched = await unresolvedMembers(db, live.unresolvedEntries);

  // The transaction gets what is left of this lock's time, so the wait for a
  // connection plus the run never pass the deadline; with too little left the
  // lock gives up (reported, and the run is continued by the next request).
  const txTimeout = Math.min(
    LOCK_TX_TIMEOUT_MS,
    deadline - Date.now() - LOCK_TX_MAX_WAIT_MS,
  );
  if (txTimeout < LOCK_MIN_TX_MS) {
    throw new TRPCError({ code: "CONFLICT", message: "RECORDS_BUSY" });
  }

  let memberCount = 0;
  let replaced = false;
  try {
    await db.$transaction(
      async (tx) => {
        // Looked at again inside the transaction: an Open that finished
        // meanwhile wins, and this lock writes nothing.
        const inside = await tx.transcriptPeriod.findUnique({
          where: { academicYear },
          select: { status: true },
        });
        if (normaliseYearStatus(inside?.status) === "published") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "PERIOD_PUBLISHED",
          });
        }
        replaced =
          (await tx.ccaYearFreeze.count({
            where: { academicYear, ccaID: input.ccaID, ...NOT_UNFROZEN },
          })) > 0;

        const stored = await tx.transcriptRosterEntry.findMany({
          where: { academicYear, ccaID: input.ccaID },
        });
        const storedBy = new Map(stored.map((e) => [e.userID, e]));
        // Who a saved role or period keeps although they left the live
        // roster (an outgoing head's "Head (Semester 1)"): never a head by
        // default, only what was saved.
        const liveKeys = new Set(live.members.flatMap((m) => m.keys));
        const kept = keptBySavedEntry(stored, liveKeys).map((e) => ({
          key: e.userID,
          isHead: false,
        }));

        const toCreate: Prisma.TranscriptRosterEntryCreateManyInput[] = [];
        const toUpdate: Array<{
          id: string;
          data: Prisma.TranscriptRosterEntryUpdateManyMutationInput;
        }> = [];
        const listed = [
          ...members.map((m) => ({ key: m.key, isHead: m.entry.isHead })),
          ...kept,
        ];
        for (const m of listed) {
          const own = storedBy.get(m.key) ?? null;
          // The head's own choices: kept aside by an earlier lock, else the
          // entry's fields. A default an earlier lock filled in is never one.
          const data = {
            ...lockedFields(savedChoices(own), { isHead: m.isHead }),
            updatedBy: input.actorUserID,
            updatedAt: now,
          };
          if (own) toUpdate.push({ id: own.id, data });
          else
            toCreate.push({
              academicYear,
              userID: m.key,
              ccaID: input.ccaID,
              ...data,
            });
        }

        // The locked list is exactly today's: clear every older lock flag for
        // this CCA and year first (people who have left drop out), including
        // the entries an earlier, part-way lock of this CCA saved.
        await tx.transcriptRosterEntry.updateMany({
          where: { academicYear, ccaID: input.ccaID },
          data: { frozen: false },
        });
        for (const group of groupByPayload(toUpdate)) {
          await tx.transcriptRosterEntry.updateMany({
            where: { id: { in: group.ids } },
            data: group.data,
          });
        }
        for (const chunk of chunked(toCreate, WRITE_CHUNK)) {
          await tx.transcriptRosterEntry.createMany({ data: chunk });
        }
        // One document per year and CCA: an earlier lock's record is replaced.
        memberCount = toCreate.length + toUpdate.length;
        const record = {
          reason: "open",
          frozenAt: now,
          frozenBy: input.actorUserID,
          memberCount,
          unresolvedCount: unresolved,
          unresolvedMembers: notMatched,
          openRunID: input.openRunID ?? null,
          unfrozenAt: null,
          unfrozenBy: null,
          unfreezeReason: null,
        };
        await tx.ccaYearFreeze.upsert({
          where: {
            academicYear_ccaID: { academicYear, ccaID: input.ccaID },
          },
          create: { academicYear, ccaID: input.ccaID, ...record },
          update: record,
        });
        // Last, like every year-scoped save: a claim that commits meanwhile
        // conflicts with this write, and the lock runs again and sees it.
        await touchYear(tx, academicYear, ORDINARY_WRITE, now);
      },
      { maxWait: LOCK_TX_MAX_WAIT_MS, timeout: txTimeout },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // A unique key collided: a roster entry or the lock record was written
    // meanwhile (a head's save, or another Open at the same moment). The
    // transaction rolled back and NOTHING was locked by this try: run it again
    // from a fresh read, which sees what was written and replaces it.
    throw freezeRaceError(error);
  }

  return {
    kind: "frozen",
    academicYear,
    memberCount,
    unresolvedCount: unresolved,
    reason: "open",
    replaced,
  };
}

/** The choices of a member with nothing saved: everything at its default. */
const EMPTY_CHOICES = {
  duration: null,
  roleLabel: null,
  roleDuration: null,
  extraContribution: null,
};

/**
 * What a LOCKED entry holds: the head's saved choices resolved exactly as the
 * head's screen shows them (defaults filled in, the role inside the
 * membership), with the choices themselves kept aside in `preFreeze`. The one
 * place this is worked out, for the lock and for a save to an entry an Open
 * run has already locked, so a locked entry always holds RESOLVED values and
 * its `preFreeze` the head's real choices.
 */
export function lockedFields(
  choices: RosterAnnotation | null,
  live: { isHead: boolean },
) {
  const r = resolveEntry(choices, live);
  return {
    duration: r.duration,
    roleLabel: r.roleLabel,
    roleDuration: r.roleDuration,
    extraContribution: r.extraContribution,
    frozen: true,
    preFreeze: choices ?? EMPTY_CHOICES,
  };
}

/* ---- what the admin table shows --------------------------------------------- */

export interface FreezeRow {
  ccaID: number;
  ccaName: string;
  category: string;
  /** True once the CCA's member list for the year is saved (locked). */
  locked: boolean;
  state: string;
  frozenAt: Date | null;
  frozenByName: string | null;
  memberCount: number | null;
  /** Members the resolver could not match when the list was saved. */
  unresolvedCount: number | null;
  /** Who they were, as far as the lock record names them. */
  unresolvedMembers: Array<{ key: string; reason: string; names: string[] }>;
}

/** Every CCA's member-list lock for one year, for the admin results table. */
export async function listFreezes(
  db: PrismaClient,
  academicYear: string,
): Promise<{ rows: FreezeRow[]; unlocked: number }> {
  const [ccas, freezes] = await Promise.all([
    db.cCA.findMany({ orderBy: { ccaName: "asc" } }),
    db.ccaYearFreeze.findMany({ where: { academicYear, ...NOT_UNFROZEN } }),
  ]);
  const by = new Map(freezes.map((f) => [f.ccaID, f]));
  const label = await actorLabels(
    db,
    freezes.map((f) => f.frozenBy),
  );
  const rows = ccas.map((c): FreezeRow => {
    const f = by.get(c.ccaID);
    return {
      ccaID: c.ccaID,
      ccaName: c.ccaName,
      category: c.category,
      locked: f !== undefined,
      state: FREEZE_STATE_LABEL[f ? "open" : "none"],
      frozenAt: f?.frozenAt ?? null,
      frozenByName: f ? label(f.frozenBy) : null,
      memberCount: f?.memberCount ?? null,
      unresolvedCount: f?.unresolvedCount ?? null,
      unresolvedMembers: f?.unresolvedMembers ?? [],
    };
  });
  return { rows, unlocked: rows.filter((r) => !r.locked).length };
}
