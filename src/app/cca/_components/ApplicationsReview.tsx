"use client";

import { useState } from "react";
import { CalendarClock, Check, ChevronDown, MapPin, X } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  APPLICATION_STATUSES,
  DECISION_REASON_MAX,
  isTerminalStatus,
  type ApplicationStatus,
} from "~/lib/schemas/ccaApplication";
import { formatSlot, statusBadgeClass, statusLabel } from "~/app/ccas/_lib/status";
import ApplicantDetails from "./ApplicantDetails";

type AppRow =
  RouterOutputs["ccaApplicationsHead"]["listApplications"]["applications"][number];
type Filter = "all" | ApplicationStatus;
const FILTERS: Filter[] = ["all", ...APPLICATION_STATUSES];

export default function ApplicationsReview({ ccaID }: { ccaID: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const list = api.ccaApplicationsHead.listApplications.useQuery(
    { ccaID, ...(filter === "all" ? {} : { status: filter }) },
    { retry: false },
  );

  if (list.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-200" />;
  }
  if (list.error) {
    const msg =
      list.error.message === "NOT_A_HEAD_OF_THIS_CCA"
        ? "You can only review applications for CCAs you head."
        : list.error.message === "CCA_APPLICATIONS_DISABLED"
          ? "CCA applications aren't open right now."
          : "These couldn't be loaded. Reload the page.";
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-600">
        {msg}
      </div>
    );
  }

  const apps = list.data.applications;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === f
                ? "bg-emerald-600 text-white"
                : "bg-white text-gray-600 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"
            }`}
          >
            {f === "all" ? "All" : statusLabel(f)}
          </button>
        ))}
      </div>

      {apps.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
          {filter === "all"
            ? "No applications yet."
            : `No ${statusLabel(filter).toLowerCase()} applications.`}
        </div>
      ) : (
        <ul className="space-y-3">
          {apps.map((a) => (
            <ApplicationRow key={a.applicationID} ccaID={ccaID} app={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------- stepper --------------------------------- */

const STEP_LABELS = [
  "Slot to be booked",
  "Interview booked",
  "Interviewed",
] as const;

function stageOf(status: string | null): number {
  switch (status) {
    case "submitted":
      return 0;
    case "interview_scheduled":
      return 1;
    case "interviewed":
      return 2;
    case "accepted":
    case "rejected":
      return 3;
    default:
      return 0;
  }
}

/** Horizontal progress: Slot to be booked → Interview booked → Interviewed →
 *  Decision. The final node turns green (accepted) or rose (not accepted). */
function Stepper({ status }: { status: string | null }) {
  const decided = status === "accepted" || status === "rejected";
  const rejected = status === "rejected";
  const stage = stageOf(status);
  const steps = [
    ...STEP_LABELS,
    decided ? (rejected ? "Not accepted" : "Accepted") : "Decision",
  ];

  return (
    <div className="flex items-start">
      {steps.map((label, i) => {
        const isDecisionNode = i === 3;
        const done = i < stage || (decided && isDecisionNode);
        const current = i === stage && !decided;

        // Full class strings only — Tailwind can't see interpolated names.
        const dot = done
          ? isDecisionNode && rejected
            ? "border-rose-600 bg-rose-600 text-white"
            : "border-emerald-600 bg-emerald-600 text-white"
          : current
            ? "border-emerald-600 bg-white text-emerald-700"
            : "border-gray-300 bg-white text-gray-300";
        const line = (filled: boolean) =>
          `h-0.5 flex-1 ${filled ? "bg-emerald-600" : "bg-gray-200"}`;

        return (
          <div key={i} className="flex flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              <div className={i === 0 ? "flex-1 opacity-0" : line(i <= stage)} />
              <div
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold ${dot}`}
              >
                {done ? (
                  isDecisionNode && rejected ? (
                    <X className="h-3.5 w-3.5" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )
                ) : (
                  i + 1
                )}
              </div>
              <div
                className={
                  i === steps.length - 1
                    ? "flex-1 opacity-0"
                    : line(i + 1 <= stage)
                }
              />
            </div>
            <span
              className={`mt-1 text-center text-[10px] leading-tight ${
                current
                  ? "font-semibold text-emerald-700"
                  : done
                    ? "text-gray-600"
                    : "text-gray-400"
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------- rows ------------------------------------ */

function ApplicationRow({ ccaID, app }: { ccaID: number; app: AppRow }) {
  const [open, setOpen] = useState(false);
  const name = app.applicant.displayName ?? app.userID;

  return (
    <li className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-gray-50"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700">
          {(name || "?").slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-gray-900">{name}</span>
            <span
              className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
                app.status,
              )}`}
            >
              {statusLabel(app.status)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            {[app.applicant.matric, app.applicant.email]
              .filter(Boolean)
              .join(" · ") || app.userID}
          </p>
          {app.slot && app.status === "interview_scheduled" && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-emerald-700">
              <CalendarClock className="h-3.5 w-3.5" />
              {formatSlot(app.slot.startTime, app.slot.endTime)}
              {app.slot.location && (
                <span className="inline-flex items-center gap-1 text-gray-500">
                  <MapPin className="h-3 w-3" />
                  {app.slot.location}
                </span>
              )}
            </p>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && <ApplicationDetail ccaID={ccaID} app={app} />}
    </li>
  );
}

