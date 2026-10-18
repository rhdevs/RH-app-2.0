import type { PrismaClient } from "@prisma/client";
import { instantToSgDate } from "~/lib/transcript/sgDate";
import { canonicalUserID } from "~/lib/identity";
import {
  clampRoleDuration,
  hasSavedRoleOrPeriod,
  isDuration,
  resolveEntry,
  savedChoices,
  type ResolvedEntry,
} from "~/lib/transcript/duration";
import { readPeriod } from "~/lib/transcript/activities";
import { mergeManualMemberships } from "~/lib/transcript/manualMembership";
import { personTotals, readKind } from "~/lib/transcript/volunteer";
import type {
  ActivityInput,
  AwardInput,
  CcaMembershipInput,
  JcrcServiceInput,
  VolunteerActivityInput,
  TranscriptInput,
} from "~/lib/transcript/types";
import {
  findUserByAnyKey,
  membershipKeysFor,
} from "~/server/api/services/ccaMembers";

/**
 * THE ONE PLACE A TRANSCRIPT'S INPUT IS LOADED. Takes the Prisma client as a
 * parameter so it can be exercised against any database, and returns the
 * existing pure input type, so assembleTranscript and the pages are unchanged.
 *
 * WHICH MEMBERSHIPS COUNT, per CCA, for the year asked for:
 *  - a CCA with an ACTIVE FREEZE for that year contributes its FROZEN entries
 *    (TranscriptRosterEntry rows with frozen=true), whoever is in the CCA now:
 *    a member who left after the freeze still appears, and nobody who joined
 *    after it does;
 *  - a CCA with no active freeze contributes the resident's CURRENT membership
 *    (UserCCA, the embedded User.userCCA array, CcaHead) merged with the stored
 *    annotations and derived defaults, but ONLY if the year asked for is that
 *    CCA's term year (its oldest unfrozen year). Otherwise it contributes
 *    nothing: after a handover the CCA's new members belong to the next year.
 *
 * Writes to CCA / UserCCA / User: never. Reads of them: for CCAs not frozen yet.
 */

export interface LoadOptions {
  /** No longer used: an open year reads locked lists, otherwise live ones. */
  now?: Date;
}

/**
 * "This nullable timestamp is not set." On MongoDB, Prisma's `field: null` does
 * NOT match a document where the field is simply ABSENT, which is how `create`
 * stores an omitted nullable field. Without the `isSet: false` branch a row that
 * was never voided or revoked would silently fall out of every "live" query.
 */
export const NOT_VOIDED = {
  OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }],
};
/** An activity or participant that has not been removed (the same rule). */
export const NOT_REMOVED = {
  OR: [{ removedAt: null }, { removedAt: { isSet: false } }],
};
/** A freeze that has not been undone (the same null-or-absent rule). */
export const NOT_UNFROZEN = {
  OR: [{ unfrozenAt: null }, { unfrozenAt: { isSet: false } }],
};
/**
 * The key a person's transcript data is filed under: their canonical NUSNET id
 * where their email gives one, else the id stored on their User row, else the
 * key we were given. Same key UserRole / UserMatric / CcaHead use (I-1).
 */
export function personKey(
  user: { email: string; userID: string | null } | null,
  fallback: string,
): string {
  if (!user) return fallback;
  return canonicalUserID(user.email) ?? user.userID ?? fallback;
}

interface LiveMembership {
  ccaID: number;
  isHead: boolean;
}

