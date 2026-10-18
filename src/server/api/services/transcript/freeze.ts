import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { resolveEntry, savedChoices } from "~/lib/transcript/duration";
import { retryWriteConflicts } from "~/lib/transcript/writeConflict";
import {
  FREEZE_STATE_LABEL,
  normaliseYearStatus,
  type FreezeReason,
} from "~/lib/transcript/lifecycle";
import { liveMembers } from "./liveRoster";
import { NOT_UNFROZEN } from "./loader";
import { actorLabels } from "./residents";

/**
 * LOCKING ("FREEZING") A CCA'S MEMBER LIST FOR A YEAR.
 *
 * Member lists are set by the August application period, so a CCA's list for a
 * year is its LIVE list until "Open transcripts" locks every CCA's list for
 * that year, so the next August recruitment cannot change the transcripts. A
 * lock writes one frozen TranscriptRosterEntry for every live member, resolved
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
  return retryWriteConflicts(() => freezeOnce(db, input));
}

async function freezeOnce(
  db: PrismaClient,
  input: FreezeInput,
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

        const toCreate: Prisma.TranscriptRosterEntryCreateManyInput[] = [];
        const toUpdate: Array<{
          id: string;
          data: Prisma.TranscriptRosterEntryUpdateManyMutationInput;
        }> = [];
        for (const m of members) {
          const own = storedBy.get(m.key) ?? null;
          // The head's own choices: kept aside by an earlier lock, else the
          // entry's fields. A default an earlier lock filled in is never one.
          const choices = savedChoices(own);
          const r = resolveEntry(choices, { isHead: m.entry.isHead });
          const data = {
            duration: r.duration,
            roleLabel: r.roleLabel,
            roleDuration: r.roleDuration,
            extraContribution: r.extraContribution,
            frozen: true,
            preFreeze: choices ?? EMPTY_CHOICES,
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
      },
      { maxWait: 10_000, timeout: 60_000 },
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
    };
  });
  return { rows, unlocked: rows.filter((r) => !r.locked).length };
}
