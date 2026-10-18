import { ADMIN_ROLE, CCA_HEAD_ROLE, JCRC_ROLE } from "~/lib/roleNames";

/**
 * TRANSCRIPT PERMISSIONS — pure functions over a roles array.
 *
 * Imports only `~/lib/roleNames`, which is pure, so this is safe in a client
 * component. Like everything in roleNames, these decide what to DRAW. The
 * server must make the real decision from LIVE roles (`getUserRoles`), and for
 * a CCA-scoped action must also confirm the caller heads THAT CCA
 * (`assertHeadsCca`) before it passes `isHeadOfThatCca` here.
 *
 * There is no "Honorary General Secretary" role in the app, so awards are
 * editable by `jcrc` or `admin`.
 */

/** May enter or edit Colours Awards. */
export function canEditAwards(roles: readonly string[]): boolean {
  return roles.includes(JCRC_ROLE) || roles.includes(ADMIN_ROLE);
}

/**
 * May set or clear a member's "Additional Contributions" text for one CCA.
 * `cca_head` alone is not enough: the caller must head that CCA.
 */
export function canManageExtraContribution(
  roles: readonly string[],
  isHeadOfThatCca: boolean,
): boolean {
  if (roles.includes(ADMIN_ROLE)) return true;
  return roles.includes(CCA_HEAD_ROLE) && isHeadOfThatCca;
}

/**
 * May set an academic year's dates and open its transcripts: `jcrc` or
 * `admin` only. Not `cca_head` (heads edit their own CCA's roster
 * while a year is collecting, they do not control the year) and not `scrc`.
 */
export function canManageTranscriptPeriods(roles: readonly string[]): boolean {
  return roles.includes(JCRC_ROLE) || roles.includes(ADMIN_ROLE);
}

/** The kinds of management access the transcript has. */
export type AccessFamily = "manager" | "cca" | "jcrcSelf";

/**
 * THE management access matrix, as one pure function.
 *
 *  - "manager"  : jcrc or admin. Awards, JCRC records for anyone, volunteering
 *                 tags, resident search.
 *  - "cca"      : a manager, OR the head of THIS CCA. `headsThisCca` must come
 *                 from a live CcaHead read (assertHeadsCca), never from the
 *                 scope-free `cca_head` role string, which only says "heads
 *                 something" and is ignored here on purpose.
 *  - "jcrcSelf" : holds the live `jcrc` role, for their OWN JCRC record. Admin
 *                 alone does not qualify: it is not a JCRC member.
 *
 * `scrc` and `resident` never grant anything.
 */
export function accessFor(
  family: AccessFamily,
  roles: readonly string[],
  headsThisCca = false,
): boolean {
  switch (family) {
    case "manager":
      return canManageTranscriptPeriods(roles);
    case "cca":
      return canManageTranscriptPeriods(roles) || headsThisCca;
    case "jcrcSelf":
      return roles.includes(JCRC_ROLE);
  }
}