/** Every CCA this person is in RIGHT NOW, from all three places it can live. */
async function liveMemberships(
  db: PrismaClient,
  userID: string,
  user: { id: string; email: string; userID: string | null } | null,
): Promise<LiveMembership[]> {
  const keys = [...new Set([userID, ...(user ? membershipKeysFor(user) : [])])];

  const [rows, heads, embedded] = await Promise.all([
    db.userCCA.findMany({
      where: { userID: { in: keys } },
      select: { ccaID: true },
    }),
    db.ccaHead.findMany({
      where: { userID: { in: keys } },
      select: { ccaID: true },
    }),
    user
      ? (db.user.findRaw({
          filter: { _id: { $oid: user.id } },
          options: { projection: { userCCA: 1 } },
        }) as unknown as Promise<Array<{ userCCA?: unknown }>>)
      : Promise.resolve([]),
  ]);

  const ids = new Set<number>(rows.map((r) => r.ccaID));
  for (const h of heads) ids.add(h.ccaID);
  for (const d of embedded) {
    if (Array.isArray(d.userCCA)) {
      for (const v of d.userCCA) if (typeof v === "number") ids.add(v);
    }
  }

  const headIDs = new Set(heads.map((h) => h.ccaID));
  return [...ids].map((ccaID) => ({ ccaID, isHead: headIDs.has(ccaID) }));
}

export async function loadTranscriptInput(
  db: PrismaClient,
  userID: string,
  academicYear: string,
  // Kept for callers; which list is read depends only on the year's status.
  _options: LoadOptions,
): Promise<TranscriptInput> {
  const user = await findUserByAnyKey(db, userID);
  const key = personKey(user, userID);
  // findUserByAnyKey selects only the identity columns, by design.
  const profile = user
    ? await db.user.findUnique({
        where: { id: user.id },
        select: { displayName: true },
      })
    : null;

  const [period, matric] = await Promise.all([
    db.transcriptPeriod.findUnique({ where: { academicYear } }),
    db.userMatric.findUnique({ where: { userID: key } }),
  ]);

  const { memberships, memberCcaIDs } = await loadMemberships(
    db,
    key,
    user,
    academicYear,
    period?.status === "published",
  );
  const activities = await loadActivities(db, key, academicYear, memberCcaIDs);

  const [volunteering, awards, jcrc] = await Promise.all([
    loadVolunteering(db, key, academicYear),
    db.award.findMany({
      where: { academicYear, userID: key, ...NOT_VOIDED },
    }),
    db.jcrcService.findUnique({
      where: { academicYear_userID: { academicYear, userID: key } },
    }),
  ]);

  const awardInputs: AwardInput[] = awards.map((a) => ({
    title: a.title ?? "Award",
    academicYear,
    citation: a.citation ?? null,
  }));

  const jcrcInput: JcrcServiceInput | null =
    jcrc && !jcrc.removedAt
      ? {
          portfolio: jcrc.portfolio ?? "",
          position: jcrc.position ?? "",
          term: academicYear,
          description: jcrc.description ?? "",
          contributions: jcrc.contributions.map((c) => ({
            activity: c.activity,
            role: c.role ?? "",
            description: c.description ?? "",
          })),
          testimonial: { text: jcrc.testimonial ?? "" },
          isPlaceholder: jcrc.isPlaceholder ?? true,
        }
      : null;

  const displayName = profile?.displayName?.trim();

  return {
    resident: {
      name: displayName ? displayName : "Resident",
      matric: matric?.matric ?? NOT_ON_FILE,
      isSpecimen: false,
    },
    issues: [
      {
        academicYear,
        // The day the year was published, Singapore time; stable across views.
        issuedOn:
          period?.status === "published" && period.publishedAt
            ? instantToSgDate(period.publishedAt)
            : null,
      },
    ],
    memberships,
    volunteering,
    awards: awardInputs,
    jcrc: jcrcInput,
    activities,
  };
}

/**
 * The volunteer activities this person is credited with, and their hours in each:
 * the sum, over the activity's active sessions they are ticked in, of the cell's
 * override or the session's hours. Removed activities, sessions and people never
 * count. Nothing here checks that the CCA is still tagged as volunteering, so
 * an untagged CCA's activities keep rendering.
 */
