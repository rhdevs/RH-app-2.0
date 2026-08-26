"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Undo2, X } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  EVENT_DECISION_REASON_MAX,
  ownerLabel,
  type EventStatus,
} from "~/lib/schemas/event";
import { formatDateRange, STATUS_META } from "~/app/events/_lib/format";

/**
 * The reviewer's view of ONE FINISHED event — what it is, when, where, who runs
 * it — and the three outcomes: approve & publish, request changes, decline.
 * There is no proposal PDF anywhere in this product any more; the submitted
 * event IS the proposal.
 *
 * `decide` is the BOUNDARY, not this file: roleManagerProcedure +
 * assertEventsEnabled, and it re-reads `reviewEvents` live (I-5) before it
 * writes. This is only the UI. A reason is REQUIRED for both non-approve
 * outcomes — it is the head's only feedback channel, because a reviewer never
 * edits someone else's event. Approving PUBLISHES in the same write; there is
 * no separate publish step to forget.
 *
 * THE WITHDRAWN BRANCH (T-10). A head may `withdraw` a submitted event — status
 * back to `draft` — while the JCRC has this page open. Three things have to be
 * right and only the first is free: the WRITE is safe (decide throws
 * NOT_UNDER_REVIEW); the READ must not present a live decision form over a
 * record that is no longer decidable; and a stale queue click must not read as
 * NO_SUCH_EVENT, which would send the reviewer hunting for an event that
 * exists. So `getForReview` is deliberately not narrowed to `submitted`, and
 * `reviewBranch` below branches on the FETCHED status — exhaustively, with no
 * `default`, so a new status is a compile error here rather than a `draft`
 * falling through to the decision buttons.
 *
 * A published event also gets `reviewerCancel` here: it pulls a live event off
 * the residents' timeline and releases its facility booking without asking the
 * owning head first, so its reason is mandatory.
 */

/* -------------------------------------------------------------------------- */
/* Status branching                                                            */
/* -------------------------------------------------------------------------- */

/** The four statuses that mean "a decision has already been recorded". */
type DecidedStatus = Exclude<EventStatus, "draft" | "submitted">;

/**
 * What this page shows, derived from the status the SERVER returned.
 *
 *   submitted -> the decision form        (the only decidable state)
 *   draft     -> the withdrawn panel      (the head pulled it back — T-10)
 *   the rest  -> the already-decided panel, carrying its narrowed status
 *
 * Exhaustive over EventStatus with NO `default`, so the mapping can be read off
 * in one glance and cannot silently acquire a member.
 */
type ReviewBranch =
  | { kind: "decide" }
  | { kind: "withdrawn" }
  | { kind: "decided"; status: DecidedStatus };

function reviewBranch(status: EventStatus): ReviewBranch {
  switch (status) {
    case "submitted":
      return { kind: "decide" };
    case "draft":
      return { kind: "withdrawn" };
    case "published":
    case "changes_requested":
    case "declined":
    case "canceled":
      return { kind: "decided", status };
  }
}

/**
 * One line per decided status. A Record over DecidedStatus, not a lookup with a
 * fallback: a missing entry is a compile error, and the old
 * "This event has been {label}." sentence could not say what a decision MEANT —
 * that published is live, that declined is final.
 *
 * PARAMETERISED ON `isHall` BECAUSE THE OWNER IS NOT ALWAYS A CCA HEAD. A
 * hall-wide event (`ccaID == null`) is owned by the JCRC itself, so a frozen
 * "The CCA head can…" sentence is simply untrue there — it names a person who
 * does not exist for that row. Same reasoning as the withdrawn panel below.
 */