/** Expanded detail: progress, the applicant's full details + application notes,
 *  the interview notes (read-only — notes are added on the Interviews tab), and
 *  the Accept / Deny decision. */
function ApplicationDetail({ ccaID, app }: { ccaID: number; app: AppRow }) {
  const utils = api.useUtils();
  const detail = api.ccaApplicationsHead.getApplication.useQuery(
    { ccaID, applicationID: app.applicationID },
    { retry: false },
  );
  const [reason, setReason] = useState("");

  const decide = api.ccaApplicationsHead.decide.useMutation({
    onSuccess: () =>
      utils.ccaApplicationsHead.listApplications.invalidate({ ccaID }),
  });

  const decided = isTerminalStatus(app.status);
  const withdrawn = app.status === "withdrawn";

  return (
    <div className="space-y-4 border-t border-gray-100 bg-gray-50/50 p-4">
      {!withdrawn && (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <Stepper status={app.status} />
        </div>
      )}

      {/* Full applicant details + application notes */}
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <ApplicantDetails
          applicant={app.applicant}
          userID={app.userID}
          notes={app.notes}
        />
      </div>

      {/* Interview notes — read only here */}
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
          Interview notes
        </p>
        {detail.isPending ? (
          <div className="mt-1 h-10 animate-pulse rounded bg-gray-100" />
        ) : detail.error ? (
          <p className="mt-1 text-sm text-red-600">
            Couldn&rsquo;t load interview notes.
          </p>
        ) : (
          <NoteList notes={detail.data.interviewNotes} />
        )}
      </div>

      {/* Decision */}
      {withdrawn ? (
        <p className="text-sm text-gray-500">Withdrawn by the applicant.</p>
      ) : decided ? (
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            app.status === "accepted"
              ? "bg-green-50 text-green-800"
              : "bg-rose-50 text-rose-800"
          }`}
        >
          <span className="font-medium">{statusLabel(app.status)}</span>
          {app.decisionReason ? ` — ${app.decisionReason}` : ""}
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={reason}
            maxLength={DECISION_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional — shared with the applicant if you deny)"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
          {decide.error && (
            <p className="text-sm text-red-600">
              {decide.error.message === "ALREADY_DECIDED"
                ? "This application was already decided. Refresh."
                : "That didn't go through. Try again."}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({
                  ccaID,
                  applicationID: app.applicationID,
                  decision: "accepted",
                  reason: reason.trim() || undefined,
                })
              }
              className="inline-flex items-center gap-1.5"
            >
              <Check className="h-4 w-4" />
              {decide.isPending ? "Saving…" : "Accept"}
            </Button>
            <button
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({
                  ccaID,
                  applicationID: app.applicationID,
                  decision: "rejected",
                  reason: reason.trim() || undefined,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NoteList({
  notes,
}: {
  notes: {
    id: string;
    body: string | null;
    createdAt: Date | null;
    authorName: string | null;
  }[];
}) {
  if (!notes || notes.length === 0) {
    return <p className="mt-1 text-sm text-gray-400">No interview notes yet.</p>;
  }
  return (
    <ul className="mt-1.5 space-y-2">
      {notes.map((n) => (
        <li key={n.id} className="rounded-md bg-gray-50 px-3 py-2 text-sm">
          <p className="whitespace-pre-line text-gray-700">{n.body}</p>
          <p className="mt-1 text-xs text-gray-400">
            {n.authorName ?? "Head"}
            {n.createdAt ? ` · ${new Date(n.createdAt).toLocaleString()}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
