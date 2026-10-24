import {
  clampRoleDuration,
  isDuration,
  roleFits,
  type Duration,
  type ResolvedEntry,
} from "./duration";

/**
 * MANUAL CCA ENTRIES, as pure rules. A manager adds one for a resident the
 * membership data misses. It counts as membership of that CCA for that resident
 * and year, everywhere the roster rule is used (the CCA row, which activities
 * nest under it, the notes). If a roster entry exists for the same CCA, the
 * roster entry wins and the manual one is ignored.
 */

export interface ManualMembershipRow {
  ccaID: number;
  duration: string | null;
  roleLabel: string | null;
  roleDuration: string | null;
  extraContribution: string | null;
}

const blankToNull = (v: string | null | undefined) =>
  v?.trim() ? v.trim() : null;

/** What the transcript says for a manual entry: same shape as a roster entry. */
export function resolveManual(
  row: ManualMembershipRow,
): { ccaID: number } & ResolvedEntry {
  const duration: Duration = isDuration(row.duration) ? row.duration : "full";
  const roleLabel = blankToNull(row.roleLabel);
  return {
    ccaID: row.ccaID,
    duration,
    roleLabel,
    roleDuration: roleLabel
      ? clampRoleDuration(
          duration,
          isDuration(row.roleDuration) ? row.roleDuration : null,
        )
      : null,
    extraContribution: blankToNull(row.extraContribution),
  };
}

/**
 * The roster entries plus the manual ones for CCAs the roster does not cover.
 * Order is kept: roster entries first, then manual ones as given.
 */
export function mergeManualMemberships<T extends { ccaID: number }>(
  entries: readonly T[],
  manual: readonly ManualMembershipRow[],
): Array<T | ({ ccaID: number } & ResolvedEntry)> {
  const covered = new Set(entries.map((e) => e.ccaID));
  const out: Array<T | ({ ccaID: number } & ResolvedEntry)> = [...entries];
  for (const row of manual) {
    if (covered.has(row.ccaID)) continue;
    covered.add(row.ccaID);
    out.push(resolveManual(row));
  }
  return out;
}

/** Manual entries a roster entry shadows (shown as "also in the roster" to admins). */
export function shadowedManualCcas(
  rosterCcaIDs: readonly number[],
  manual: readonly { ccaID: number }[],
): Set<number> {
  const roster = new Set(rosterCcaIDs);
  return new Set(manual.filter((m) => roster.has(m.ccaID)).map((m) => m.ccaID));
}

export type ManualProblem = "ROLE_PERIOD_OUTSIDE_MEMBERSHIP";

/**
 * A role period must fit inside the membership period (a sem 2 member can only
 * hold a sem 2 role): the same rule the roster editor applies. Without a role,
 * a role period is not stored, so it is not checked.
 */
export function manualProblem(input: {
  duration: Duration | null;
  roleLabel: string | null;
  roleDuration: Duration | null;
}): ManualProblem | null {
  const membership = input.duration ?? "full";
  if (
    input.roleLabel?.trim() &&
    input.roleDuration &&
    !roleFits(membership, input.roleDuration)
  ) {
    return "ROLE_PERIOD_OUTSIDE_MEMBERSHIP";
  }
  return null;
}
