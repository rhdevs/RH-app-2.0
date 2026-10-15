import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  findUserByAnyKey,
  membershipKeysFor,
} from "~/server/api/services/ccaMembers";
import { personKey } from "./loader";

/**
 * Looking residents up for the management screens.
 *
 * NO REUSABLE HELPER EXISTED: the admin user search lives inside
 * admin.listUsers' body and returns far more than these screens may see. This is
 * a minimal one, reachable only through manager-only procedures, returning a
 * resident's key, display name and matric and nothing else (no email, no
 * roles).
 */

export const SEARCH_LIMIT = 10;

/** Prisma's Mongo `contains` compiles to $regex: escape operator input. */
export const escapeRegex = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface ResidentSummary {
  userID: string;
  displayName: string | null;
  matric: string | null;
}

type UserRow = {
  id: string;
  email: string;
  userID: string | null;
  displayName: string | null;
};

const USER_SELECT = {
  id: true,
  email: true,
  userID: true,
  displayName: true,
} as const;

/** Matrics for a set of keys (UserMatric is keyed on the canonical key). */
async function matricsFor(db: PrismaClient, keys: string[]) {
  if (keys.length === 0) return new Map<string, string>();
  const rows = await db.userMatric.findMany({
    where: { userID: { in: keys } },
    select: { userID: true, matric: true },
  });
  return new Map(rows.map((r) => [r.userID, r.matric]));
}

/** Names and matrics for resident keys, in one pass. Unknown keys are absent. */
export async function lookupResidents(
  db: PrismaClient,
  keys: readonly string[],
): Promise<Map<string, ResidentSummary>> {
  const unique = [...new Set(keys.filter((k) => k.length > 0))];
  const out = new Map<string, ResidentSummary>();
  if (unique.length === 0) return out;

  const users: UserRow[] = await db.user.findMany({
    where: {
      OR: [
        { userID: { in: unique } },
        {
          email: {
            in: unique.map((k) => `${k.toLowerCase()}@u.nus.edu`),
            mode: "insensitive",
          },
        },
      ],
    },
    select: USER_SELECT,
  });
  const matrics = await matricsFor(db, unique);

  for (const u of users) {
    const key = personKey(u, u.userID ?? "");
    const summary: ResidentSummary = {
      userID: key,
      displayName: u.displayName,
      matric: matrics.get(key) ?? null,
    };
    out.set(key, summary);
    if (u.userID) out.set(u.userID, summary);
  }
  return out;
}

/**
 * The resident a client-supplied key names, or NOT_FOUND. Returns their
 * canonical key: it is the one records are filed under.
 */
export async function requireResident(
  db: PrismaClient,
  userID: string,
): Promise<{ key: string; displayName: string | null }> {
  const user = await findUserByAnyKey(db, userID);
  if (!user) {
    throw new TRPCError({ code: "NOT_FOUND", message: "RESIDENT_NOT_FOUND" });
  }
  const profile = await db.user.findUnique({
    where: { id: user.id },
    select: { displayName: true },
  });
  return {
    key: personKey(user, userID),
    displayName: profile?.displayName ?? null,
  };
}

/** Every key that names this resident, for matching their records. */
export async function keysOf(
  db: PrismaClient,
  userID: string,
): Promise<string[]> {
  const user = await findUserByAnyKey(db, userID);
  return user
    ? [...new Set([personKey(user, userID), ...membershipKeysFor(user)])]
    : [userID];
}

/**
 * Up to 10 residents whose name, email or matric contains `query`. The caller
 * has already been checked as a manager and the query bounded to 3+ characters.
 */
export async function searchResidents(
  db: PrismaClient,
  query: string,
): Promise<ResidentSummary[]> {
  const esc = escapeRegex(query);
  const [byName, byMatric] = await Promise.all([
    db.user.findMany({
      where: {
        OR: [
          { displayName: { contains: esc, mode: "insensitive" } },
          { email: { contains: esc, mode: "insensitive" } },
        ],
      },
      select: USER_SELECT,
      orderBy: { id: "asc" },
      take: SEARCH_LIMIT,
    }),
    db.userMatric.findMany({
      where: { matric: { contains: esc, mode: "insensitive" } },
      select: { userID: true },
      orderBy: { id: "asc" },
      take: SEARCH_LIMIT,
    }),
  ]);

  const found = new Map<string, UserRow>(byName.map((u) => [u.id, u]));
  for (const m of byMatric) {
    if (found.size >= SEARCH_LIMIT) break;
    const u = await findUserByAnyKey(db, m.userID);
    if (!u || found.has(u.id)) continue;
    const full = await db.user.findUnique({
      where: { id: u.id },
      select: USER_SELECT,
    });
    if (full) found.set(full.id, full);
  }

  const users = [...found.values()].slice(0, SEARCH_LIMIT);
  const keys = users.map((u) => personKey(u, u.userID ?? ""));
  const matrics = await matricsFor(db, keys);
  return users
    .map((u, i) => ({ u, key: keys[i]! }))
    .filter(({ key }) => key.length > 0)
    .map(({ u, key }) => ({
      userID: key,
      displayName: u.displayName,
      matric: matrics.get(key) ?? null,
    }));
}
