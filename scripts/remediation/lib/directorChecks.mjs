/**
 * Pure rules for the director checks in rbac-doctor.mjs (Q23). No database and
 * no clock (every function takes `now`), so a test can import this file
 * without running the script. Nothing here writes anything.
 *
 * The rules mirror services/directorGuard.ts:
 *  - a holder row is CURRENT when it has no `endsAt` or `endsAt` is later than
 *    now;
 *  - a person holds `jcrc` NOW when the stored role is there and no JcrcTerm
 *    row has an end date at or before now;
 *  - a holder QUALIFIES when both are true;
 *  - a CCA's directors come from positions flagged `vetsProposals` that list it
 *    (a position flagged only `handlesDisposables` vets nothing);
 *  - the Social director is the holder of the ONE position flagged
 *    `handlesDisposables`; with two flagged, nobody has the power.
 *
 * Each check says whether it is wrong ALWAYS (`always: true`: a mistake in
 * what was entered) or only wrong once the switches go on (`always: false`: a
 * state that simply is not set up yet). The doctor turns the second kind RED
 * only when it is gating. Each of those names the switch it blocks
 * (`blocks`), so turning `proposals.enabled` on makes the "no director" line
 * RED without making the disposables line RED, and the other way round
 * (see `isGating`).
 */

import { sameKey } from "../create-transcript-indexes.mjs";

/** Who holds `jcrc` right now: stored on their role row and not past a step-out. */
export function liveJcrcSet(userRoles, terms, now) {
  const ended = new Set(
    terms
      .filter((t) => t.endsAt.getTime() <= now.getTime())
      .map((t) => t.userID),
  );
  const out = new Set();
  for (const r of userRoles) {
    const roles = r.roles?.length ? r.roles : r.role ? [r.role] : [];
    if (roles.includes("jcrc") && !ended.has(r.userID)) out.add(r.userID);
  }
  return out;
}

const isCurrent = (holder, now) =>
  holder.endsAt === null || holder.endsAt.getTime() > now.getTime();

/**
 * @param {{
 *   ccas: { ccaID: number, ccaName: string }[],
 *   positions: { id: string, name: string, vetsProposals: boolean, handlesDisposables: boolean }[],
 *   links: { positionID: string, ccaID: number }[],
 *   holders: { positionID: string, userID: string, endsAt: Date | null }[],
 *   userRoles: { userID: string, roles?: string[], role?: string }[],
 *   terms: { userID: string, endsAt: Date }[],
 *   now: Date,
 * }} input
 * @returns {{ flaggedPositions: number, checks: { label: string, offenders: string[], always: boolean, blocks: "proposals" | "disposables" | null, note: string }[] }}
 */
