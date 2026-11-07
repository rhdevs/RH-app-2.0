import { ADMIN_ROLE, HALL_OFFICE_ROLE, SCRC_ROLE } from "~/lib/roleNames";
import {
  currentDirectorIDsByCca,
  isDirectorsEnabledStrict,
} from "~/server/api/services/directorGuard";
import { PROPOSALS_FLAG_KEY } from "~/server/api/services/proposals/flag";
import { normalizeStoredRoles } from "~/server/api/services/roles";
import type { DueKind } from "./types";

const STAFF_ROLES: readonly string[] = [
  ADMIN_ROLE,
  SCRC_ROLE,
  HALL_OFFICE_ROLE,
];

/** Where staff fix it: the director positions panel on /scrc. */
export const NO_DIRECTOR_HREF = "/scrc";

/**
 * CCAs with no director who can act (4.2, A49), told to admins, RFs and Hall
 * Office as ONE notice per person per Singapore day that says how many CCAs
 * have none (no names, so sixty vacancies are one row, not sixty). Key
 * `due.cca_no_director:<Singapore day>`; the person is appended.
 *
 * Runs only while `proposals.enabled` AND `directors.enabled` are on. Both are
 * read strictly (`isProposalsEnabled` swallows a failed read, and a database
 * fault must not look like "nothing is due"), so a failed read reaches the
 * runner, which logs it and writes nothing. With directors off every CCA would
 * count as vacant, which says nothing useful; the doctor already goes red for
 * proposals on with directors off (B85).
 *
 * Staff status comes from the person's stored roles, the directors from the
 * strict guard in one batch (`currentDirectorIDsByCca`); none of these reads
 * has a catch. It does not replace the notice at submit (B21), which names a
 * specific proposal waiting now.
 *
 * Catch-up: only today's state under today's key is computed, so no missed
 * days exist to collapse. Hence "all" (there is one notice).
 */
export const ccaNoDirectorKind: DueKind = {
  name: "cca_no_director",
  noticeKind: "cca.no_director",
  catchUp: "all",
  async due({ db, userID, now, dayKey }) {
    const flag = await db.systemFlag.findUnique({
      where: { key: PROPOSALS_FLAG_KEY },
    });
    if (flag?.value !== "on") return [];
    if (!(await isDirectorsEnabledStrict(db))) return [];

    const row = await db.userRole.findUnique({
      where: { userID },
      select: { roles: true, role: true },
    });
    const stored = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];
    if (!normalizeStoredRoles(stored).some((r) => STAFF_ROLES.includes(r))) {
      return [];
    }

    const ccas = await db.cCA.findMany({ select: { ccaID: true } });
    const directors = await currentDirectorIDsByCca(
      db,
      ccas.map((c) => c.ccaID),
      now,
    );
    const vacant = [...directors.values()].filter((d) => d.length === 0).length;
    if (vacant === 0) return [];
    return [
      {
        key: `due.cca_no_director:${dayKey}`,
        title:
          vacant === 1
            ? "1 CCA has no director to review its proposals"
            : `${vacant} CCAs have no director to review their proposals`,
        body: "No one with a current JCRC role holds a director position for them, so their proposals wait in review. Set directors on the director positions panel.",
        href: NO_DIRECTOR_HREF,
      },
    ];
  },
};
