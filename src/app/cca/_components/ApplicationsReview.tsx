"use client";

import { useState } from "react";
import { CalendarClock, ChevronDown, MapPin } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  addNoteInput,
  APPLICATION_STATUSES,
  DECISION_REASON_MAX,
  INTERVIEW_NOTE_MAX,
  isTerminalStatus,
  type ApplicationStatus,
} from "~/lib/schemas/ccaApplication";
import {
  formatSlot,
  statusBadgeClass,
  statusLabel,
} from "~/app/ccas/_lib/status";

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
    if (list.error.message === "NOT_A_HEAD_OF_THIS_CCA") {
      return (
        <Denied text="You can only review applications for CCAs you head." />
      );
    }
    if (list.error.message === "CCA_APPLICATIONS_DISABLED") {
      return <Denied text="CCA applications aren't open right now." />;
    }
    return <Denied text="These couldn't be loaded. Reload the page." tone="error" />;
  }

  const apps = list.data.applications;

  return (
    <div className="space-y-4">
      {/* Status filter */}
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

function Denied({
  text,
  tone = "muted",
}: {
  text: string;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-6 text-sm ${
        tone === "error"
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-gray-200 bg-white text-gray-600"
      }`}
    >
      {text}
    </div>
  );
}

type AppRow =
  RouterOutputs["ccaApplicationsHead"]["listApplications"]["applications"][number];

function ApplicationRow({ ccaID, app }: { ccaID: number; app: AppRow }) {
  const [open, setOpen] = useState(false);
  const decided = isTerminalStatus(app.status);
  const name = app.applicant.displayName ?? app.userID;

  return (
    <li className="rounded-lg border border-gray-200 bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
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

      {open && (
        <ApplicationDetail ccaID={ccaID} applicationID={app.applicationID} decided={decided} />
      )}
    </li>
  );
}

/** Expanded detail: the applicant's notes, interview notes, and the decision
 *  controls. Loads getApplication lazily so a long queue doesn't fetch every
 *  application's full detail up front. */
function ApplicationDetail({
  ccaID,
  applicationID,
  decided,
}: {
  ccaID: number;
  applicationID: number;
  decided: boolean;
}) {
  const utils = api.useUtils();
  const detail = api.ccaApplicationsHead.getApplication.useQuery(
    { ccaID, applicationID },
    { retry: false },
  );
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  const refresh = async () => {
    await Promise.all([
      utils.ccaApplicationsHead.getApplication.invalidate({ ccaID, applicationID }),
      utils.ccaApplicationsHead.listApplications.invalidate({ ccaID }),
    ]);
  };

  const addNote = api.ccaApplicationsHead.addNote.useMutation({
    onSuccess: async () => {
      setNote("");
      await refresh();
    },
  });
  const decide = api.ccaApplicationsHead.decide.useMutation({
    onSuccess: refresh,
  });
  const markInterviewed = api.ccaApplicationsHead.markInterviewed.useMutation({
    onSuccess: refresh,
  });

  if (detail.isPending) {
    return (
      <div className="border-t border-gray-100 p-4">
        <div className="h-20 animate-pulse rounded bg-gray-100" />
      </div>
    );
  }
  if (detail.error) {
    return (
      <div className="border-t border-gray-100 p-4 text-sm text-red-600">
        Couldn&rsquo;t load this application.
      </div>
    );
  }

  const d = detail.data;
  const canInterview =
    d.status === "submitted" || d.status === "interview_scheduled";

  return (
    <div className="space-y-4 border-t border-gray-100 p-4">
      {/* Applicant's own notes */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Applicant&rsquo;s notes
        </p>
        <p className="mt-1 whitespace-pre-line text-sm text-gray-700">
          {d.notes?.trim() ? d.notes : "— none —"}
        </p>
      </div>

      {/* Interview notes */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Interview notes
        </p>
        <NoteList notes={d.interviewNotes} />
      </div>

      {/* Add a note */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = addNoteInput.safeParse({ ccaID, applicationID, body: note });
          if (!parsed.success) return;
          addNote.mutate(parsed.data);
        }}
        className="space-y-2"
      >
        <textarea
          value={note}
          maxLength={INTERVIEW_NOTE_MAX}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add an interview note…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={addNote.isPending || note.trim().length === 0}
        >
          {addNote.isPending ? "Adding…" : "Add note"}
        </Button>
      </form>

      {/* Decision */}
      {decided ? (
        <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
          Decision: <span className="font-medium">{statusLabel(d.status)}</span>
          {d.decisionReason ? ` — ${d.decisionReason}` : ""}
        </div>
      ) : (
        <div className="space-y-2 border-t border-gray-100 pt-4">
          {canInterview && (
            <button
              onClick={() => markInterviewed.mutate({ ccaID, applicationID })}
              disabled={markInterviewed.isPending}
              className="text-xs font-medium text-gray-500 hover:text-gray-800 disabled:opacity-50"
            >
              {markInterviewed.isPending ? "…" : "Mark as interviewed"}
            </button>
          )}
          <input
            type="text"
            value={reason}
            maxLength={DECISION_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional, shared with applicant on rejection)"
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
                  applicationID,
                  decision: "accepted",
                  reason: reason.trim() || undefined,
                })
              }
            >
              {decide.isPending ? "…" : "Accept"}
            </Button>
            <button
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({
                  ccaID,
                  applicationID,
                  decision: "rejected",
                  reason: reason.trim() || undefined,
                })
              }
              className="rounded-md px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
            >
              Reject
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
    <ul className="mt-1 space-y-2">
      {notes.map((n) => (
        <li key={n.id} className="rounded-md bg-gray-50 px-3 py-2 text-sm">
          <p className="whitespace-pre-line text-gray-700">{n.body}</p>
          <p className="mt-1 text-xs text-gray-400">
            {n.authorName ?? "Head"}
            {n.createdAt
              ? ` · ${new Date(n.createdAt).toLocaleString()}`
              : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
