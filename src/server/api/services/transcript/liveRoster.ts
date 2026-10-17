import type { PrismaClient } from "@prisma/client";
import {
  resolveRoster,
  type RosterResolved,
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

/** Every resolved person in the CCA, with the keys that name them. */
export async function liveMembers(db: PrismaClient, ccaID: number) {
  const roster = await resolveRoster(db, ccaID);
  const seen = new Map<string, LiveMemberResolved>();
  let unresolved = 0;
  for (const e of [...roster.heads, ...roster.members]) {
    if (e.kind !== "resolved") {
      unresolved += 1;
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
  return { members: [...seen.values()], unresolved };
}