export function evaluateDirectorChecks({
  ccas,
  positions,
  links,
  holders,
  userRoles,
  terms,
  now,
}) {
  const live = liveJcrcSet(userRoles, terms, now);
  const flagged = positions.filter(
    (p) => p.vetsProposals || p.handlesDisposables,
  );
  const current = holders.filter((h) => isCurrent(h, now));
  const qualifying = (positionID) =>
    current.some((h) => h.positionID === positionID && live.has(h.userID));

  // 1. Every CCA is listed on a vetting position with a qualifying holder.
  const vetting = new Set(
    positions.filter((p) => p.vetsProposals).map((p) => p.id),
  );
  const covered = new Set(
    links
      .filter((l) => vetting.has(l.positionID) && qualifying(l.positionID))
      .map((l) => l.ccaID),
  );
  const uncovered = ccas
    .filter((c) => !covered.has(c.ccaID))
    .sort((a, b) => a.ccaID - b.ccaID)
    .map((c) => `${c.ccaID} (${c.ccaName})`);

  // 2. Exactly one position handles disposables, and it has a holder.
  const social = positions.filter((p) => p.handlesDisposables);
  const secondFlag = social.length > 1 ? social.map((p) => p.name) : [];
  let socialHolder = [];
  if (social.length === 0) socialHolder = ["no position is flagged"];
  else if (social.length === 1 && !qualifying(social[0].id)) {
    socialHolder = [social[0].name];
  }

  // 3. Holders of flagged positions who lack jcrc.
  const flaggedIDs = new Set(flagged.map((p) => p.id));
  const nameOf = new Map(positions.map((p) => [p.id, p.name]));
  const noJcrc = current
    .filter((h) => flaggedIDs.has(h.positionID) && !live.has(h.userID))
    .map((h) => `${h.userID} on ${nameOf.get(h.positionID)}`);

  return {
    flaggedPositions: flagged.length,
    checks: [
      {
        label: "CCAs with no current qualifying director",
        offenders: uncovered,
        always: false,
        blocks: "proposals",
        note: "BLOCKS proposals.enabled (every CCA needs a flagged position with a holder who has jcrc)",
      },
      {
        label: "more than one position flagged handlesDisposables",
        offenders: secondFlag,
        always: true,
        blocks: null,
        note: "WARNING: a second flag removes the power silently. Nobody can decide disposable requests until only one position is flagged",
      },
      {
        label:
          "the handlesDisposables position has a current qualifying holder",
        offenders: socialHolder,
        always: false,
        blocks: "disposables",
        note: "BLOCKS disposables.enabled (exactly one flagged position, with a holder who has jcrc)",
      },
      {
        label: "holders of flagged positions without jcrc",
        offenders: noJcrc,
        always: true,
        blocks: null,
        note: "they hold no power; remove them or restore jcrc",
      },
    ],
  };
}

/**
 * Does a "not set up yet" check turn RED on this run? A mistake in what was
 * entered (`always`) always does. Otherwise the check gates when the run was
 * given `--directors`, when `directors.enabled` is on, or when the switch
 * that THIS check blocks is on: `proposals.enabled` or `reminders.enabled`
 * for the "no director" line (a broadcast can only be sent by a director of
 * every CCA it addresses), `disposables.enabled` for the "Social director"
 * line.
 *
 * @param {{ always: boolean, blocks: "proposals" | "disposables" | null }} check
 * @param {{ flagArg: boolean, directorsOn: boolean, proposalsOn: boolean, disposablesOn?: boolean, remindersOn?: boolean }} state
 */
export function isGating(
  check,
  { flagArg, directorsOn, proposalsOn, disposablesOn, remindersOn },
) {
  if (check.always) return true;
  if (flagArg || directorsOn) return true;
  if (check.blocks === "proposals") {
    return proposalsOn === true || remindersOn === true;
  }
  return check.blocks === "disposables" && disposablesOn === true;
}

/**
 * `proposals.enabled` on with `directors.enabled` off: heads can submit, but
 * the director guard fails closed while its own switch is off, so no director
 * can ever act on what they submit and the "no director" line (which only
 * looks at positions) can still be green. Returns the one line to show RED,
 * naming the switch to turn on, or null when the pair is fine. This is about
 * the stored switches, not the run's `--directors` argument.
 *
 * @param {{ proposalsOn: boolean, directorsOn: boolean }} state
 * @returns {{ label: string, offenders: string[], note: string } | null}
 */
export function proposalsNeedDirectors({ proposalsOn, directorsOn }) {
  if (proposalsOn !== true || directorsOn === true) return null;
  return {
    label: "proposals.enabled is on but directors.enabled is off",
    offenders: ["turn on directors.enabled"],
    note: "no director can act on a submitted proposal until it is on",
  };
}

/**
 * `disposables.enabled` on with `directors.enabled` off: heads can file
 * requests, but the Social director guard fails closed while the directors
 * switch is off, so nobody can decide them. Same shape as
 * `proposalsNeedDirectors`; returns the one RED line, or null when fine.
 *
 * @param {{ disposablesOn: boolean, directorsOn: boolean }} state
 * @returns {{ label: string, offenders: string[], note: string } | null}
 */
