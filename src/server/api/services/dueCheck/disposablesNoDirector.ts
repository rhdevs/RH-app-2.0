import { ADMIN_ROLE, HALL_OFFICE_ROLE, SCRC_ROLE } from "~/lib/roleNames";
import { DISPOSABLES_FLAG_KEY } from "~/server/api/services/disposables/flag";
import { currentSocialDirectorIDs } from "~/server/api/services/directorGuard";
import { normalizeStoredRoles } from "~/server/api/services/roles";
import type { DueKind } from "./types";

const STAFF_ROLES: readonly string[] = [
  ADMIN_ROLE,
  SCRC_ROLE,
  HALL_OFFICE_ROLE,
];

/** Where staff fix it: the director positions panel on /scrc. */
export const NO_SOCIAL_DIRECTOR_HREF = "/scrc";

/**
 * Pending disposable requests with nobody able to decide them (4.2, 4.9),
 * told to admins, RFs and Hall Office as ONE notice per person per Singapore
 * day that says how many requests wait (no titles, no CCA names). Key
 * `due.disposables_no_director:<Singapore day>`; the person is appended.
 *
 * A TIMED notice, not one written when a request is filed: "no Social
 * director" is a state of the positions that can begin or end with no request
 * changing, and staff only need to hear of it once there is something waiting.
 * The due check is where RHApp writes such notices (4.4), and its unique key
 * keeps a day's notice to one row however many tabs fire it.
 *
 * Runs only while `disposables.enabled` is on, read strictly: `isDisposablesEnabled`
 * swallows a failed read, and a database fault must not look like "nothing is
 * due". "No Social director" is the guard's own answer (`directors.enabled` off,
 * not exactly one flagged position, or no holder with a live `jcrc`), so this
 * cannot disagree with who may actually decide. Staff status comes from the
 * person's stored roles. None of these reads has a catch: a failure reaches
 * the runner, which logs the kind and error name and writes nothing.
 *
 * Catch-up: only today's state under today's key is computed, so there are no
 * missed days to collapse. Hence "all" (there is one notice).
 */
export const disposablesNoDirectorKind: DueKind = {
  name: "disposables_no_director",
  noticeKind: "disposable.no_director",
  catchUp: "all",
  async due({ db, userID, now, dayKey }) {
    const flag = await db.systemFlag.findUnique({
      where: { key: DISPOSABLES_FLAG_KEY },
    });
    if (flag?.value !== "on") return [];

    const row = await db.userRole.findUnique({
      where: { userID },
      select: { roles: true, role: true },
    });
    const stored = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];
    if (!normalizeStoredRoles(stored).some((r) => STAFF_ROLES.includes(r))) {
      return [];
    }

    const waiting = await db.disposableRequest.count({
      where: { status: "pending" },
    });
    if (waiting === 0) return [];
    if ((await currentSocialDirectorIDs(db, now)).length > 0) return [];
    return [
      {
        key: `due.disposables_no_director:${dayKey}`,
        title:
          waiting === 1
            ? "1 disposable request is waiting and nobody can decide it"
            : `${waiting} disposable requests are waiting and nobody can decide them`,
        body: "No one can currently act as Social director, so requests cannot be decided. Check the director positions panel: exactly one position should handle disposables and be held by someone with a current JCRC role.",
        href: NO_SOCIAL_DIRECTOR_HREF,
      },
    ];
  },
};
