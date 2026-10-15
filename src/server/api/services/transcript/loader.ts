import type { PrismaClient } from "@prisma/client";
import { termAcademicYear } from "~/lib/transcript/lifecycle";
import { instantToSgDate, storedCalendarDate } from "~/lib/transcript/sgDate";
import { canonicalUserID } from "~/lib/identity";
import {
  clampRoleDuration,
  isDuration,
  resolveEntry,
  type ResolvedEntry,
} from "~/lib/transcript/duration";
import type {
  AwardInput,
  CcaMembershipInput,
  JcrcServiceInput,
  OneOffVolunteerInput,
  RegularVolunteerInput,
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
  /** Defaults to now. Decides each CCA's term year. */
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
  grantedAt: Date | null;
  decidedAt: Date | null;
}

/** Every CCA this person is in RIGHT NOW, from all three places it can live. */
async function liveMemberships(
  db: PrismaClient,
  userID: string,
  user: { id: string; email: string; userID: string | null } | null,
): Promise<LiveMembership[]> {
  const keys = [...new Set([userID, ...(user ? membershipKeysFor(user) : [])])];

  const [rows, heads, apps, embedded] = await Promise.all([
    db.userCCA.findMany({
      where: { userID: { in: keys } },
      select: { ccaID: true },
    }),
    db.ccaHead.findMany({
      where: { userID: { in: keys } },
      select: { ccaID: true, grantedAt: true },
    }),
    db.ccaApplication.findMany({
      where: { userID: { in: keys }, status: "accepted" },
      select: { ccaID: true, decidedAt: true },
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

  const headBy = new Map(heads.map((h) => [h.ccaID, h.grantedAt]));
  const decidedBy = new Map<number, Date>();
  for (const a of apps) {
    if (!a.decidedAt) continue;
    const prev = decidedBy.get(a.ccaID);
    if (!prev || a.decidedAt < prev) decidedBy.set(a.ccaID, a.decidedAt);
  }

  return [...ids].map((ccaID) => ({
    ccaID,
    isHead: headBy.has(ccaID),
    grantedAt: headBy.get(ccaID) ?? null,
    decidedAt: decidedBy.get(ccaID) ?? null,
  }));
}

/** A one-off's own date is a stored calendar date; the fallback instant is read in Singapore. */
const activityDay = (
  activityDate: Date | null | undefined,
  recordedAt: Date | null | undefined,
): string =>
  activityDate
    ? storedCalendarDate(activityDate)
    : instantToSgDate(recordedAt ?? new Date(0));

export async function loadTranscriptInput(
  db: PrismaClient,
  userID: string,
  academicYear: string,
  options: LoadOptions,
): Promise<TranscriptInput> {
  const user = await findUserByAnyKey(db, userID);
  const key = personKey(user, userID);
  // findUserByAnyKey selects only the identity columns, by design.
  const profile = user
    ? await db.user.findUnique({
        where: { id: user.id },
        select: { displayName: true, block: true },
      })
    : null;

  const [period, matric] = await Promise.all([
    db.transcriptPeriod.findUnique({ where: { academicYear } }),
    db.userMatric.findUnique({ where: { userID: key } }),
  ]);

  const memberships = await loadMemberships(
    db,
    key,
    user,
    academicYear,
    options.now ?? new Date(),
    period?.sem2Start ?? null,
  );

  const [volunteer, awards, jcrc] = await Promise.all([
    db.volunteerRecord.findMany({
      where: { academicYear, userID: key, ...NOT_VOIDED },
      orderBy: { activityDate: "asc" },
    }),
    db.award.findMany({
      where: { academicYear, userID: key, ...NOT_VOIDED },
    }),
    db.jcrcService.findUnique({
      where: { academicYear_userID: { academicYear, userID: key } },
    }),
  ]);

  const ccaIds = [
    ...new Set(
      volunteer.map((v) => v.ccaID).filter((v): v is number => v !== null),
    ),
  ];
  const volCcas = ccaIds.length
    ? await db.cCA.findMany({
        where: { ccaID: { in: ccaIds } },
        select: { ccaID: true, ccaName: true },
      })
    : [];
  const volName = new Map(volCcas.map((c) => [c.ccaID, c.ccaName]));

  const regularVolunteering: RegularVolunteerInput[] = [];
  const oneOffVolunteering: OneOffVolunteerInput[] = [];
  for (const v of volunteer) {
    if (typeof v.hours !== "number" || !(v.hours > 0)) continue;
    const organiser =
      (v.ccaID !== null ? volName.get(v.ccaID) : undefined) ?? "Raffles Hall";
    if (v.kind === "oneoff") {
      oneOffVolunteering.push({
        academicYear,
        eventName: v.activity ?? "Volunteering",
        organiser,
        date: activityDay(v.activityDate, v.recordedAt),
        hours: v.hours,
      });
    } else {
      regularVolunteering.push({
        academicYear,
        ccaName: organiser,
        activity: v.activity ?? "Volunteering",
        hours: v.hours,
      });
    }
  }

  const awardInputs: AwardInput[] = awards.map((a) => ({
    title: a.title ?? "Award",
    academicYear,
    citation: a.citation ?? null,
  }));

  const jcrcInput: JcrcServiceInput | null = jcrc
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
        testimonial: { text: jcrc.testimonial ?? "", author: "Hall Master" },
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
        block: profile?.block != null ? `Block ${profile.block}` : null,
        yearOfResidence: null, // the app keeps no residence history
      },
    ],
    memberships,
    regularVolunteering,
    oneOffVolunteering,
    awards: awardInputs,
    jcrc: jcrcInput,
  };
}

async function loadMemberships(
  db: PrismaClient,
  key: string,
  user: { id: string; email: string; userID: string | null } | null,
  academicYear: string,
  now: Date,
  sem2Start: Date | null,
): Promise<CcaMembershipInput[]> {
  const frozenRows = await db.transcriptRosterEntry.findMany({
    where: { academicYear, userID: key, frozen: true },
  });
  const frozenIDs = new Set(frozenRows.map((r) => r.ccaID));
  const entries: Array<{ ccaID: number } & ResolvedEntry> = frozenRows.map(
    (r) => {
      const duration = isDuration(r.duration) ? r.duration : "full";
      return {
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
      };
    },
  );

  // CCAs not frozen for this year: current membership, if this is the CCA's
  // term year.
  const live = (await liveMemberships(db, key, user)).filter(
    (m) => !frozenIDs.has(m.ccaID),
  );
  if (live.length > 0) {
    const [freezes, stored] = await Promise.all([
      db.ccaYearFreeze.findMany({
        where: { ccaID: { in: live.map((m) => m.ccaID) }, ...NOT_UNFROZEN },
        select: { ccaID: true, academicYear: true },
      }),
      db.transcriptRosterEntry.findMany({
        where: { academicYear, userID: key },
      }),
    ]);
    const frozenYears = new Map<number, Set<string>>();
    for (const f of freezes) {
      const set = frozenYears.get(f.ccaID) ?? new Set<string>();
      set.add(f.academicYear);
      frozenYears.set(f.ccaID, set);
    }
    const byCca = new Map(stored.map((r) => [r.ccaID, r]));
    for (const m of live) {
      const term = termAcademicYear(frozenYears.get(m.ccaID) ?? new Set(), now);
      if (term !== academicYear) continue;
      entries.push({
        ccaID: m.ccaID,
        ...resolveEntry(byCca.get(m.ccaID), m, sem2Start),
      });
    }
  }

  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.ccaID);
  const [ccas, profiles] = await Promise.all([
    db.cCA.findMany({ where: { ccaID: { in: ids } } }),
    db.ccaProfile.findMany({
      where: { ccaID: { in: ids } },
      select: { ccaID: true, description: true },
    }),
  ]);
  const ccaBy = new Map(ccas.map((c) => [c.ccaID, c]));
  const descBy = new Map(profiles.map((p) => [p.ccaID, p.description]));

  return entries.flatMap((e): CcaMembershipInput[] => {
    const cca = ccaBy.get(e.ccaID);
    if (!cca) return []; // a membership of a CCA that no longer exists
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
}

/** What a transcript shows when the resident has no matric on record. Never masked. */
export const NOT_ON_FILE = "Not on file";
