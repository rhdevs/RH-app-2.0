import type { PrismaClient } from "@prisma/client";

import { canonicalUserID } from "~/lib/identity";

/**
 * CCA ROSTER RESOLUTION — the inversion of getMyCCAs.
 *
 * getMyCCAs (routers/user.ts) reads the union of three membership sources keyed
 * off the CALLER'S OWN session. This does the reverse: given a ccaID, produce
 * everyone in it. The two are NOT symmetric.
 *
 *   CcaHead      indexed on ccaID, canonical userIDs only. Clean.
 *   UserCCA      NO index on ccaID (collection scan). userID is MIXED — mostly
 *                A-format matric, canonical E-format only on rows the account
 *                merge reassigned. NO compound unique, so duplicate rows exist.
 *   User.userCCA an Int[] that EXISTS in the database but is NOT declared in
 *                `model User`, so it is reachable only through findRaw.
 *
 * And there is NO reverse query from a canonical userID to a User row — see
 * admin.listUsers, which guesses the email. So resolution can fail, and it can
 * be AMBIGUOUS (User.userID has no unique index; dedupe-users.mjs exists
 * because duplicate accounts were real).
 *
 * NEITHER FAILURE IS FILTERED AWAY. 07-cca-future.md §3 names the client-side
 * .filter() as the anti-pattern that hides the real data problem. Unresolved
 * and ambiguous rows are returned as first-class entries and rendered amber.
 *
 * AND AMBIGUITY IS NEVER RESOLVED BY PICKING. Attributing one person's
 * membership to another is a failure indistinguishable from success.
 */

export type RosterSource = "ccaHead" | "userCCA" | "embedded";

export type RosterResolved = {
  kind: "resolved";
  /** THE dedupe key. Collapses a person's A-format and canonical keys. */
  userId: string;
  email: string;
  displayName: string | null;
  storedUserID: string | null;
  isHead: boolean;
  grantedAt: Date | null;
  sources: RosterSource[];
  /** Every membership key that resolved to this user. May legitimately be 2. */
  membershipKeys: string[];
  /** UserCCA rows for this CCA naming this person. >1 means duplicate rows. */
  userCcaRowCount: number;
};

export type RosterUnresolved = {
  kind: "unresolved";
  /** THE dedupe key for this bucket — a raw membership key string. */
  key: string;
  isHead: boolean;
  grantedAt: Date | null;
  sources: RosterSource[];
  userCcaRowCount: number;
  reason: "NO_USER_ROW" | "AMBIGUOUS_KEY";
  /** For AMBIGUOUS_KEY: the User.ids that claimed it, so it is investigable. */
  candidateUserIds: string[];
};

export type RosterEntry = RosterResolved | RosterUnresolved;

export type RosterDrift = {
  unresolvedCount: number;
  ambiguousCount: number;
  duplicateUserCcaRows: number;
  headsUnresolved: number;
  ccaMissing: boolean;
};

export type Roster = {
  cca: { ccaID: number; ccaName: string | null; category: string | null };
  heads: RosterEntry[];
  members: RosterEntry[];
  counts: { heads: number; members: number; total: number };
  drift: RosterDrift;
};

/**
 * The shape user.findRaw yields under our projection. Untyped BSON: every field
 * is `unknown` and is narrowed at the use site, never trusted. Same defence
 * getMyCCAs applies.
 */
type RawUserDoc = {
  _id?: { $oid?: string } | string;
  email?: unknown;
  displayName?: unknown;
  userID?: unknown;
};

type Hydrated = {
  id: string;
  email: string;
  displayName: string | null;
  userID: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/**
 * findRaw returns EXTENDED JSON: _id is { $oid: "..." }, not the plain string a
 * typed read gives. Forgetting this unwrap is silent and nasty — the User.id
 * dedupe would never collide, so every embedded-source member would double-list
 * alongside their UserCCA row, looking like a data problem rather than a bug.
 */
const oid = (v: RawUserDoc["_id"]): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.$oid === "string") return v.$oid;
  return null;
};

