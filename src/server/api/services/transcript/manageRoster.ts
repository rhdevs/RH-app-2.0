import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  defaultMembershipDuration,
  defaultRoleDuration,
  isDuration,
  resolveEntry,
  type Duration,
} from "~/lib/transcript/duration";
import type { rosterUpsertInput } from "~/lib/transcript/manageInput";
import type { z } from "zod";
import {
  resolveRoster,
  type RosterResolved,
} from "~/server/api/services/ccaRoster";
import { lookupResidents } from "./residents";
import { personKey } from "./loader";
import { assertWritable } from "./manageAccess";
import { STATUS_PUBLISHED, getPeriod } from "./periods";

/**
 * A head's (or manager's) view and edits of ONE CCA's transcript annotations
 * for one academic year: how long each member was in, what role and for how
 * long, and the "Additional contribution" text.
 *
 * LIVE BEFORE PUBLISH, FROZEN AFTER. While the year is collecting the member
 * list is the live roster, read by the same resolver the publish step uses; once
 * published it is the frozen entries. Stored values are OVERRIDES; the derived
 * defaults are returned beside them so the screen can show both.
 */

export interface RosterRow {
  userID: string;
  displayName: string | null;
  matric: string | null;
  isHead: boolean;
  defaultDuration: Duration | null;
  /** The stored override, or null for "use the default". */
  duration: Duration | null;
  defaultRoleLabel: string | null;
  roleLabel: string | null;
  defaultRoleDuration: Duration | null;
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
  status: "collecting" | "published";
  sem2Start: string | null;
  /** Roster rows that could not be resolved to one person (never guessed at). */
  unresolved: number;
  rows: RosterRow[];
}

const asDuration = (v: string | null | undefined): Duration | null =>
  isDuration(v) ? v : null;

const blankToNull = (v: string | null | undefined) =>
  v && v.trim() ? v.trim() : null;

type Resolved = { entry: RosterResolved; key: string; keys: string[] };

/** Every resolved person in the CCA, with the keys that name them. */
async function liveMembers(db: PrismaClient, ccaID: number) {
  const roster = await resolveRoster(db, ccaID);
  const seen = new Map<string, Resolved>();
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

export async function rosterList(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
): Promise<RosterList> {
  const period = await getPeriod(db, academicYear);
  const published = period?.status === STATUS_PUBLISHED;
  const sem2Start = period?.sem2Start ?? null;
  const base = {
    status: published ? ("published" as const) : ("collecting" as const),
    sem2Start: sem2Start ? sem2Start.toISOString().slice(0, 10) : null,
  };

  if (published) {
    const entries = await db.transcriptRosterEntry.findMany({
      where: { academicYear, ccaID, frozen: true },
    });
    const names = await lookupResidents(
      db,
      entries.map((e) => e.userID),
    );
    const rows = entries.map((e): RosterRow => {
      const duration = asDuration(e.duration) ?? "full";
      const roleDuration = asDuration(e.roleDuration);
      return {
        userID: e.userID,
        displayName: names.get(e.userID)?.displayName ?? null,
        matric: names.get(e.userID)?.matric ?? null,
        isHead: Boolean(e.roleLabel),
        defaultDuration: null,
        duration,
        defaultRoleLabel: null,
        roleLabel: blankToNull(e.roleLabel),
        defaultRoleDuration: null,
        roleDuration,
        extraContribution: blankToNull(e.extraContribution),
        effective: {
          duration,
          roleLabel: blankToNull(e.roleLabel),
          roleDuration,
          extraContribution: blankToNull(e.extraContribution),
        },
      };
    });
    return { ...base, unresolved: 0, rows: sortRows(rows) };
  }

  const { members, unresolved } = await liveMembers(db, ccaID);
  const allKeys = [...new Set(members.flatMap((m) => m.keys))];
  const [stored, apps, names] = await Promise.all([
    db.transcriptRosterEntry.findMany({ where: { academicYear, ccaID } }),
    db.ccaApplication.findMany({
      where: { ccaID, status: "accepted", userID: { in: allKeys } },
      select: { userID: true, decidedAt: true },
    }),
    lookupResidents(db, allKeys),
  ]);
  const storedBy = new Map(stored.map((s) => [s.userID, s]));

  const rows = members.map(({ entry, key, keys }): RosterRow => {
    const own = storedBy.get(key) ?? null;
    let decidedAt: Date | null = null;
    for (const a of apps) {
      if (!keys.includes(a.userID) || !a.decidedAt) continue;
      if (!decidedAt || a.decidedAt < decidedAt) decidedAt = a.decidedAt;
    }
    const resolved = resolveEntry(
      own,
      { decidedAt, isHead: entry.isHead, grantedAt: entry.grantedAt },
      sem2Start,
    );
    return {
      userID: key,
      displayName: entry.displayName ?? names.get(key)?.displayName ?? null,
      matric: names.get(key)?.matric ?? null,
      isHead: entry.isHead,
      defaultDuration: defaultMembershipDuration(decidedAt, sem2Start),
      duration: asDuration(own?.duration),
      defaultRoleLabel: entry.isHead ? "Head" : null,
      roleLabel: blankToNull(own?.roleLabel),
      defaultRoleDuration: entry.isHead
        ? defaultRoleDuration(entry.grantedAt, sem2Start)
        : null,
      roleDuration: asDuration(own?.roleDuration),
      extraContribution: blankToNull(own?.extraContribution),
      effective: resolved,
    };
  });
  return { ...base, unresolved, rows: sortRows(rows) };
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
 * Set or clear one member's overrides. The year must be collecting and the user
 * must be a CURRENT member of THIS CCA (the same resolver publish uses). Fields
 * left out are untouched; null or blank clears one.
 */
export async function rosterUpsert(
  db: PrismaClient,
  actorUserID: string,
  input: UpsertInput,
  now: Date = new Date(),
) {
  await assertWritable(db, input.academicYear);

  const { members } = await liveMembers(db, input.ccaID);
  const target = members.find((m) => m.keys.includes(input.userID));
  if (!target) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "NOT_A_MEMBER" });
  }

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

  const row = await db.transcriptRosterEntry.upsert({
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
    update: changes,
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
