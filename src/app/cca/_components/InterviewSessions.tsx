"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { addNoteInput, INTERVIEW_NOTE_MAX } from "~/lib/schemas/ccaApplication";
import { formatSlot } from "~/app/ccas/_lib/status";

type AppRow =
  RouterOutputs["ccaApplicationsHead"]["listApplications"]["applications"][number];

/**
 * The "Interviews" tab — the head's run-sheet for booked interviews, distinct
 * from "Interview slots" (which is about opening availability). It answers "how
 * do I mark an interview as done": each booked interview has a Mark done button
 * that moves it to Interviewed; from there it's reviewed/decided in the
 * Applications tab. Notes can be added here, during the interview.
 */
export default function InterviewSessions({ ccaID }: { ccaID: number }) {
  const list = api.ccaApplicationsHead.listApplications.useQuery(
    { ccaID },
    { retry: false },
  );

  if (list.isPending) {
    return <div className="h-48 animate-pulse rounded-lg bg-gray-200" />;
  }
  if (list.error) {
    const msg =
      list.error.message === "NOT_A_HEAD_OF_THIS_CCA"
        ? "You can only run interviews for CCAs you head."
        : list.error.message === "CCA_APPLICATIONS_DISABLED"
          ? "CCA applications aren't open right now."
          : "These couldn't be loaded. Reload the page.";
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-600">
        {msg}
      </div>
    );
  }

  const byTime = (a: AppRow, b: AppRow) =>
    (a.slot?.startTime ?? Number.MAX_SAFE_INTEGER) -
    (b.slot?.startTime ?? Number.MAX_SAFE_INTEGER);
  const apps = list.data.applications;
  const scheduled = apps
    .filter((a) => a.status === "interview_scheduled")
    .sort(byTime);
  const completed = apps.filter((a) => a.status === "interviewed").sort(byTime);

  if (scheduled.length === 0 && completed.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-900">
          No interviews booked yet
        </p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
          Open availability under <span className="font-medium">Interview
          slots</span>; once residents book, their interviews show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Section
        title="To interview"
        subtitle="Booked interviews. Mark each done once you've met the applicant."
        rows={scheduled}
        ccaID={ccaID}
        markable
        emptyText="Nothing booked right now."
      />
      <Section
        title="Interviewed"
        subtitle="Done — review and accept or reject from the Applications tab."
        rows={completed}
        ccaID={ccaID}
        markable={false}
        emptyText="No completed interviews yet."
      />
    </div>
  );
}

function Section({
  title,
  subtitle,
  rows,
  ccaID,
  markable,
  emptyText,
}: {
  title: string;
  subtitle: string;
  rows: AppRow[];
  ccaID: number;
  markable: boolean;
  emptyText: string;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-400">{rows.length}</span>
      </div>
      <p className="mb-2 text-xs text-gray-500">{subtitle}</p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-400">
          {emptyText}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <SessionRow
              key={a.applicationID}
              ccaID={ccaID}
              app={a}
              markable={markable}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionRow({
  ccaID,
  app,
  markable,
}: {
  ccaID: number;
  app: AppRow;
  markable: boolean;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const mark = api.ccaApplicationsHead.markInterviewed.useMutation({
    onSuccess: () =>
      utils.ccaApplicationsHead.listApplications.invalidate({ ccaID }),
  });

  const name = app.applicant.displayName ?? app.userID;
  const sub =
    [app.applicant.matric, app.applicant.email].filter(Boolean).join(" · ") ||
    app.userID;

  return (
    <li className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="shrink-0 rounded-md bg-gray-50 px-2 py-1 text-xs font-medium tabular-nums text-gray-700">
            {app.slot ? formatSlot(app.slot.startTime, app.slot.endTime) : "No time"}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-gray-900">
              {name}
            </span>
            <span className="block truncate text-xs text-gray-500">{sub}</span>
          </span>
          <ChevronDown
            className={`ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
        {markable && (
          <Button
            onClick={() =>
              mark.mutate({ ccaID, applicationID: app.applicationID })
            }
            disabled={mark.isPending}
            className="inline-flex shrink-0 items-center gap-1.5"
          >
            <Check className="h-4 w-4" />
            {mark.isPending ? "…" : "Mark done"}
          </Button>
        )}
      </div>
      {open && (
        <SessionDetail
          ccaID={ccaID}
          applicationID={app.applicationID}
          applicantNotes={app.notes}
        />
      )}
    </li>
  );
}

function SessionDetail({
  ccaID,
  applicationID,
  applicantNotes,
}: {
  ccaID: number;
  applicationID: number;
  applicantNotes: string | null;
}) {
  const utils = api.useUtils();
  const detail = api.ccaApplicationsHead.getApplication.useQuery(
    { ccaID, applicationID },
    { retry: false },
  );
  const [note, setNote] = useState("");
  const addNote = api.ccaApplicationsHead.addNote.useMutation({
    onSuccess: async () => {
      setNote("");
      await utils.ccaApplicationsHead.getApplication.invalidate({
        ccaID,
        applicationID,
      });
    },
  });

  return (
    <div className="space-y-3 border-t border-gray-100 p-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Applicant&rsquo;s notes
        </p>
        <p className="mt-1 whitespace-pre-line text-sm text-gray-700">
          {applicantNotes?.trim() ? applicantNotes : "— none —"}
        </p>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Interview notes
        </p>
        {detail.isPending ? (
          <div className="mt-1 h-10 animate-pulse rounded bg-gray-100" />
        ) : detail.error ? (
          <p className="mt-1 text-sm text-red-600">Couldn&rsquo;t load notes.</p>
        ) : detail.data.interviewNotes.length === 0 ? (
          <p className="mt-1 text-sm text-gray-400">No interview notes yet.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {detail.data.interviewNotes.map((n) => (
              <li
                key={n.id}
                className="rounded-md bg-gray-50 px-3 py-2 text-sm"
              >
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
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = addNoteInput.safeParse({
            ccaID,
            applicationID,
            body: note,
          });
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
    </div>
  );
}
