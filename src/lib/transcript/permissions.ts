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
 * May set or clear a member's "Additional contributions" text for one CCA.
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
 * May set the semester-2 start date and publish or reopen an academic year:
 * `jcrc` or `admin` only. Not `cca_head` (heads edit their own CCA's roster
 * while a year is collecting, they do not control the year) and not `scrc`.
 */
export function canManageTranscriptPeriods(roles: readonly string[]): boolean {
  return roles.includes(JCRC_ROLE) || roles.includes(ADMIN_ROLE);
}
