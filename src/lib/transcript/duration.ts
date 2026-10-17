/**
 * How long a member was in a CCA, or held a role, within one academic year.
 *
 * "Semester 1 only" / "Semester 2 only" is a label a head (or JCRC/admin)
 * chooses to say roughly how much someone did; it is never derived from join
 * or grant dates. Every membership and role is a full year until someone sets
 * otherwise. The transcript prints a duration only when it is NOT a full year.
 * PURE.
 */

export const DURATIONS = ["full", "sem1", "sem2"] as const;
export type Duration = (typeof DURATIONS)[number];

export function isDuration(value: unknown): value is Duration {
  return (
    typeof value === "string" &&
    (DURATIONS as readonly string[]).includes(value)
  );
}

/**
 * A role must fit inside the membership: a full-year member may hold a role for
 * any period, a semester member only for that semester.
 */
export function roleFits(membership: Duration, role: Duration): boolean {
  return membership === "full" || role === membership;
}

/**
 * The role period actually in force: the wanted one (a missing one means the
 * full year), narrowed to the membership when it would stick out of it. A sem2
 * member is therefore never "Head (full year)".
 */
export function clampRoleDuration(
  membership: Duration,
  role: Duration | null | undefined,
): Duration {
  const wanted = role ?? "full";
  return roleFits(membership, wanted) ? wanted : membership;
}

/** "Semester 2" for sem2, "Semester 1" for sem1, null for a full year or unknown. */
export function durationLabel(value: string | null | undefined): string | null {
  if (value === "sem1") return "Semester 1";
  if (value === "sem2") return "Semester 2";
  return null;
}

export interface RosterAnnotation {
  duration: string | null;
  roleLabel: string | null;
  roleDuration: string | null;
  extraContribution: string | null;
}

export interface ResolvedEntry {
  duration: Duration;
  roleLabel: string | null;
  roleDuration: Duration | null;
  extraContribution: string | null;
}

/**
 * Merge a head's/admin's stored choices with the defaults (a full year; "Head"
 * for a current head). A stored choice always wins; an unrecognised stored
 * value is ignored rather than trusted. A non-head with no stored role has no
 * role and no role duration.
 */
export function resolveEntry(
  stored: Partial<RosterAnnotation> | null | undefined,
  live: { isHead: boolean },
): ResolvedEntry {
  const storedDuration = isDuration(stored?.duration) ? stored.duration : null;
  const storedRoleDuration = isDuration(stored?.roleDuration)
    ? stored.roleDuration
    : null;
  const storedLabel = stored?.roleLabel?.trim()
    ? stored.roleLabel.trim()
    : null;

  const roleLabel = storedLabel ?? (live.isHead ? "Head" : null);
  const duration = storedDuration ?? "full";
  const roleDuration = storedRoleDuration ?? (live.isHead ? "full" : null);

  return {
    duration,
    roleLabel,
    // Always inside the membership, so a stored or seeded value that sticks
    // out of it can never render.
    roleDuration: roleLabel ? clampRoleDuration(duration, roleDuration) : null,
    extraContribution: stored?.extraContribution?.trim()
      ? stored.extraContribution.trim()
      : null,
  };
}