function decidedLine(status: DecidedStatus, isHall: boolean): string {
  switch (status) {
    case "published":
      return "This event was approved and is live on the residents’ timeline.";
    case "changes_requested":
      return isHall
        ? "Changes were requested. The JCRC can edit and resubmit it."
        : "Changes were requested. The CCA head can edit and resubmit it.";
    case "declined":
      return "This event was declined. It cannot be resubmitted.";
    case "canceled":
      return "This event was cancelled.";
  }
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function EventReviewDetail({ eventID }: { eventID: number }) {
  const router = useRouter();
  const utils = api.useUtils();
  const query = api.event.getForReview.useQuery({ eventID }, { retry: false });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const decide = api.event.decide.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.event.getForReview.invalidate({ eventID }),
        utils.event.listForReview.invalidate(),
      ]);
      router.push("/admin/events");
    },
    onError: (e) => {
      setError(
        e.message === "NOT_UNDER_REVIEW"
          ? "This event has already been decided. Reload the page."
          : e.message.includes("reason")
            ? "A reason is required to request changes or decline."
            : "That didn’t go through. Try again.",
      );
    },
  });

  if (query.isPending) {
    return <div className="h-64 animate-pulse rounded-xl bg-gray-200" />;
  }
  if (query.error || !query.data) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-lg">
        <p className="text-sm text-gray-900">
          {query.error?.message === "NO_SUCH_EVENT"
            ? "This event no longer exists."
            : "This event couldn’t be loaded."}
        </p>
        <Link
          href="/admin/events"
          className="mt-2 inline-block text-sm text-emerald-700 hover:underline"
        >
          ← Back to the queue
        </Link>
      </div>
    );
  }

  const { event, ccaName } = query.data;
  const meta = STATUS_META[event.status];
  const branch = reviewBranch(event.status);
  // A hall-wide event has no CCA head. Copy that names one must branch on this.
  const isHall = event.ccaID == null;

  return (
    <div className="max-w-3xl space-y-5">
      <Link
        href="/admin/events"
        className="text-sm text-emerald-700 hover:underline"
      >
        ← Back to the queue
      </Link>

      <div className="rounded-xl bg-white p-6 shadow-lg">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">
            {event.title?.trim() || "Untitled event"}
          </h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
          >
            {meta.label}
          </span>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {ownerLabel(event.ccaID, ccaName)}
        </p>

        <dl className="mt-4 grid gap-3 border-t border-gray-100 pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-gray-500">When</dt>
            <dd className="text-gray-900">
              {formatDateRange(event.startTime, event.endTime)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Where</dt>
            <dd className="text-gray-900">{event.location ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Capacity</dt>
            <dd className="text-gray-900">
              {event.capacity != null ? event.capacity : "Unlimited"}
            </dd>
          </div>
        </dl>

        <div className="mt-4 border-t border-gray-100 pt-4">
          <dt className="text-sm text-gray-500">Description</dt>
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">
            {event.description ?? "—"}
          </p>
        </div>
      </div>

      {branch.kind === "decide" ? (
        /* submitted — the one decidable state */
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
          {event.facilityID != null ? (
            <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Approving publishes this event to the residents&rsquo; timeline
              straight away and books{" "}
              <span className="font-medium">
                {event.location ?? "the facility"}
              </span>{" "}
              for its times. If the room is already taken, the event still
              publishes and{" "}
              {/* A hall-wide event has no CCA head to tell — the owner is the
                  JCRC itself, quite possibly whoever is reading this. Same
                  branch, same reason, as decidedLine and the withdrawn panel. */}
              {isHall
                ? "the JCRC is told to book it manually."
                : "the CCA head is told to book it themselves."}
            </p>
          ) : (
            <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Approving publishes this event to the residents&rsquo; timeline
              straight away.
            </p>
          )}

          <label className="block text-sm font-medium text-gray-700">
            Reason{" "}
            <span className="text-gray-400">
              (required to request changes or decline)
            </span>
          </label>
          <textarea
            value={reason}
            maxLength={EVENT_DECISION_REASON_MAX}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            placeholder="What needs to change, or why this can’t go ahead…"
          />

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={decide.isPending}
              onClick={() => {
                setError(null);
                decide.mutate({
                  eventID,
                  decision: "approve",
                  reason: reason.trim() || undefined,
                });
              }}
            >
              <Check className="mr-1.5 h-4 w-4" />
              Approve &amp; publish
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={decide.isPending || !reason.trim()}
              onClick={() => {
                setError(null);
                decide.mutate({
                  eventID,
                  decision: "request_changes",
                  reason: reason.trim(),
                });
              }}
            >
              <Undo2 className="mr-1.5 h-4 w-4" />
              Request changes
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
              disabled={decide.isPending || !reason.trim()}
              onClick={() => {
                setError(null);
                decide.mutate({
                  eventID,
                  decision: "decline",
                  reason: reason.trim(),
                });
              }}
            >
              <X className="mr-1.5 h-4 w-4" />
              Decline
            </Button>
          </div>

          <p className="mt-3 text-xs text-gray-500">
            Request changes sends it back so they can edit and resubmit. Decline
            is final — the event cannot be resubmitted.
          </p>
        </div>
      ) : branch.kind === "withdrawn" ? (
        /* draft — the head pulled it back out of the queue (T-10) */
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
          <p className="text-sm font-medium text-gray-900">
            This event was withdrawn
          </p>
          {/* NOT a frozen string. §8.11 froze "The CCA head pulled it back",
              which is FALSE for a hall-wide event: nobody heads it, and the
              person who withdrew it holds manageHallEvents — very possibly the
              reviewer reading this line. A frozen string is not more
              authoritative than the truth. */}
          <p className="mt-1 text-sm text-gray-500">
            {isHall
              ? "The JCRC pulled it back to make changes. It’ll return to the queue when it’s resubmitted."
              : "The CCA head pulled it back to make changes. It’ll return to the queue when they resubmit it."}
          </p>
          <Link
            href="/admin/events"
            className="mt-2 inline-block text-sm text-emerald-700 hover:underline"
          >
            ← Back to the queue
          </Link>
        </div>
      ) : (
        /* published | changes_requested | declined | canceled */
        <>
          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <p className="text-sm text-gray-900">
              {decidedLine(branch.status, isHall)}
            </p>
            {event.decisionReason && (
              <p className="mt-1 text-sm text-gray-500">
                Reason: {event.decisionReason}
              </p>
            )}
          </div>

          {branch.status === "published" && (
            <ReviewerCancelPanel eventID={eventID} isHall={isHall} />
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Reviewer cancel                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Cancelling a PUBLISHED event over the owning head's head. Two-step, because
 * it is unilateral and irreversible, and the reason is mandatory here exactly
 * as reviewerCancelInput makes it mandatory on the server.
 *
 * "everyone who signed up loses their place" is EXACT, not loose. EventSignup
 * rows are NOT deleted: a canceled event simply drops out of listPublished and
 * listMySignups, so the signup becomes unreachable and inert. The rows stay
 * because they are the record that people signed up, and exportAttendees still
 * reads them. Do not make the copy promise deletion, and do not add a deletion
 * to match the copy.
 *
 * THE ERROR MAP IS NOT OPTIONAL. `reviewerCancel` refuses anything that is not
 * `published` with NOT_CANCELABLE, and that is a RACE THE REVIEWER LOSES
 * ROUTINELY: the owning head cancels the same event first, or a second JCRC
 * does, and this panel is still on screen because it renders off a fetched
 * status. A generic "That didn't go through. Try again." tells them to retry an
 * action that can NEVER succeed — the event is already terminal. The string must
 * name the real outcome and send them to a reload.
 */
function mapCancelError(message: string): string {
  if (message === "NOT_CANCELABLE")
    return "This event is no longer live — someone else has already cancelled it. Reload the page.";
  if (message === "NO_SUCH_EVENT") return "This event no longer exists.";
  if (message === "CAPABILITY_REQUIRED:reviewEvents")
    return "You can’t review events.";
  if (message === "EVENTS_DISABLED") return "Events aren’t switched on yet.";
  return "That didn’t go through. Try again.";
}
function ReviewerCancelPanel({
  eventID,
  isHall,
}: {
  eventID: number;
  /**
   * THE THIRD hall-unaware string in this file, and the one that survived the
   * first two being fixed. "The CCA head is not asked first" names a person who
   * does not exist for a hall-wide event (`ccaID == null`): the owner IS the
   * JCRC, so nobody is being overruled and the sentence describes a courtesy
   * that is not being withheld. decidedLine and the withdrawn panel already
   * branch on exactly this; this panel was simply never handed the flag.
   */
  isHall: boolean;
}) {
  const utils = api.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cancel = api.event.reviewerCancel.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.event.getForReview.invalidate({ eventID }),
        utils.event.listForReview.invalidate(),
      ]);
      setConfirming(false);
      setReason("");
    },
    onError: (e) => setError(mapCancelError(e.message)),
  });

  if (!confirming) {
    return (
      <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <Button
          type="button"
          variant="ghost"
          className="text-red-600 hover:bg-red-50 hover:text-red-700"
          onClick={() => setConfirming(true)}
        >
          Cancel the event
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5">
      <p className="text-sm font-medium text-red-900">
        Cancel this published event?
      </p>
      <p className="mt-1 text-sm text-red-800">
        It comes off the residents&rsquo; timeline, everyone who signed up loses
        their place, and the facility booking is released.{" "}
        {isHall ? "" : "The CCA head is not asked first. "}
        This can&rsquo;t be undone.
      </p>

      <label className="mt-3 block text-sm font-medium text-red-900">
        Reason (required)
      </label>
      <textarea
        value={reason}
        maxLength={EVENT_DECISION_REASON_MAX}
        rows={3}
        onChange={(e) => setReason(e.target.value)}
        className="mt-1 w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
      />

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => {
            setError(null);
            setConfirming(false);
          }}
        >
          Keep it live
        </Button>
        <Button
          type="button"
          className="bg-red-600 hover:bg-red-700"
          disabled={cancel.isPending || !reason.trim()}
          onClick={() => {
            setError(null);
            cancel.mutate({ eventID, reason: reason.trim() });
          }}
        >
          {cancel.isPending ? "Cancelling…" : "Cancel the event"}
        </Button>
      </div>
    </div>
  );
}
