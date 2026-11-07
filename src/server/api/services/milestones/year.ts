import type { z } from "zod";

import {
  milestoneYear,
  toEpochSec,
  type MilestoneRef,
} from "~/lib/milestones/open";
import type { milestoneYearInput } from "~/lib/schemas/milestone";
import {
  MILESTONE_SCORE_MAX,
  MILESTONE_SCORE_MIN,
} from "~/lib/schemas/milestone";
import {
  visibleParts,
  type AssessmentParts,
  type SubmissionParts,
} from "~/lib/milestones/visibility";
import {
  currentAcademicYear,
  parseAcademicYear,
} from "~/lib/transcript/academicYear";
import { assertMilestoneParty } from "./access";
import { findEndedMilestones } from "./candidates";
import { notFound } from "./errors";
import type { MilestoneDb } from "./file";
import { assertMilestonesEnabled } from "./flag";
import { assertWithinLimit } from "./limits";

/**
 * One CCA's milestones for one academic year (merge proposal 4.10): which are
 * filed, which are waiting. Readable only by a current head or director of THAT
 * CCA (strict reads in access.ts; anyone else gets one NOT_FOUND).
 *
 * No totals, no rubric, no comparison between CCAs or years: just the list.
 * The year is derived from each event's date in Singapore time (an academic
 * year, 1 August to 31 July), never stored. BOUNDED: the candidate query is
 * capped per year (`capped` says so). A stored row that fails validation is
 * counted in `skipped` and left out; one bad row never fails the list.
 * Every item is built through `visibleParts`, so the blindness rules hold here
 * too: a director sees no head score before rating, a head no director score
 * before filing.
 */

export type YearItem = {
  ref: MilestoneRef;
  title: string;
  endedAt: number;
  canceled: boolean;
  filed: boolean;
  rated: boolean;
  locked: boolean;
  photos: number;
  head?: { score: number; text: string } | null;
  assessment?: { score: number; text: string; selfRated: boolean };
};

export type YearView = {
  ccaID: number;
  year: string;
  items: YearItem[];
  skipped: number;
  capped: boolean;
  viewer: { head: boolean; director: boolean };
};

const validScore = (n: number | null): boolean =>
  n === null ||
  (Number.isInteger(n) && n >= MILESTONE_SCORE_MIN && n <= MILESTONE_SCORE_MAX);

export async function getYear(
  db: MilestoneDb,
  userID: string,
  input: z.infer<typeof milestoneYearInput>,
  now: Date = new Date(),
): Promise<YearView> {
  await assertMilestonesEnabled(db);
  const roles = await assertMilestoneParty(db, userID, input.ccaID, true);
  await assertWithinLimit("browse", userID);

  const year = input.year ?? currentAcademicYear(now);
  const ay = parseAcademicYear(year);
  if (ay === null) throw notFound();

  const list = await findEndedMilestones(
    db,
    [input.ccaID],
    { fromSec: toEpochSec(ay.start), toSec: toEpochSec(ay.endExclusive) },
    now,
    { includeCanceled: true },
  );
  const result: YearView = {
    ccaID: input.ccaID,
    year,
    items: [],
    skipped: list.skipped,
    capped: list.capped,
    viewer: roles,
  };
  if (list.items.length === 0) return result;

  const subs = await db.milestoneSubmission.findMany({
    where: { milestoneKey: { in: list.items.map((i) => i.key) } },
    select: {
      id: true,
      milestoneKey: true,
      headScore: true,
      headText: true,
      headRatedAt: true,
      frozenAt: true,
    },
  });
  const byKey = new Map(subs.map((s) => [s.milestoneKey, s]));
  const ids = subs.map((s) => s.id);
  const assessments = ids.length
    ? await db.milestoneAssessment.findMany({
        where: { submissionID: { in: ids } },
        select: {
          submissionID: true,
          score: true,
          text: true,
          selfRated: true,
          createdAt: true,
        },
      })
    : [];
  const assessBy = new Map(assessments.map((a) => [a.submissionID, a]));
  const photoRows = ids.length
    ? await db.milestoneEvidence.groupBy({
        by: ["submissionID"],
        where: { submissionID: { in: ids } },
        _count: { _all: true },
      })
    : [];
  const photos = new Map(photoRows.map((r) => [r.submissionID, r._count._all]));

  for (const c of list.items) {
    const sub = byKey.get(c.key) ?? null;
    // A canceled event with nothing filed is not shown; with a filing it is.
    if (c.state === "canceled" && sub === null) continue;
    const a = sub ? (assessBy.get(sub.id) ?? null) : null;
    if (
      sub !== null &&
      (!validScore(sub.headScore) || (a !== null && !validScore(a.score)))
    ) {
      result.skipped += 1;
      continue;
    }
    if (milestoneYear(c.endedAt) !== year) {
      result.skipped += 1;
      continue;
    }
    const parts: SubmissionParts | null = sub
      ? {
          headScore: sub.headScore ?? null,
          headText: sub.headText ?? null,
          headRatedAt: sub.headRatedAt ?? null,
          frozen: sub.frozenAt !== null && sub.frozenAt !== undefined,
        }
      : null;
    const assessment: AssessmentParts | null = a
      ? {
          score: a.score,
          text: a.text,
          selfRated: a.selfRated,
          createdAt: a.createdAt,
        }
      : null;
    const seen = visibleParts(roles, parts, assessment);
    const item: YearItem = {
      ref: c.ref,
      title: c.title,
      endedAt: c.endedAt,
      canceled: c.state === "canceled",
      filed:
        sub !== null &&
        (roles.head ? sub.headScore !== null : (photos.get(sub.id) ?? 0) > 0),
      rated: assessment !== null,
      locked: seen.locked,
      photos: sub ? (photos.get(sub.id) ?? 0) : 0,
    };
    if (seen.headVisible) {
      item.head = seen.head
        ? { score: seen.head.score, text: seen.head.text }
        : null;
    }
    if (seen.assessment) {
      item.assessment = {
        score: seen.assessment.score,
        text: seen.assessment.text,
        selfRated: seen.assessment.selfRated,
      };
    }
    result.items.push(item);
  }
  return result;
}
