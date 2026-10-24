import type { PrismaClient } from "@prisma/client";

import { canonicalUserID } from "~/lib/identity";
import { resolveRoster } from "~/server/api/services/ccaRoster";

/**
 * A CCA's roster as the member directory presents it: heads and members, each
 * with the profile details (matric, block, telegram, bio) resolved from the EXACT
 * User.id the roster matched, and the matric looked up under every key a member
 * might be filed under.
 *
 * Extracted unchanged from `cca.memberDirectory` so that the JCRC flat-points
 * export reads the same data the same way. THIS FUNCTION DOES NO AUTHORISATION:
 * every caller must have passed its own guard first (memberDirectory uses
 * assertHeadsCca; ccaPoints.bundleExportData is a role-manager procedure with a
 * live capability re-check).
 */
export async function buildDirectoryEntries(db: PrismaClient, ccaID: number) {
  const roster = await resolveRoster(db, ccaID);
  const entries = [...roster.heads, ...roster.members];

  const userIds: string[] = [];
  const matricKeys = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "resolved") continue;
    userIds.push(e.userId);
    for (const k of e.membershipKeys) matricKeys.add(k);
    if (e.storedUserID) matricKeys.add(e.storedUserID);
    const cid = canonicalUserID(e.email);
    if (cid) matricKeys.add(cid);
  }

  const [profiles, matrics] = await Promise.all([
    userIds.length === 0
      ? Promise.resolve(
          [] as {
            id: string;
            telegramHandle: string | null;
            block: number | null;
            bio: string | null;
          }[],
        )
      : db.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            telegramHandle: true,
            block: true,
            bio: true,
          },
        }),
    matricKeys.size === 0
      ? Promise.resolve([] as { userID: string; matric: string }[])
      : db.userMatric.findMany({
          where: { userID: { in: [...matricKeys] } },
          select: { userID: true, matric: true },
        }),
  ]);

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const matricByKey = new Map(matrics.map((m) => [m.userID, m.matric]));

  const directory = entries.map((e) => {
    const role: "Head" | "Member" = e.isHead ? "Head" : "Member";
    if (e.kind !== "resolved") {
      return {
        rowKey: `k:${e.key}`,
        resolved: false,
        role,
        name: null,
        email: null,
        userID: e.key,
        matric: null,
        block: null,
        telegramHandle: null,
        bio: null,
        membershipRecords: e.userCcaRowCount,
        joinedAt: e.grantedAt ? e.grantedAt.toISOString() : null,
        note:
          e.reason === "AMBIGUOUS_KEY"
            ? "Ambiguous record — more than one account claims this membership."
            : "Unmatched record — no account matches this membership key.",
      };
    }
    const prof = profileById.get(e.userId);
    let matric: string | null = null;
    const cid = canonicalUserID(e.email);
    for (const k of [...e.membershipKeys, e.storedUserID, cid]) {
      if (k && matricByKey.has(k)) {
        matric = matricByKey.get(k) ?? null;
        if (matric) break;
      }
    }
    return {
      rowKey: `u:${e.userId}`,
      resolved: true,
      role,
      name: e.displayName,
      email: e.email,
      userID: e.storedUserID,
      matric,
      block: prof?.block ?? null,
      telegramHandle: prof?.telegramHandle ?? null,
      bio: prof?.bio ?? null,
      membershipRecords: e.userCcaRowCount,
      joinedAt: e.grantedAt ? e.grantedAt.toISOString() : null,
      note: null,
    };
  });

  return { cca: roster.cca, entries: directory };
}
