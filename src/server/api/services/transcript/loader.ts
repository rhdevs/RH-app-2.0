import type { PrismaClient } from "@prisma/client";
import { instantToSgDate, storedCalendarDate } from "~/lib/transcript/sgDate";
import { canonicalUserID } from "~/lib/identity";
import {
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
 * TWO MODES, and the difference is the whole point of publishing:
 *  - "live"   reads the CURRENT membership (UserCCA, the embedded
 *             User.userCCA array, CcaHead) and merges the stored annotations
 *             with derived defaults. Used for the admin preview before publish.
 *  - "frozen" reads ONLY TranscriptRosterEntry rows with frozen=true. It never
 *             looks at UserCCA, so a member who leaves after publish still
 *             appears, and nobody who joins after publish does.
 *
 * Writes to CCA / UserCCA / User: never. Reads of them: live mode only.
 */

export type LoadMode = "live" | "frozen";

export interface LoadOptions {
  mode: LoadMode;
  /** Printed on the document. Preview uses a visible placeholder. */
  verificationCode?: string;
  /** Defaults to today, Singapore time. */
  now?: Date;
}

export const PREVIEW_CODE = "NOT-ISSUED";

/**
 * "This nullable timestamp is not set." On MongoDB, Prisma's `field: null` does
 * NOT match a document where the field is simply ABSENT, which is how `create`
 * stores an omitted nullable field. Without the `isSet: false` branch a row that
 * was never voided or revoked would silently fall out of every "live" query.
 */
export const NOT_VOIDED = {
  OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }],
};
export const NOT_REVOKED = {
  OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
};

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** ISO date ("2027-05-10") of `date` in Singapore. */
export function isoDateSg(date: Date): string {
  return new Date(date.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

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
  const now = options.now ?? new Date();
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
    options.mode,
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
        contributions: [...jcrc.contributions],
        testimonial: { text: jcrc.testimonial ?? "", author: "Hall Master" },
        isPlaceholder: jcrc.isPlaceholder ?? true,
      }
    : null;

  const displayName = profile?.displayName?.trim();

  return {
    resident: {
      name: displayName ? displayName : "Resident",
      matric: matric?.matric ?? "Not on file",
      isSpecimen: false,
    },
    issues: [
      {
        academicYear,
        verificationCode: options.verificationCode ?? PREVIEW_CODE,
        issuedOn: isoDateSg(now),
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
  mode: LoadMode,
  sem2Start: Date | null,
): Promise<CcaMembershipInput[]> {
  let entries: Array<{ ccaID: number } & ResolvedEntry>;

  if (mode === "frozen") {
    const rows = await db.transcriptRosterEntry.findMany({
      where: { academicYear, userID: key, frozen: true },
    });
    entries = rows.map((r) => ({
      ccaID: r.ccaID,
      duration: isDuration(r.duration) ? r.duration : "full",
      roleLabel: r.roleLabel,
      roleDuration: isDuration(r.roleDuration) ? r.roleDuration : null,
      extraContribution: r.extraContribution,
    }));
  } else {
    const [live, stored] = await Promise.all([
      liveMemberships(db, key, user),
      db.transcriptRosterEntry.findMany({
        where: { academicYear, userID: key },
      }),
    ]);
    const byCca = new Map(stored.map((r) => [r.ccaID, r]));
    entries = live.map((m) => ({
      ccaID: m.ccaID,
      ...resolveEntry(byCca.get(m.ccaID), m, sem2Start),
    }));
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

/**
 * The unique key of a VALID issue: a resident has at most one per year, even
 * under concurrent first downloads. Always a real string, never null or absent:
 * MongoDB unique indexes treat a missing value as a duplicate.
 */
export const activeKeyFor = (academicYear: string, userID: string) =>
  `${academicYear}|${userID}`;

/** What the key becomes when an issue is revoked or superseded, freeing the valid one. */
export const revokedKeyFor = (
  academicYear: string,
  userID: string,
  id: string,
) => `${academicYear}|${userID}|revoked|${id}`;
