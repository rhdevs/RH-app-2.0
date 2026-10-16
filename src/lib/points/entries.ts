import { SCORE_MAX, SCORE_MIN, type Range } from "~/lib/points/constants";
import { meanHint, sdHint } from "~/lib/points/hints";
import { checkMeanSd } from "~/lib/points/meanSd";

export type PointsRole = "none" | "head" | "vice_head";

/** One roster member as the leader sees it. Lives in the browser only. */
export type PointsEntry = {
  /** Stable key from cca.memberDirectory ("u:<id>" or "k:<key>"). */
  rowKey: string;
  matric: string | null;
  name: string | null;
  /** False for a roster record no account matches. */
  resolved: boolean;
  basePoints: number | null;
  semesterOnly: boolean;
  outgoingRole: PointsRole;
  incomingRole: PointsRole;
};

export type ExportBlockerCode =
  | "NOT_OPEN"
  | "EMPTY_ROSTER"
  | "MISSING_SCORE"
  | "BAD_SCORE"
  | "MISSING_MATRIC"
  | "BAD_MATRIC"
  | "UNRESOLVED_MEMBER"
  | "MEAN_OUT_OF_RANGE"
  | "SD_OUT_OF_RANGE";

export type ExportBlocker = {
  code: ExportBlockerCode;
  message: string;
  rowKeys?: string[];
};

/** NUS matric format, as the sandbox checks it (case-insensitive; exported upper-case). */
export const MATRIC_PATTERN = /^A\d{7}[A-Z]$/i;

export const isValidMatric = (matric: string): boolean =>
  MATRIC_PATTERN.test(matric);

export const isValidScore = (score: number): boolean =>
  Number.isInteger(score) && score >= SCORE_MIN && score <= SCORE_MAX;

const keysOf = (list: readonly PointsEntry[]): string[] =>
  list.map((e) => e.rowKey);

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function scoreBlockers(entries: readonly PointsEntry[]): ExportBlocker[] {
  const missing = entries.filter((e) => e.basePoints === null);
  const bad = entries.filter(
    (e) => e.basePoints !== null && !isValidScore(e.basePoints),
  );
  const blockers: ExportBlocker[] = [];
  if (missing.length > 0) {
    blockers.push({
      code: "MISSING_SCORE",
      message: `${missing.length} ${plural(missing.length, "member still needs", "members still need")} a score`,
      rowKeys: keysOf(missing),
    });
  }
  if (bad.length > 0) {
    blockers.push({
      code: "BAD_SCORE",
      message: `${bad.length} ${plural(bad.length, "score is not", "scores are not")} a whole number from ${SCORE_MIN} to ${SCORE_MAX}`,
      rowKeys: keysOf(bad),
    });
  }
  return blockers;
}

function identityBlockers(entries: readonly PointsEntry[]): ExportBlocker[] {
  const noMatric = entries.filter((e) => e.resolved && e.matric === null);
  const badMatric = entries.filter(
    (e) => e.resolved && e.matric !== null && !isValidMatric(e.matric),
  );
  const unresolved = entries.filter((e) => !e.resolved);
  const blockers: ExportBlocker[] = [];
  if (noMatric.length > 0) {
    const n = noMatric.length;
    blockers.push({
      code: "MISSING_MATRIC",
      message: `${n} ${plural(n, "member has", "members have")} no matric on record — ask ${plural(n, "them", "them")} to add it in their RHApp profile, or ask JCRC to fix the roster`,
      rowKeys: keysOf(noMatric),
    });
  }
  if (badMatric.length > 0) {
    const n = badMatric.length;
    blockers.push({
      code: "BAD_MATRIC",
      message: `${n} ${plural(n, "member's matric is", "members' matrics are")} not in the A1234567X format — ask JCRC to fix the roster`,
      rowKeys: keysOf(badMatric),
    });
  }
  if (unresolved.length > 0) {
    const n = unresolved.length;
    blockers.push({
      code: "UNRESOLVED_MEMBER",
      message: `${n} roster ${plural(n, "entry", "entries")} could not be matched to an account — ask JCRC to fix the roster`,
      rowKeys: keysOf(unresolved),
    });
  }
  return blockers;
}

/** Mean and SD over FULL scores. Semester-only and roles change nothing here. */
function rangeBlockers(
  entries: readonly PointsEntry[],
  range: Readonly<Range>,
): ExportBlocker[] {
  const scores = entries.map((e) => e.basePoints ?? Number.NaN);
  const check = checkMeanSd(scores, range);
  const blockers: ExportBlocker[] = [];
  const avgHint = meanHint(check.mean, range);
  const spreadHint = sdHint(check.sd, range);
  if (avgHint) blockers.push({ code: "MEAN_OUT_OF_RANGE", message: avgHint });
  if (spreadHint)
    blockers.push({ code: "SD_OUT_OF_RANGE", message: spreadHint });
  return blockers;
}

/**
 * Everything that stops the leader exporting, in the order the page lists it.
 * Empty means the export is allowed.
 *
 * Mean/SD are only judged once every member has a valid score; a half-filled
 * roster's average says nothing useful and would bury the real reason.
 */
export function exportBlockers(
  entries: readonly PointsEntry[],
  range: Readonly<Range>,
  entryOpen: boolean,
): ExportBlocker[] {
  const blockers: ExportBlocker[] = [];
  if (!entryOpen) {
    blockers.push({
      code: "NOT_OPEN",
      message:
        "Points entry is closed. JCRC will open it when the window starts.",
    });
  }
  if (entries.length === 0) {
    blockers.push({
      code: "EMPTY_ROSTER",
      message: "There are no members on the roster to score.",
    });
    return blockers;
  }
  const scoreIssues = scoreBlockers(entries);
  blockers.push(...scoreIssues, ...identityBlockers(entries));
  if (scoreIssues.length === 0) blockers.push(...rangeBlockers(entries, range));
  return blockers;
}
