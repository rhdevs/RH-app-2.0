import { describeProposalError } from "~/app/cca/_lib/proposalForm";

/**
 * Text for a failed director screen. A refusal because the person directs no
 * CCA is not an error of the page, so it is told apart from a failed read: the
 * first says who the page is for, the second says to try again, and neither
 * ever reads as "nothing to review".
 */
export function describeReviewFailure(message: string | undefined): {
  notDirector: boolean;
  text: string;
} {
  if (message === "NOT_DIRECTOR") {
    return {
      notDirector: true,
      text: "This page is for directors of a CCA. You are not one right now.",
    };
  }
  return { notDirector: false, text: describeProposalError(message).text };
}
