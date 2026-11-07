"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  isProposalCategory,
  PROPOSAL_CATEGORY_LABELS,
} from "~/lib/proposals/categories";
import {
  isProposalStatus,
  PROPOSAL_STATUS_LABELS,
  type ReviewAction,
} from "~/lib/proposals/status";
import { PROPOSAL_NOTE_MAX } from "~/lib/schemas/proposal";
import {
  isOwnProposalPosterUrl,
  normalizeDocLink,
} from "~/lib/schemas/proposalFiles";
import { formatDateTime } from "~/app/events/_lib/format";
import { describeProposalError } from "~/app/cca/_lib/proposalForm";
import { describeReviewFailure } from "../_lib/reviewText";
import { historyLine } from "~/lib/proposals/historyLine";

const FIELD =
  "w-full rounded-lg border border-gray-300 p-2.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600 disabled:bg-gray-50";

/** A plain line when the approval did not make the head's event draft. */
const draftNoteFor = (outcome: string | undefined): string | null =>
  outcome === "failed" ||
  outcome === "no_owner" ||
  outcome === "events_off" ||
  outcome === "in_progress"
    ? "The event draft was not made. The head can press Create event on the proposal."
    : null;

const toEpoch = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

const SELF_APPROVED_TEXT =
  "Self-approved: the approver is also a head of this CCA, or wrote this proposal.";

/**
 * What a director reads and does with one proposal: the poster, the document
 * link, the details and the history, with approve, return and finish. NOT a
 * guard: `proposal.get` and the three moves each check, from the stored rows,
 * that the caller directs THIS proposal's CCA now. The buttons shown are the
 * ones the server says are open to this person for the proposal's status; the
 * server checks again when one is pressed. Every server string is React text.
 */
