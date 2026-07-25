"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Check, X } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { EVENT_DECISION_REASON_MAX } from "~/lib/schemas/event";
import { formatDateRange, STATUS_META } from "~/app/events/_lib/format";

/**
 * The reviewer's view of one submitted event: its proposal text, the proposal
 * PDF, and Approve / Reject controls. decide() is the boundary (re-reads
 * reviewEvents live); this is the UI. A rejection requires a reason.
 */
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
            ? "A reason is required to reject."
            : "That didn't go through. Try again.",
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
  const decided = event.status !== "submitted";

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
          {ccaName ?? `CCA #${event.ccaID}`}
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

        {event.proposalUrl && (
          <a
            href={event.proposalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
          >
            <FileText className="h-4 w-4" />
            View proposal PDF
          </a>
        )}
      </div>

      {decided ? (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
          <p className="text-sm text-gray-900">
            This event has been {meta.label.toLowerCase()}.
          </p>
          {event.decisionReason && (
            <p className="mt-1 text-sm text-gray-500">
              Reason: {event.decisionReason}
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
          <label className="block text-sm font-medium text-gray-700">
            Reason{" "}
            <span className="text-gray-400">(required to reject)</span>
          </label>
          <textarea
            value={reason}
            maxLength={EVENT_DECISION_REASON_MAX}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            placeholder="Feedback for the CCA head…"
          />

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-4 flex items-center gap-3">
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
              Approve
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
                  decision: "reject",
                  reason: reason.trim(),
                });
              }}
            >
              <X className="mr-1.5 h-4 w-4" />
              Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
