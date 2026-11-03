import type { PrismaClient } from "@prisma/client";

import type { IdentifierLine } from "~/lib/auxPoints";
import { MATRIC_RE } from "~/lib/schemas/profile";
import { bulkResolver } from "~/server/api/routers/admin";
import { lookupResidents } from "~/server/api/services/transcript/residents";

export type ResolvedLine = IdentifierLine & { userID: string };

/**
 * Why a pasted line named nobody. NOT_FOUND: no account answers to it.
 * AMBIGUOUS: the matric is on more than one account. REPEATED: an earlier
 * line already named the same person.
 */
export type UnresolvedLine = IdentifierLine & {
  reason: "NOT_FOUND" | "AMBIGUOUS" | "REPEATED";
};

/**
 * Pasted matrics, emails or NUSNET ids -> canonical userIDs, keeping each
 * line number so the unknown ones can be listed back. Never skips a line
 * silently: every line is either found or unresolved. Only people with an
 * account are found, since AUX is filed under the account's key.
 */
export async function resolveAuxIdentifiers(
  db: PrismaClient,
  lines: readonly IdentifierLine[],
): Promise<{ found: ResolvedLine[]; unknown: UnresolvedLine[] }> {
  const isMatric = (raw: string) =>
    !raw.includes("@") && MATRIC_RE.test(raw.toUpperCase());

  const matrics = [
    ...new Set(
      lines.filter((l) => isMatric(l.raw)).map((l) => l.raw.toUpperCase()),
    ),
  ];
  const holders = new Map<string, string[]>();
  if (matrics.length > 0) {
    const rows = await db.userMatric.findMany({
      where: { matric: { in: matrics } },
      select: { userID: true, matric: true },
    });
    for (const r of rows) {
      const key = r.matric.toUpperCase();
      holders.set(key, [...(holders.get(key) ?? []), r.userID]);
    }
  }
  const others = lines.filter((l) => !isMatric(l.raw));
  const resolve = await bulkResolver(
    db,
    others.map((l) => ({ identifier: l.raw })),
  );

  const candidates = lines.map((l) => {
    if (!isMatric(l.raw)) return { l, userID: resolve(l.raw)?.userID ?? null };
    const ids = [...new Set(holders.get(l.raw.toUpperCase()) ?? [])];
    if (ids.length > 1) return { l, userID: null, ambiguous: true };
    return { l, userID: ids[0] ?? null };
  });

  const accounts = await lookupResidents(
    db,
    candidates.flatMap((c) => (c.userID ? [c.userID] : [])),
  );

  const seen = new Set<string>();
  const found: ResolvedLine[] = [];
  const unknown: UnresolvedLine[] = [];
  for (const c of candidates) {
    if ("ambiguous" in c) {
      unknown.push({ ...c.l, reason: "AMBIGUOUS" });
      continue;
    }
    const key = c.userID ? accounts.get(c.userID)?.userID : undefined;
    if (!key) {
      unknown.push({ ...c.l, reason: "NOT_FOUND" });
    } else if (seen.has(key)) {
      unknown.push({ ...c.l, reason: "REPEATED" });
    } else {
      seen.add(key);
      found.push({ ...c.l, userID: key });
    }
  }
  return { found, unknown };
}

export type AuxPerson = {
  userID: string;
  name: string | null;
  matric: string | null;
};

/** Names and full matrics for the given keys (the JCRC export needs matrics). */
export async function auxPeople(
  db: PrismaClient,
  userIDs: readonly string[],
): Promise<Map<string, AuxPerson>> {
  const unique = [...new Set(userIDs)];
  const [names, matricRows] = await Promise.all([
    lookupResidents(db, unique),
    unique.length === 0
      ? Promise.resolve([])
      : db.userMatric.findMany({
          where: { userID: { in: unique } },
          select: { userID: true, matric: true },
        }),
  ]);
  const matrics = new Map(matricRows.map((r) => [r.userID, r.matric]));
  return new Map(
    unique.map((userID) => [
      userID,
      {
        userID,
        name: names.get(userID)?.displayName ?? null,
        matric: matrics.get(userID) ?? null,
      },
    ]),
  );
}
