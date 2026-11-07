import { normalizeDocLink } from "~/lib/schemas/proposalFiles";
import {
  defaultWillBeEvent,
  isProposalCategory,
  missingForSubmit,
  type ProposalCategory,
  type SubmitContent,
} from "~/lib/proposals/categories";
import { epochToLocalInput, localInputToEpoch } from "~/app/events/_lib/format";

/**
 * The proposal form's state and its translation to and from what the server
 * stores. Pure and server-import-free, so a test can run it.
 *
 * Times are held as <input type="datetime-local"> strings in Singapore time,
 * the same convention as the events screens, and stored as epoch seconds.
 */

export type ProposalFormState = {
  category: ProposalCategory;
  title: string;
  description: string;
  blastMessage: string;
  startLocal: string;
  endLocal: string;
  /** Null until a poster is uploaded; it needs the saved proposal's id. */
  posterUrl: string | null;
  docLink: string;
  /** "This will be an event": make a linked Event draft on approval. */
  willBeEvent: boolean;
};

export const EMPTY_PROPOSAL_FORM: ProposalFormState = {
  category: "event",
  title: "",
  description: "",
  blastMessage: "",
  startLocal: "",
  endLocal: "",
  posterUrl: null,
  docLink: "",
  willBeEvent: defaultWillBeEvent("event"),
};

/**
 * Changing the type moves "This will be an event" to the new type's default,
 * unless the head had already set it away from the old type's default.
 */
export function withCategory(
  f: ProposalFormState,
  category: ProposalCategory,
): ProposalFormState {
  const untouched = f.willBeEvent === defaultWillBeEvent(f.category);
  return {
    ...f,
    category,
    willBeEvent: untouched ? defaultWillBeEvent(category) : f.willBeEvent,
  };
}

export function formFromProposal(p: {
  category: string;
  title: string;
  description: string;
  blastMessage: string | null;
  plannedStart: number | null;
  plannedEnd: number | null;
  posterUrl?: string | null;
  docLink?: string | null;
  /** Null or absent on a row from before the field: off. */
  willBeEvent?: boolean | null;
}): ProposalFormState {
  return {
    category: isProposalCategory(p.category) ? p.category : "event",
    title: p.title,
    description: p.description,
    blastMessage: p.blastMessage ?? "",
    startLocal: epochToLocalInput(p.plannedStart),
    endLocal: epochToLocalInput(p.plannedEnd),
    posterUrl: p.posterUrl ?? null,
    docLink: p.docLink ?? "",
    willBeEvent: p.willBeEvent === true,
  };
}

/** The fields a save sends. A blank time is null, and the server clears it. */
export function saveFieldsFromForm(f: ProposalFormState) {
  return {
    category: f.category,
    title: f.title,
    description: f.description,
    blastMessage: f.blastMessage,
    plannedStart: f.startLocal === "" ? null : localInputToEpoch(f.startLocal),
    plannedEnd: f.endLocal === "" ? null : localInputToEpoch(f.endLocal),
    docLink: f.docLink.trim() === "" ? null : f.docLink,
    willBeEvent: f.willBeEvent,
  };
}

/** A save adds the poster, which only an update can carry. */
export function updateFieldsFromForm(f: ProposalFormState) {
  return { ...saveFieldsFromForm(f), posterUrl: f.posterUrl };
}

/** True when the link box holds something the server would refuse. */
export function docLinkIsInvalid(f: ProposalFormState): boolean {
  return f.docLink.trim() !== "" && normalizeDocLink(f.docLink) === null;
}

/** What is still missing for a submit, from the one shared rule table. */
export function missingFromForm(f: ProposalFormState): string[] {
  const s = saveFieldsFromForm(f);
  const content: SubmitContent = {
    category: s.category,
    title: s.title,
    description: s.description,
    blastMessage: s.blastMessage.trim() === "" ? null : s.blastMessage,
    plannedStart: s.plannedStart,
    plannedEnd: s.plannedEnd,
    posterUrl: f.posterUrl,
    docLink: s.docLink,
  };
  return missingForSubmit(content);
}

export function sameForm(a: ProposalFormState, b: ProposalFormState): boolean {
  return (
    a.category === b.category &&
    a.title === b.title &&
    a.description === b.description &&
    a.blastMessage === b.blastMessage &&
    a.startLocal === b.startLocal &&
    a.endLocal === b.endLocal &&
    a.posterUrl === b.posterUrl &&
    a.docLink === b.docLink &&
    a.willBeEvent === b.willBeEvent
  );
}

const INCOMPLETE = "PROPOSAL_INCOMPLETE:";

/**
 * A readable message for a failed call. The server's codes are stable strings;
 * anything else (a driver message, a validation dump) is never shown.
 */
export function describeProposalError(message: string | undefined): {
  text: string;
  items: string[];
} {
  const m = message ?? "";
  if (m.startsWith(INCOMPLETE)) {
    return {
      text: "This proposal is not ready to submit. It still needs:",
      items: m
        .slice(INCOMPLETE.length)
        .split("; ")
        .filter((s) => s !== ""),
    };
  }
  if (m.startsWith("RATE_LIMITED")) {
    return {
      text: "You have made a lot of changes in the last hour. Wait a few minutes and try again.",
      items: [],
    };
  }
  const text = (() => {
    switch (m) {
      case "PROPOSALS_DISABLED":
        return "Proposals are not switched on.";
      case "NOT_CCA_HEAD":
        return "Only a head of this CCA can do that.";
      case "NOT_PROPOSAL_READER":
        return "You cannot see this CCA's proposals.";
      case "NOT_DIRECTOR":
        return "Only a director of this CCA can do that.";
      case "PROPOSAL_ACCESS_CHECK_FAILED":
        return "We could not check your access just now. Try again shortly.";
      case "PROPOSAL_CONFLICT":
        return "This proposal was changed somewhere else, or has already been submitted. Reload the page to see the latest version.";
      case "PROPOSAL_NOT_FOUND":
        return "This proposal could not be found.";
      case "PROPOSAL_NOT_EDITABLE":
        return "This proposal can no longer be edited.";
      case "COMMENTS_CLOSED":
        return "This proposal is closed, so it cannot take new comments.";
      case "PROPOSAL_NOT_IN_REVIEW":
        return "A nudge can be sent while the proposal is waiting for review.";
      case "NUDGE_TRY_AGAIN":
        return "Another change got in the way. Press the nudge again.";
      case "NOTIFICATIONS_DISABLED":
        return "Notices are not switched on, so nobody could be told.";
      case "EVENTS_DISABLED":
        return "Events are not switched on, so an event draft cannot be made.";
      case "EVENT_BEING_MADE":
        return "The event draft is still being made. Try again shortly.";
      case "PROPOSAL_NOT_APPROVED":
        return "An event draft can be made once the proposal is approved.";
      case "END_NOT_AFTER_START":
        return "The end must be after the start.";
      default:
        return "Something went wrong. Try again shortly.";
    }
  })();
  return { text, items: [] };
}