export async function resolveRoster(
  db: PrismaClient,
  ccaID: number,
): Promise<Roster> {
  /* ---- the three inversions, plus the CCA record itself ---- */

  const [ccaRow, headRows, ccaRows, embeddedRaw] = await Promise.all([
    db.cCA.findUnique({
      where: { ccaID },
      select: { ccaID: true, ccaName: true, category: true },
    }),

    // Source C — CcaHead. Indexed. Canonical keys only (CH-1).
    db.ccaHead.findMany({
      where: { ccaID },
      select: { userID: true, grantedAt: true },
      orderBy: { userID: "asc" },
    }),

    // Source B — UserCCA. COLLECTION SCAN today (no @@index([ccaID])). `id` is
    // selected so a duplicate row is COUNTABLE rather than invisible.
    db.userCCA.findMany({
      where: { ccaID },
      select: { id: true, userID: true },
    }),

    // Source A — the embedded User.userCCA Int[]. Mongo matches a scalar
    // element-wise against an array field, so { userCCA: ccaID } matches any
    // document whose array CONTAINS ccaID. (verify-cca-roster.mjs check [1]
    // cross-checks this against $elemMatch and fails the build if it diverges.)
    //
    // The projection is an ALLOWLIST, so this path is STRUCTURALLY incapable of
    // returning passwordHash — the same property the typed `select` buys
    // elsewhere, obtained the same way.
    db.user.findRaw({
      filter: { userCCA: ccaID },
      options: {
        projection: { _id: 1, email: 1, displayName: 1, userID: 1 },
      },
    }) as unknown as Promise<RawUserDoc[]>,
  ]);

  /* ---- hydration: membership key -> User row ---- */

  const keys = [
    ...new Set([
      ...headRows.map((r) => r.userID),
      ...ccaRows.map((r) => r.userID),
    ]),
  ].filter((k): k is string => typeof k === "string" && k.length > 0);

  // BOTH lookups run over the FULL key set rather than partitioning by format
  // first. Partitioning looks tidier and is wrong: UserCCA.userID is mixed AND
  // User.userID holds an E-format value on merge-reassigned rows, so either
  // format can land on either side.
  const guessedEmails = keys.map((k) => `${k.toLowerCase()}@u.nus.edu`);

  const [byEmailRows, byStoredRows] = await Promise.all([
    keys.length === 0
      ? Promise.resolve([])
      : db.user.findMany({
          where: { email: { in: guessedEmails, mode: "insensitive" } },
          // NEVER a bare findMany: passwordHash must not reach the client, and
          // passwordHash-less Google-adapter rows throw on a full read (I-2).
          select: { id: true, email: true, displayName: true, userID: true },
        }),
    keys.length === 0
      ? Promise.resolve([])
      : db.user.findMany({
          where: { userID: { in: keys } },
          select: { id: true, email: true, displayName: true, userID: true },
        }),
  ]);

  // key -> the set of User rows claiming it, keyed by User.id so one row
  // claiming a key by BOTH paths counts once. A set of size > 1 is AMBIGUOUS
  // and is surfaced as such rather than resolved.
  const claims = new Map<string, Map<string, Hydrated>>();
  const claim = (key: string, u: Hydrated) => {
    let s = claims.get(key);
    if (!s) claims.set(key, (s = new Map()));
    s.set(u.id, u);
  };

  for (const u of byEmailRows) {
    // C9: canonicalize and DROP nulls rather than storing under a "" sentinel.
    // Without this a non-NUS row enters at key "" and matches a ""-keyed
    // membership row, attributing a stranger to it. listUsers has the same
    // guard for the same reason.
    const cid = canonicalUserID(u.email);
    if (cid !== null) {
      claim(cid, {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        userID: u.userID,
      });
    }
  }
  for (const u of byStoredRows) {
    const sid = str(u.userID);
    if (sid !== null) {
      claim(sid, {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        userID: u.userID,
      });
    }
  }

  /* ---- the merge ---- */

  const resolved = new Map<string, RosterResolved>();
  const unresolved = new Map<string, RosterUnresolved>();

  const touchResolved = (u: Hydrated, source: RosterSource) => {
    let e = resolved.get(u.id);
    if (!e) {
      e = {
        kind: "resolved",
        userId: u.id,
        email: u.email,
        displayName: u.displayName,
        storedUserID: u.userID,
        isHead: false,
        grantedAt: null,
        sources: [],
        membershipKeys: [],
        userCcaRowCount: 0,
      };
      resolved.set(u.id, e);
    }
    if (!e.sources.includes(source)) e.sources.push(source);
    return e;
  };

  const touchUnresolved = (key: string, source: RosterSource) => {
    let e = unresolved.get(key);
    if (!e) {
      e = {
        kind: "unresolved",
        key,
        isHead: false,
        grantedAt: null,
        sources: [],
        userCcaRowCount: 0,
        reason: "NO_USER_ROW",
        candidateUserIds: [],
      };
      unresolved.set(key, e);
    }
    if (!e.sources.includes(source)) e.sources.push(source);
    return e;
  };

  // Source A FIRST, because it arrives already resolved — it CAME from the User
  // collection, so no hydration can fail for it.
  for (const d of embeddedRaw) {
    const id = oid(d._id);
    const email = str(d.email);
    if (!id || !email) continue; // BSON defence, as getMyCCAs does
    touchResolved(
      { id, email, displayName: str(d.displayName), userID: str(d.userID) },
      "embedded",
    );
  }

  /** Route a membership key to whichever bucket its resolution lands in. */
  const route = (
    key: string,
    source: RosterSource,
    rowCount: number,
    grantedAt: Date | null,
  ) => {
    const cands = claims.get(key);

    if (!cands || cands.size === 0) {
      const e = touchUnresolved(key, source);
      e.reason = "NO_USER_ROW";
      e.userCcaRowCount += rowCount;
      if (grantedAt) {
        e.isHead = true;
        e.grantedAt = grantedAt;
      }
      return;
    }

    if (cands.size > 1) {
      const e = touchUnresolved(key, source);
      e.reason = "AMBIGUOUS_KEY";
      e.candidateUserIds = [...cands.keys()];
      e.userCcaRowCount += rowCount;
      if (grantedAt) {
        e.isHead = true;
        e.grantedAt = grantedAt;
      }
      return;
    }

    const u = [...cands.values()][0]!;
    const e = touchResolved(u, source);
    if (!e.membershipKeys.includes(key)) e.membershipKeys.push(key);
    e.userCcaRowCount += rowCount;
    if (grantedAt) {
      e.isHead = true;
      e.grantedAt = grantedAt;
    }
  };

  // Source B — count duplicates PER KEY before resolution, so a duplicate is
  // reported as one person with two records rather than two people.
  const ccaKeyCounts = new Map<string, number>();
  for (const r of ccaRows) {
    ccaKeyCounts.set(r.userID, (ccaKeyCounts.get(r.userID) ?? 0) + 1);
  }
  for (const [key, n] of ccaKeyCounts) route(key, "userCCA", n, null);

  // Source C — heads. Marks isHead on whichever bucket it lands in.
  for (const h of headRows) route(h.userID, "ccaHead", 0, h.grantedAt);

  /* ---- output ---- */

  const label = (e: RosterEntry) =>
    e.kind === "resolved" ? (e.displayName ?? e.email) : e.key;

  // Sorted SERVER-side: the union's insertion order is not stable between
  // renders. Unresolved last, so the amber block reads as a footer rather than
  // interleaving with real people.
  const order = (a: RosterEntry, b: RosterEntry) => {
    if (a.kind !== b.kind) return a.kind === "resolved" ? -1 : 1;
    return label(a).localeCompare(label(b));
  };

  const all = [...resolved.values(), ...unresolved.values()];
  const heads = all.filter((e) => e.isHead).sort(order);
  const members = all.filter((e) => !e.isHead).sort(order);

  const unresolvedEntries = [...unresolved.values()];

  return {
    cca: {
      ccaID,
      ccaName: ccaRow?.ccaName ?? null,
      category: ccaRow?.category ?? null,
    },
    heads,
    members,
    counts: { heads: heads.length, members: members.length, total: all.length },
    drift: {
      unresolvedCount: unresolvedEntries.length,
      ambiguousCount: unresolvedEntries.filter(
        (e) => e.reason === "AMBIGUOUS_KEY",
      ).length,
      duplicateUserCcaRows: [...ccaKeyCounts.values()].reduce(
        (n, c) => n + Math.max(0, c - 1),
        0,
      ),
      headsUnresolved: unresolvedEntries.filter((e) => e.isHead).length,
      ccaMissing: ccaRow == null,
    },
  };
}
