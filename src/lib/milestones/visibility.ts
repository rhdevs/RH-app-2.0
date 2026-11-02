/**
 * Who sees which part of a milestone (merge proposal Q15, A55). Pure, and the
 * ONLY place the blindness rule lives: the server builds its response through
 * `visibleParts`, so a hidden field is not in the response at all (the
 * browser is never trusted to hide it).
 *
 * The two ratings stay independent in both directions:
 *  - The HEAD's score, text and whether they have rated are hidden from a
 *    director until a director has submitted.
 *  - The DIRECTOR's score and text are hidden from a head until that head has
 *    rated OR the filing is frozen. A director's rating freezes the filing, and
 *    a frozen filing can no longer take a self-rating (B141), so a head who
 *    never rated would otherwise never see it (B150). Before the freeze there
 *    is no director rating to see, so the head learns nothing early.
 *  - Once both are in, both sides see both.
 *  - Evidence is visible to both before any rating: it is what is rated.
 * A person who is both a head and a director of the CCA is a head for what they
 * see (they know their own filing) and a director for what they may do.
 */

export type Viewer = { head: boolean; director: boolean };

export type SubmissionParts = {
  headScore: number | null;
  headText: string | null;
  headRatedAt: Date | null;
  frozen: boolean;
};

export type AssessmentParts = {
  score: number;
  text: string;
  selfRated: boolean;
  createdAt: Date;
};

export type VisibleParts = {
  head?: { score: number; text: string; ratedAt: Date | null } | null;
  assessment?: AssessmentParts;
  /** True when this viewer sees the head's filing section at all. */
  headVisible: boolean;
  /** The director has rated; the head's filing is locked. */
  locked: boolean;
};

export function visibleParts(
  viewer: Viewer,
  sub: SubmissionParts | null,
  assessment: AssessmentParts | null,
): VisibleParts {
  const locked = assessment !== null || sub?.frozen === true;
  const headScore = sub?.headScore ?? null;
  const headRated = headScore !== null;
  const headVisible = viewer.head || assessment !== null;
  const out: VisibleParts = { headVisible, locked };
  if (headVisible) {
    out.head = headRated
      ? {
          score: headScore,
          text: sub?.headText ?? "",
          ratedAt: sub?.headRatedAt ?? null,
        }
      : null;
  }
  if (assessment !== null && (viewer.director || headRated || locked)) {
    out.assessment = assessment;
  }
  return out;
}

/** What this viewer still has to do on a milestone, from what they may see. */
export function neededFrom(
  viewer: Viewer,
  sub: SubmissionParts | null,
  evidenceCount: number,
  assessment: AssessmentParts | null,
): Array<"file" | "rate"> {
  const needs: Array<"file" | "rate"> = [];
  const locked = assessment !== null || sub?.frozen === true;
  if (viewer.head && !locked && (sub?.headScore ?? null) === null) {
    needs.push("file");
  }
  if (viewer.director && !locked && sub !== null && evidenceCount > 0) {
    needs.push("rate");
  }
  return needs;
}