export default function DirectorProposal({
  proposalID,
}: {
  proposalID: string;
}) {
  const utils = api.useUtils();
  const enabled = api.proposal.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const detail = api.proposal.get.useQuery(
    { id: proposalID },
    { retry: false, enabled: on },
  );
  const approve = api.proposal.approve.useMutation();
  const returnIt = api.proposal.return.useMutation();
  const finish = api.proposal.finish.useMutation();
  const busy = approve.isPending || returnIt.isPending || finish.isPending;

  const [open, setOpen] = useState<ReviewAction | null>(null);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  if (enabled.isLoading || (on && detail.isLoading)) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (enabled.isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not check whether proposals are switched on. Try again shortly.
      </p>
    );
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Proposals are not switched on yet.
      </p>
    );
  }
  const loaded = detail.data;
  if (!loaded) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {describeReviewFailure(detail.error?.message).text}
      </p>
    );
  }

  const actions = loaded.reviewActions;
  const shownLink = normalizeDocLink(loaded.docLink ?? "");
  const shownPoster =
    loaded.posterUrl && isOwnProposalPosterUrl(loaded.posterUrl, loaded.id)
      ? loaded.posterUrl
      : null;
  const approval = [...loaded.history]
    .reverse()
    .find((h) => h.toStatus === "cleared");

  const close = () => {
    setOpen(null);
    setText("");
  };
  const refresh = async () => {
    await Promise.all([
      utils.proposal.get.invalidate({ id: loaded.id }),
      utils.proposal.directorHome.invalidate(),
      utils.proposal.directorQueue.invalidate(),
    ]);
  };
  const run = async (action: ReviewAction) => {
    setFailure(null);
    setDraftNote(null);
    const base = { id: loaded.id, version: loaded.version };
    try {
      if (action === "approve") {
        const done = await approve.mutateAsync({
          ...base,
          note: text.trim() || null,
        });
        setDraftNote(draftNoteFor(done.eventDraft));
      } else if (action === "return") {
        await returnIt.mutateAsync({ ...base, reason: text });
      } else {
        await finish.mutateAsync(base);
      }
      close();
    } catch (e) {
      setFailure(
        describeProposalError((e as { message?: string }).message).text,
      );
    }
    await refresh();
  };

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/director"
          className="text-sm text-emerald-700 underline underline-offset-2"
        >
          Director&apos;s home
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">
          {loaded.title}
        </h1>
        <p className="text-sm text-gray-500">
          {loaded.ccaName ?? "A CCA you direct"}
          {" · "}
          {isProposalCategory(loaded.category)
            ? PROPOSAL_CATEGORY_LABELS[loaded.category]
            : "Proposal"}
          {" · "}
          {isProposalStatus(loaded.status)
            ? PROPOSAL_STATUS_LABELS[loaded.status]
            : "Unknown status"}
          {loaded.submittedAt
            ? `, submitted ${formatDateTime(toEpoch(loaded.submittedAt))}`
            : ""}
        </p>
        {(loaded.status === "cleared" || loaded.status === "finished") &&
          approval?.selfApproved && (
            <p
              role="note"
              className="mt-2 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900"
            >
              {SELF_APPROVED_TEXT}
              {approval.approverName
                ? ` Approved by ${approval.approverName}.`
                : ""}
            </p>
          )}
      </div>

      <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <p className="whitespace-pre-wrap text-sm text-gray-800">
          {loaded.description || "No description."}
        </p>
        {loaded.blastMessage && (
          <div>
            <p className="text-xs font-medium text-gray-500">Blast message</p>
            <p className="whitespace-pre-wrap text-sm text-gray-800">
              {loaded.blastMessage}
            </p>
          </div>
        )}
        {loaded.plannedStart !== null && (
          <p className="text-sm text-gray-700">
            <span className="font-medium">Planned: </span>
            {formatDateTime(loaded.plannedStart)}
            {loaded.plannedEnd !== null
              ? ` to ${formatDateTime(loaded.plannedEnd)}`
              : ""}
          </p>
        )}
        {shownPoster && (
          <div>
            <p className="mb-1 text-sm font-medium text-gray-700">Poster</p>
            <div className="relative h-64 w-full max-w-md overflow-hidden rounded-md border border-gray-200 bg-gray-50">
              <Image
                src={shownPoster}
                alt="Poster"
                fill
                className="object-contain"
                sizes="448px"
                unoptimized
              />
            </div>
          </div>
        )}
        {shownLink && (
          <p className="text-sm">
            <span className="font-medium text-gray-700">Document link: </span>
            <a
              href={shownLink}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-emerald-700 underline underline-offset-2"
            >
              {shownLink}
            </a>
          </p>
        )}
      </section>

      {actions.length > 0 && (
        <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Your decision</h2>
          <div className="flex flex-wrap gap-3">
            {actions.includes("approve") && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFailure(null);
                  setOpen("approve");
                }}
              >
                Approve
              </Button>
            )}
            {actions.includes("return") && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setFailure(null);
                  setOpen("return");
                }}
              >
                Return to the head
              </Button>
            )}
            {actions.includes("finish") && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFailure(null);
                  setOpen("finish");
                }}
              >
                Mark finished
              </Button>
            )}
          </div>

          {open !== null && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(open);
              }}
            >
              {open === "approve" && (
                <p className="text-sm text-gray-600">
                  Approving means you have approved it. RHApp does not send the
                  RF email or record it.
                </p>
              )}
              {open === "finish" && (
                <p className="text-sm text-gray-600">
                  Mark this approved proposal as finished. This cannot be
                  undone.
                </p>
              )}
              {open !== "finish" && (
                <div>
                  <label
                    htmlFor="review-text"
                    className="mb-1 block text-sm font-medium text-gray-700"
                  >
                    {open === "return"
                      ? "Reason (the head will see it)"
                      : "Note (optional)"}
                  </label>
                  <textarea
                    id="review-text"
                    rows={3}
                    value={text}
                    maxLength={PROPOSAL_NOTE_MAX}
                    disabled={busy}
                    onChange={(e) => setText(e.target.value)}
                    className={FIELD}
                  />
                </div>
              )}
              <div className="flex gap-3">
                <Button
                  type="submit"
                  disabled={busy || (open === "return" && text.trim() === "")}
                >
                  {busy ? "Saving…" : "Confirm"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={close}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {failure && (
            <p role="alert" className="text-sm text-red-600">
              {failure}
            </p>
          )}
        </section>
      )}

      {(loaded.event || loaded.eventMissing || loaded.eventBeingMade) && (
        <p className="text-sm text-gray-700">
          <span className="font-medium">Event: </span>
          {loaded.event
            ? `${loaded.event.title ?? "Untitled event"} (${loaded.event.status})`
            : loaded.eventBeingMade
              ? "the event draft is still being made"
              : "the event draft is missing. It was deleted or could not be made."}
        </p>
      )}
      {draftNote && (
        <p role="status" className="text-sm text-amber-800">
          {draftNote}
        </p>
      )}

      {loaded.history.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-900">History</h2>
          <ul className="space-y-1 text-sm text-gray-600">
            {loaded.history.map((h) => (
              <li key={h.id}>
                {historyLine(h, (at) => formatDateTime(toEpoch(at)))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
