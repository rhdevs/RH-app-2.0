/**
 * WHO MAY CALL WHAT: every procedure of the `transcript` and `transcriptManage`
 * routers with its intended access class. Shared by procedureTable.test.ts
 * (database-free: the table must match the routers exactly) and
 * authorization.int.test.ts (database: each class is checked against real
 * callers). A new procedure must be added here, with its class, or the first
 * test fails.
 *
 *  - "resident-self":   any signed-in resident, for their OWN data only.
 *  - "head-or-manager": a head of THAT CCA or a manager (checked per CCA inside).
 *  - "manager-only":    admin or jcrc, read live from the database.
 */
export type AccessClass = "resident-self" | "head-or-manager" | "manager-only";

const own = (...paths: string[]) => paths.map((p) => [p, "resident-self"]);
const head = (...paths: string[]) => paths.map((p) => [p, "head-or-manager"]);
const manager = (...paths: string[]) => paths.map((p) => [p, "manager-only"]);

export const PROCEDURE_ACCESS: Readonly<Record<string, AccessClass>> =
  Object.fromEntries([
    ...own(
      "transcript.mine.get",
      "transcript.mine.markOpened",
      "transcript.mine.readiness",
      "transcript.mine.years",
      "transcriptManage.jcrc.mine",
      "transcriptManage.jcrc.saveMine",
    ),
    ...head(
      "transcriptManage.activities.create",
      "transcriptManage.activities.list",
      "transcriptManage.activities.remove",
      "transcriptManage.activities.restore",
      "transcriptManage.activities.update",
      "transcriptManage.participants.set",
      "transcriptManage.residents.search",
      "transcriptManage.roster.list",
      "transcriptManage.roster.upsert",
      "transcriptManage.volunteer.activities.create",
      "transcriptManage.volunteer.activities.get",
      "transcriptManage.volunteer.activities.list",
      "transcriptManage.volunteer.activities.remove",
      "transcriptManage.volunteer.activities.restore",
      "transcriptManage.volunteer.activities.update",
      "transcriptManage.volunteer.attendance.save",
      "transcriptManage.volunteer.people.set",
      "transcriptManage.volunteer.sessions.add",
      "transcriptManage.volunteer.sessions.remove",
      "transcriptManage.volunteer.sessions.restore",
      "transcriptManage.volunteer.sessions.update",
    ),
    ...manager(
      "transcript.freezes.list",
      "transcript.periods.list",
      "transcript.periods.open",
      "transcript.periods.setDownloadBy",
      "transcript.preview",
      "transcriptManage.awardBatches.list",
      "transcriptManage.awardBatches.undo",
      "transcriptManage.awardImport.commit",
      "transcriptManage.awardImport.preview",
      "transcriptManage.awardTypes.archive",
      "transcriptManage.awardTypes.create",
      "transcriptManage.awardTypes.list",
      "transcriptManage.awardTypes.restore",
      "transcriptManage.awardTypes.update",
      "transcriptManage.awards.assign",
      "transcriptManage.awards.bulkRemove",
      "transcriptManage.awards.bulkRestore",
      "transcriptManage.awards.list",
      "transcriptManage.awards.remove",
      "transcriptManage.awards.restore",
      "transcriptManage.awards.update",
      "transcriptManage.ccaTags.list",
      "transcriptManage.ccaTags.setVolunteering",
      "transcriptManage.corrections.awards",
      "transcriptManage.corrections.history",
      "transcriptManage.corrections.jcrc.get",
      "transcriptManage.corrections.jcrc.remove",
      "transcriptManage.corrections.jcrc.restore",
      "transcriptManage.corrections.memberships.list",
      "transcriptManage.corrections.memberships.removeManual",
      "transcriptManage.corrections.memberships.restoreManual",
      "transcriptManage.corrections.memberships.saveManual",
      "transcriptManage.corrections.panel",
      "transcriptManage.corrections.participation.list",
      "transcriptManage.corrections.participation.options",
      "transcriptManage.corrections.participation.remove",
      "transcriptManage.corrections.participation.set",
      "transcriptManage.corrections.release",
      "transcriptManage.corrections.relock",
      "transcriptManage.corrections.unlock",
      "transcriptManage.corrections.volunteer",
      "transcriptManage.corrections.withhold",
      "transcriptManage.jcrc.saveFor",
    ),
  ]) as Record<string, AccessClass>;

export const PROCEDURE_ROUTERS = ["transcript.", "transcriptManage."] as const;

export const proceduresOf = (access: AccessClass) =>
  Object.entries(PROCEDURE_ACCESS)
    .filter(([, a]) => a === access)
    .map(([path]) => path);
