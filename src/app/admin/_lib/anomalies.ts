import { BASELINE_ROLE } from "~/server/api/services/roles";

/**
 * The §7 `missingBaseline` predicate.
 *
 * DEVIATION FROM THE PLAN, STATED PLAINLY. 03 §7 requires `listUsers` to return
 * `missingBaseline` per row, computed server-side, and warns that "a client-side
 * eligibility guess would drift from the predicate". The shipped `listUsers`
 * (src/server/api/routers/admin.ts) does not return that field, and this task
 * may not edit server files — so it is derived here instead.
 *
 * Why that is still sound, and exactly where it is weaker:
 *
 *  - ELIGIBILITY IS NOT GUESSED. `row.eligible` arrives from the server as
 *    `canonicalUserID(u.email) !== ""`, which is exactly equivalent to
 *    `isNusStudentEmail` (00-overview.md §2.4). The shared predicate (I-12) is
 *    still the only thing deciding who is eligible, and no E-format regex is
 *    involved anywhere — L-27 stays closed, so `g.s_samuel@u.nus.edu` counts as
 *    eligible here just as it does server-side.
 *  - The remaining half is a membership test against BASELINE_ROLE, imported
 *    from the single vocabulary module rather than spelled "resident" locally.
 *    It is an anomaly detector, not an authority branch, which is why it does
 *    not violate §1.2.
 *
 *  - THE WEAKNESS: listUsers' role-FILTERED branch hardcodes `eligible: true`
 *    for every row (it pages UserRole, which has no email to canonicalise), so
 *    under an active role filter this predicate can flag a row whose account is
 *    not actually NUS-eligible. Callers pass `trustEligible: false` in that
 *    branch to suppress the marker rather than show a false anomaly.
 *  - Consequence to accept until the server returns the field: there is no
 *    `missing_resident` server-side FILTER (listUsers' `role` input is
 *    z.enum(GRANTABLE_ROLES), which cannot express `resident` at all), so this
 *    population can be spotted row-by-row on the current page but not queried.
 *    The authoritative count remains the health panel's red tile, which IS
 *    computed server-side.
 */
export function isMissingBaseline(row: {
  eligible: boolean;
  roles: string[];
}): boolean {
  return row.eligible && !row.roles.includes(BASELINE_ROLE);
}
