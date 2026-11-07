/**
 * Where each reader opens a proposal. A DIRECTOR's notice must point at the
 * director's route: the `/cca` layout admits CCA heads only, so a link there
 * is dead for a director who heads nothing. A head's notice points at the
 * head's own screen. Both are in-app paths (`notify` accepts nothing else).
 */

export const DIRECTOR_HOME_HREF = "/director";

export const directorProposalHref = (proposalID: string) =>
  `${DIRECTOR_HOME_HREF}/proposals/${proposalID}`;

export const headProposalHref = (ccaID: number, proposalID: string) =>
  `/cca/${ccaID}/proposals/${proposalID}`;

/** A head opens the linked Event draft on the CCA's own events screen. */
export const headEventHref = (ccaID: number, eventID: number) =>
  `/cca/${ccaID}/events/${eventID}`;
