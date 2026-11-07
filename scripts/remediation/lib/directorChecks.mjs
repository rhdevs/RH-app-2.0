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
 * only when it is gating.
 */

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
 * @returns {{ flaggedPositions: number, checks: { label: string, offenders: string[], always: boolean, note: string }[] }}
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
        note: "BLOCKS proposals.enabled (every CCA needs a flagged position with a holder who has jcrc)",
      },
      {
        label: "more than one position flagged handlesDisposables",
        offenders: secondFlag,
        always: true,
        note: "WARNING: a second flag removes the power silently. Nobody can decide disposable requests until only one position is flagged",
      },
      {
        label:
          "the handlesDisposables position has a current qualifying holder",
        offenders: socialHolder,
        always: false,
        note: "BLOCKS disposables.enabled (exactly one flagged position, with a holder who has jcrc)",
      },
      {
        label: "holders of flagged positions without jcrc",
        offenders: noJcrc,
        always: true,
        note: "they hold no power; remove them or restore jcrc",
      },
    ],
  };
}
