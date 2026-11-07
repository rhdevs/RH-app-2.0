"use client";

import { useState } from "react";
import Link from "next/link";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { headEventHref } from "~/lib/proposals/links";
import type { ProposalDetail } from "~/server/api/services/proposals/read";
import { describeProposalError } from "../_lib/proposalForm";

type LinkProposal = Pick<
  ProposalDetail,
  | "id"
  | "status"
  | "viewer"
  | "event"
  | "eventMissing"
  | "eventBeingMade"
  | "eventsEnabled"
  | "canCreateEvent"
>;

/**
 * The proposal's Event draft: a link to it, or a note that it is gone, or the
 * Create event button. Shows nothing until the proposal is approved or has an
 * Event. Only heads get the link and the button; the server checks both again.
 * Server text is rendered as text.
 */
export default function ProposalEventLink({
  ccaID,
  proposal,
}: {
  ccaID: number;
  proposal: LinkProposal;
}) {
  const utils = api.useUtils();
  const [error, setError] = useState<string | null>(null);
  const create = api.proposal.createEvent.useMutation({
    onSuccess: async () => {
      setError(null);
      await utils.proposal.get.invalidate({ id: proposal.id });
    },
    onError: (e) => setError(describeProposalError(e.message).text),
  });

  const { event } = proposal;
  if (
    !event &&
    !proposal.eventMissing &&
    !proposal.eventBeingMade &&
    proposal.status !== "cleared" &&
    proposal.status !== "finished"
  ) {
    return null;
  }

  return (
    <section
      aria-labelledby="proposal-event-heading"
      className="space-y-2 rounded-lg border border-gray-200 bg-white p-4"
    >
      <h3
        id="proposal-event-heading"
        className="text-sm font-semibold text-gray-900"
      >
        Event
      </h3>
      {event && (
        <p className="text-sm text-gray-700">
          {proposal.viewer === "head" && proposal.eventsEnabled ? (
            <Link
              href={headEventHref(ccaID, event.eventID)}
              className="text-emerald-700 underline underline-offset-2"
            >
              {event.title ?? "Untitled event"}
            </Link>
          ) : (
            <span>{event.title ?? "Untitled event"}</span>
          )}{" "}
          <span className="text-gray-500">({event.status})</span>
        </p>
      )}
      {!event && proposal.eventMissing && (
        <p role="status" className="text-sm text-amber-800">
          The event draft is missing. It was deleted or could not be made.
        </p>
      )}
      {!event && proposal.eventBeingMade && (
        <p role="status" className="text-sm text-gray-600">
          The event draft is still being made. Check again shortly.
        </p>
      )}
      {!event && !proposal.eventMissing && !proposal.eventBeingMade && (
        <p className="text-sm text-gray-600">
          No event has been made from this proposal.
        </p>
      )}
      {proposal.canCreateEvent && (
        <Button
          type="button"
          variant="outline"
          disabled={create.isPending}
          onClick={() => create.mutate({ id: proposal.id })}
        >
          {create.isPending ? "Creating…" : "Create event"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
