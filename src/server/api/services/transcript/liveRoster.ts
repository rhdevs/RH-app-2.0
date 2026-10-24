import type { PrismaClient } from "@prisma/client";
import {
  hasSavedRoleOrPeriod,
  savedChoices,
  type StoredRosterEntry,
} from "~/lib/transcript/duration";
import {
  resolveRoster,
  type RosterResolved,
  type RosterUnresolved,
} from "~/server/api/services/ccaRoster";
import { personKey } from "./loader";

/**
 * The people in a CCA right now, resolved through the same roster resolver the
 * head screens use. Shared by the head's roster editor and by the freeze, so
 * "who is in the CCA" is read one way only.
 */

export type LiveMemberResolved = {
  entry: RosterResolved;
  key: string;
  keys: string[];
};

/**
 * Every resolved person in the CCA, with the keys that name them, and the
 * roster entries the resolver could not match to one person.
 */
export async function liveMembers(db: PrismaClient, ccaID: number) {
  const roster = await resolveRoster(db, ccaID);
  const seen = new Map<string, LiveMemberResolved>();
  let unresolved = 0;
  const unresolvedEntries: RosterUnresolved[] = [];
  for (const e of [...roster.heads, ...roster.members]) {
    if (e.kind !== "resolved") {
      unresolved += 1;
      unresolvedEntries.push(e);
      continue;
    }
    const key = personKey(
      { email: e.email ?? "", userID: e.storedUserID },
      e.membershipKeys[0] ?? "",
    );
    if (!key) {
      unresolved += 1;
      continue;
    }
    seen.set(e.userId, {
      entry: e,
      key,
      keys: [
        ...new Set([key, e.storedUserID ?? "", ...e.membershipKeys]),
      ].filter((k) => k.length > 0),
    });
  }
  return { members: [...seen.values()], unresolved, unresolvedEntries };
}

/**
 * The people a DELIBERATE saved entry keeps in a CCA's list for the year (a
 * saved role or period, see `hasSavedRoleOrPeriod`) who are NOT in the live
 * roster any more: no longer a member or a head. Collecting years only; they
 * are never a head by default. `liveKeys` holds every key the live members go
 * by, so a person is never listed twice.
 */
export function keptBySavedEntry<
  E extends StoredRosterEntry & { userID: string },
>(stored: readonly E[], liveKeys: ReadonlySet<string>): E[] {
  return stored.filter(
    (e) => !liveKeys.has(e.userID) && hasSavedRoleOrPeriod(savedChoices(e)),
  );
}

/** One person on a CCA's list for a collecting year. */
export interface YearMember {
  key: string;
  keys: string[];
  isHead: boolean;
  displayName: string | null;
  /** Not in the live roster: kept by a saved role or period. */
  kept: boolean;
}

/**
 * A CCA's list for a COLLECTING year, as the head's screen, the transcript and
 * Open transcripts all read it: the live members, plus the people a saved role
 * or period keeps (see `keptBySavedEntry`).
 */
export async function yearMembers(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
): Promise<{ members: YearMember[]; unresolved: number }> {
  const [live, stored] = await Promise.all([
    liveMembers(db, ccaID),
    db.transcriptRosterEntry.findMany({ where: { academicYear, ccaID } }),
  ]);
  const members: YearMember[] = live.members.map((m) => ({
    key: m.key,
    keys: m.keys,
    isHead: m.entry.isHead,
    displayName: m.entry.displayName ?? null,
    kept: false,
  }));
  const liveKeys = new Set(live.members.flatMap((m) => m.keys));
  for (const e of keptBySavedEntry(stored, liveKeys)) {
    members.push({
      key: e.userID,
      keys: [e.userID],
      isHead: false,
      displayName: null,
      kept: true,
    });
  }
  return { members, unresolved: live.unresolved };
}