export async function loadVolunteering(
  db: PrismaClient,
  key: string,
  academicYear: string,
): Promise<VolunteerActivityInput[]> {
  const mine = await db.volunteerPerson.findMany({
    where: { academicYear, userID: key, ...NOT_REMOVED },
    select: { activityID: true },
  });
  if (mine.length === 0) return [];
  const ids = mine.map((p) => p.activityID);

  const [activities, sessions, ticks] = await Promise.all([
    db.volunteerActivity.findMany({
      where: { id: { in: ids }, ...NOT_REMOVED },
    }),
    db.volunteerSession.findMany({
      where: { activityID: { in: ids }, ...NOT_REMOVED },
      select: { id: true, activityID: true, hours: true },
    }),
    db.volunteerAttendance.findMany({
      where: { academicYear, userID: key, activityID: { in: ids } },
      select: { sessionID: true, activityID: true, hoursOverride: true },
    }),
  ]);
  const ccas = await db.cCA.findMany({
    where: { ccaID: { in: [...new Set(activities.map((a) => a.ccaID))] } },
    select: { ccaID: true, ccaName: true },
  });
  const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));

  return activities.flatMap((a): VolunteerActivityInput[] => {
    const name = ccaName.get(a.ccaID);
    if (!name) return []; // the CCA no longer exists
    const totals = personTotals({
      sessions: sessions.filter((s) => s.activityID === a.id),
      people: [key],
      attendance: ticks
        .filter((t) => t.activityID === a.id)
        .map((t) => ({
          sessionID: t.sessionID,
          userID: key,
          hoursOverride: t.hoursOverride,
        })),
    });
    const hours = totals.get(key) ?? 0;
    if (!(hours > 0)) return [];
    return [
      {
        academicYear,
        title: a.title,
        kind: readKind(a.kind),
        ccaName: name,
        hours,
      },
    ];
  });
}

/**
 * The CCA activities this person took part in for the year. Removed activities
 * and removed participants never load. `isMember` uses the same rule as the CCA
 * rows (it comes from the memberships just loaded), so a member's activities
 * nest under the CCA and everyone else's become "Other involvement".
 */
async function loadActivities(
  db: PrismaClient,
  key: string,
  academicYear: string,
  memberCcaIDs: ReadonlySet<number>,
): Promise<ActivityInput[]> {
  const mine = await db.ccaActivityParticipant.findMany({
    where: { academicYear, userID: key, ...NOT_REMOVED },
  });
  if (mine.length === 0) return [];

  const activities = await db.ccaActivity.findMany({
    where: { id: { in: mine.map((p) => p.activityID) }, ...NOT_REMOVED },
  });
  const ccas = await db.cCA.findMany({
    where: { ccaID: { in: [...new Set(activities.map((a) => a.ccaID))] } },
    select: { ccaID: true, ccaName: true },
  });
  const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  const person = new Map(mine.map((p) => [p.activityID, p]));

  return activities.flatMap((a): ActivityInput[] => {
    const name = ccaName.get(a.ccaID);
    const p = person.get(a.id);
    if (!name || !p) return []; // the CCA no longer exists
    return [
      {
        academicYear,
        ccaName: name,
        title: a.title,
        description: a.description ?? null,
        period: readPeriod(a.period),
        role: p.role ?? null,
        personDescription: p.description ?? null,
        isMember: memberCcaIDs.has(a.ccaID),
      },
    ];
  });
}

