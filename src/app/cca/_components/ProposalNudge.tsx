"use client";

import { useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { describeProposalError } from "../_lib/proposalForm";

/** What a nudge answer says, in words. Pure, so it is tested without React. */
export function nudgeMessage(
  result: RouterOutputs["proposal"]["nudge"],
): string {
  switch (result.status) {
    case "sent":
      return result.alreadySent > 0
        ? `Nudged ${result.sent} more director(s). The others were already nudged today.`
        : `Nudged ${result.sent} director(s).`;
    case "already_sent":
      return "You already nudged the directors about this today.";
    case "no_director":
      return "This CCA has no director to nudge right now. Nothing was sent.";
  }
}

/**
 * A head's nudge to the CCA's directors, shown while the proposal waits for
 * review. NOT a guard: the server checks that the caller heads the proposal's
 * CCA and that it is in review. The answer is shown as plain text.
 */
export default function ProposalNudge({ proposalID }: { proposalID: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const nudge = api.proposal.nudge.useMutation({
    onSuccess: (result) => {
      setFailed(false);
      setMessage(nudgeMessage(result));
    },
    onError: (e) => {
      setFailed(true);
      setMessage(describeProposalError(e.message).text);
    },
  });

  return (
    <section className="space-y-2 rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">
        Nudge the director
      </h3>
      <p className="text-sm text-gray-600">
        Sends the CCA&apos;s directors a notice to look at this proposal. Once a
        day per director.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={nudge.isPending}
        onClick={() => nudge.mutate({ id: proposalID })}
      >
        {nudge.isPending ? "Sending…" : "Nudge the directors"}
      </Button>
      {message && (
        <p
          role={failed ? "alert" : "status"}
          className={failed ? "text-sm text-red-600" : "text-sm text-gray-700"}
        >
          {message}
        </p>
      )}
    </section>
  );
}