export function disposablesNeedDirectors({ disposablesOn, directorsOn }) {
  if (disposablesOn !== true || directorsOn === true) return null;
  return {
    label: "disposables.enabled is on but directors.enabled is off",
    offenders: ["turn on directors.enabled"],
    note: "no one can decide a disposable request until it is on",
  };
}

/**
 * `reminders.enabled` on with `directors.enabled` off: heads would receive
 * broadcasts, but the director guard fails closed while its switch is off, so
 * no director can send one. Same shape as `disposablesNeedDirectors`.
 *
 * @param {{ remindersOn: boolean, directorsOn: boolean }} state
 * @returns {{ label: string, offenders: string[], note: string } | null}
 */
export function remindersNeedDirectors({ remindersOn, directorsOn }) {
  if (remindersOn !== true || directorsOn === true) return null;
  return {
    label: "reminders.enabled is on but directors.enabled is off",
    offenders: ["turn on directors.enabled"],
    note: "no director can send a broadcast until it is on",
  };
}

/** The unique (broadcast, CCA) index on ReminderTarget, as the script builds it. */
export const REMINDER_TARGET_INDEX = {
  name: "reminder_target_broadcast_cca",
  key: { broadcastID: 1, ccaID: 1 },
};

/**
 * `reminders.enabled` on while the ReminderTarget unique index is not in
 * place: "one row per CCA per broadcast" and the heads' mark-done would rest on
 * no constraint. `indexes` is the `listIndexes` answer's `firstBatch`, or null
 * when it could not be read: an unanswered question is not "present", so null
 * counts as missing. Returns the one RED line, or null when fine (or when the
 * flag is not on).
 *
 * @param {{ remindersOn: boolean, indexes: any[] | null }} state
 * @returns {{ label: string, offenders: string[], note: string } | null}
 */
export function remindersNeedIndex({ remindersOn, indexes }) {
  if (remindersOn !== true) return null;
  const want = REMINDER_TARGET_INDEX;
  const found = (indexes ?? []).find(
    (i) =>
      i?.name === want.name && i.unique === true && sameKey(i.key, want.key),
  );
  if (found) return null;
  return {
    label: "reminders.enabled is on but the ReminderTarget index is missing",
    offenders: [`ReminderTarget.${want.name}`],
    note: "run create-disposable-reminder-indexes.mjs --commit before the flag",
  };
}

/** The partial unique index on the proposal link, as the script builds it. */
export const DISPOSABLE_PROPOSAL_INDEX = {
  name: "disposable_request_proposal_unique",
  key: { proposalID: 1 },
  partialFilterExpression: { proposalID: { $gt: "" } },
};

/**
 * `disposables.enabled` on while the DisposableRequest partial unique index is
 * not in place (A3): the "one request per proposal" rule would rest on a
 * pre-check alone. `indexes` is the `listIndexes` answer's `firstBatch`, or
 * null when it could not be read: an unanswered question is not "present", so
 * null counts as missing. Returns the one RED line, or null when fine (or when
 * the flag is not on; the doctor reports nothing for an unused feature).
 *
 * @param {{ disposablesOn: boolean, indexes: any[] | null }} state
 * @returns {{ label: string, offenders: string[], note: string } | null}
 */
export function disposablesNeedIndex({ disposablesOn, indexes }) {
  if (disposablesOn !== true) return null;
  const want = DISPOSABLE_PROPOSAL_INDEX;
  const found = (indexes ?? []).find(
    (i) =>
      i?.name === want.name &&
      i.unique === true &&
      sameKey(i.key, want.key) &&
      JSON.stringify(i.partialFilterExpression) ===
        JSON.stringify(want.partialFilterExpression),
  );
  if (found) return null;
  return {
    label:
      "disposables.enabled is on but the DisposableRequest index is missing",
    offenders: [`DisposableRequest.${want.name}`],
    note: "run create-disposable-reminder-indexes.mjs --commit before the flag",
  };
}