async function loadMemberships(
  db: PrismaClient,
  key: string,
  user: { id: string; email: string; userID: string | null } | null,
  academicYear: string,
  /** An open (published) year reads the locked lists; otherwise the live ones. */
  published: boolean,
): Promise<{
  memberships: CcaMembershipInput[];
  /** The CCAs the person counts as a member of for this year. */
  memberCcaIDs: Set<number>;
  /** The ones that come from the roster (frozen or live), not from a manual entry. */
  rosterCcaIDs: number[];
}> {
  const entries: Array<{ ccaID: number } & ResolvedEntry> = [];
  if (published) {
    // Transcripts are open: each CCA's member list as it was locked.
    const frozenRows = await db.transcriptRosterEntry.findMany({
      where: { academicYear, userID: key, frozen: true },
    });
    for (const r of frozenRows) {
      const duration = isDuration(r.duration) ? r.duration : "full";
      entries.push({
        ccaID: r.ccaID,
        duration,
        roleLabel: r.roleLabel,
        roleDuration: r.roleLabel?.trim()
          ? clampRoleDuration(
              duration,
              isDuration(r.roleDuration) ? r.roleDuration : null,
            )
          : null,
        extraContribution: r.extraContribution,
      });
    }
  } else {
    // Still collecting: each CCA's current (live) membership, plus every CCA
    // where a saved role or period keeps the person on this year's list.
    const [live, stored] = await Promise.all([
      liveMemberships(db, key, user),
      db.transcriptRosterEntry.findMany({
        where: { academicYear, userID: key },
      }),
    ]);
    const byCca = new Map(stored.map((r) => [r.ccaID, r]));
    const liveIDs = new Set(live.map((m) => m.ccaID));
    const kept = stored
      .filter(
        (r) => !liveIDs.has(r.ccaID) && hasSavedRoleOrPeriod(savedChoices(r)),
      )
      .map((r) => ({ ccaID: r.ccaID, isHead: false }));
    for (const m of [...live, ...kept]) {
      // The saved choices, never values a part-way Open wrote in.
      entries.push({
        ccaID: m.ccaID,
        ...resolveEntry(savedChoices(byCca.get(m.ccaID)), m),
      });
    }
  }

  // A manager's manual entries count as membership too; a roster entry for the
  // same CCA wins, so a manual one never doubles it.
  const manual = await db.manualMembership.findMany({
    where: { academicYear, userID: key, ...NOT_REMOVED },
  });
  const all = mergeManualMemberships(entries, manual);

  const rosterCcaIDs = entries.map((e) => e.ccaID);
  if (all.length === 0) {
    return { memberships: [], memberCcaIDs: new Set(), rosterCcaIDs };
  }
  const ids = all.map((e) => e.ccaID);
  const [ccas, profiles] = await Promise.all([
    db.cCA.findMany({ where: { ccaID: { in: ids } } }),
    db.ccaProfile.findMany({
      where: { ccaID: { in: ids } },
      select: { ccaID: true, description: true },
    }),
  ]);
  const ccaBy = new Map(ccas.map((c) => [c.ccaID, c]));
  const descBy = new Map(profiles.map((p) => [p.ccaID, p.description]));

  const memberCcaIDs = new Set<number>();
  const memberships = all.flatMap((e): CcaMembershipInput[] => {
    const cca = ccaBy.get(e.ccaID);
    if (!cca) return []; // a membership of a CCA that no longer exists
    memberCcaIDs.add(e.ccaID);
    return [
      {
        ccaName: cca.ccaName,
        category: cca.category,
        academicYear,
        leadershipRole: e.roleLabel,
        description: descBy.get(e.ccaID) ?? null,
        extraContribution: e.extraContribution,
        duration: e.duration,
        roleDuration: e.roleDuration,
      },
    ];
  });
  return { memberships, memberCcaIDs, rosterCcaIDs };
}

/**
 * Which CCAs count as this resident's for the year and where each comes from
 * (the roster, or a manual entry): what the resident panel needs to show.
 */
export async function loadResidentCcaIDs(
  db: PrismaClient,
  userID: string,
  academicYear: string,
  _options: LoadOptions = {},
): Promise<{ key: string; rosterCcaIDs: number[]; memberCcaIDs: Set<number> }> {
  const user = await findUserByAnyKey(db, userID);
  const key = personKey(user, userID);
  const period = await db.transcriptPeriod.findUnique({
    where: { academicYear },
  });
  const { memberCcaIDs, rosterCcaIDs } = await loadMemberships(
    db,
    key,
    user,
    academicYear,
    period?.status === "published",
  );
  return { key, rosterCcaIDs, memberCcaIDs };
}

/** What a transcript shows when the resident has no matric on record. Never masked. */
export const NOT_ON_FILE = "Not on file";
