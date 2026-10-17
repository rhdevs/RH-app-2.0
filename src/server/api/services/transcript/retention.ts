import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { isValidAcademicYear } from "~/lib/transcript/academicYear";

/**
 * DATA RETENTION: delete one academic year's transcript data.
 *
 * Every transcript record is keyed by `academicYear` and never refers to another
 * year's records, so a whole year can be removed without touching anything else.
 * WHETHER to delete a year is a future decision (residents keep access to past
 * published transcripts until then); this is the tested tool for it. There is
 * no script and no screen on purpose.
 *
 * The award CATALOGUE (`AwardType`) has no year, so it is deliberately NOT here
 * and a purge never touches it.
 *
 * `TRANSCRIPT_COLLECTIONS` is the ONE registry of the collections that carry an
 * `academicYear`. A test reads prisma/schema.prisma and fails if a model with an
 * \`academicYear\` field is missing here, so a collection added later cannot be
 * forgotten by the purge.
 */

export const TRANSCRIPT_COLLECTIONS = [
  "TranscriptPeriod",
  "TranscriptRosterEntry",
  "VolunteerActivity",
  "VolunteerSession",
  "VolunteerPerson",
  "VolunteerAttendance",
  "Award",
  "AwardImportBatch",
  "ResidentUnlock",
  "ResidentWithhold",
  "ManualMembership",
  "ResidentEvent",
  "JcrcService",
  "TranscriptAccess",
  "CcaYearFreeze",
  "CcaActivity",
  "CcaActivityParticipant",
] as const;

export type TranscriptCollection = (typeof TRANSCRIPT_COLLECTIONS)[number];

export type PurgeCounts = Record<TranscriptCollection, number>;

/** The Prisma delegate of each collection: just `count` and `deleteMany`. */
function delegateOf(db: PrismaClient, name: TranscriptCollection) {
  const delegates = {
    TranscriptPeriod: db.transcriptPeriod,
    TranscriptRosterEntry: db.transcriptRosterEntry,
    VolunteerActivity: db.volunteerActivity,
    VolunteerSession: db.volunteerSession,
    VolunteerPerson: db.volunteerPerson,
    VolunteerAttendance: db.volunteerAttendance,
    Award: db.award,
    AwardImportBatch: db.awardImportBatch,
    ResidentUnlock: db.residentUnlock,
    ResidentWithhold: db.residentWithhold,
    ManualMembership: db.manualMembership,
    ResidentEvent: db.residentEvent,
    JcrcService: db.jcrcService,
    TranscriptAccess: db.transcriptAccess,
    CcaYearFreeze: db.ccaYearFreeze,
    CcaActivity: db.ccaActivity,
    CcaActivityParticipant: db.ccaActivityParticipant,
  } as const;
  return delegates[name] as unknown as {
    count: (args: { where: { academicYear: string } }) => Promise<number>;
    deleteMany: (args: {
      where: { academicYear: string };
    }) => Promise<{ count: number }>;
  };
}

/**
 * Delete (or, with `dryRun`, only count) every document of `academicYear` in
 * every transcript collection. Returns the number per collection.
 *
 * Collection by collection, each `deleteMany` on its own (one transaction over
 * a real year's data would outrun the default 5 second limit). The period row
 * goes LAST, so a run that stops part way still shows the year as present, and
 * running it again finishes the job: a purge is idempotent, and a second run
 * returns zeros.
 */
export async function purgeAcademicYear(
  db: PrismaClient,
  academicYear: string,
  options: { dryRun?: boolean } = {},
): Promise<PurgeCounts> {
  if (!isValidAcademicYear(academicYear)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "INVALID_ACADEMIC_YEAR",
    });
  }
  const where = { academicYear };
  const counts = {} as PurgeCounts;

  if (options.dryRun) {
    for (const name of TRANSCRIPT_COLLECTIONS) {
      counts[name] = await delegateOf(db, name).count({ where });
    }
    return counts;
  }

  const order = [
    ...TRANSCRIPT_COLLECTIONS.filter((n) => n !== "TranscriptPeriod"),
    "TranscriptPeriod" as const,
  ];
  for (const name of order) {
    counts[name] = (await delegateOf(db, name).deleteMany({ where })).count;
  }
  return counts;
}
