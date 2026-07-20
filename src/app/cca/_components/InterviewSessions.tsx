"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { addNoteInput, INTERVIEW_NOTE_MAX } from "~/lib/schemas/ccaApplication";
import { formatSlot } from "~/app/ccas/_lib/status";
import ApplicantDetails from "./ApplicantDetails";

type AppRow =
  RouterOutputs["ccaApplicationsHead"]["listApplications"]["applications"][number];

/** Local calendar-day key (YYYY-MM-DD) for an epoch-seconds time. */
function dayKey(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The "Interviews" tab — the head's run-sheet, distinct from "Interview slots"
 * (availability). Today's interviews sit at the top, then everything else still
 * to be interviewed, then the ones already done at the bottom. Each row's Mark
 * done button moves it to Interviewed; accept/reject happens on the Applications
 * tab. Expanding a row shows the applicant's full details, the notes they sent,
 * and the interview notes (which can be added here, during the interview).
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

  const today = dayKey(Math.floor(Date.now() / 1000));
  const isToday = (a: AppRow) =>
    a.slot?.startTime != null && dayKey(a.slot.startTime) === today;
  const todays = scheduled.filter(isToday);
  const upcoming = scheduled.filter((a) => !isToday(a));

  if (scheduled.length === 0 && completed.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-900">
          No interviews booked yet
        </p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
          Open availability under{" "}
          <span className="font-medium">Interview slots</span>; once residents
          book, their interviews show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {todays.length > 0 && (
        <Section
          title="Today"
          subtitle="Interviews happening today."
          rows={todays}
          ccaID={ccaID}
          markable
          highlight
        />
      )}
      {upcoming.length > 0 && (
        <Section
          title="To be interviewed"
          subtitle="Booked — mark each done once you've met the applicant."
          rows={upcoming}
          ccaID={ccaID}
          markable
        />
      )}
      {completed.length > 0 && (
        <Section
          title="Already interviewed"
          subtitle="Done — review and accept or reject on the Applications tab."
          rows={completed}
          ccaID={ccaID}
          markable={false}
        />
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  rows,
  ccaID,
  markable,
  highlight = false,
}: {
  title: string;
  subtitle: string;
  rows: AppRow[];
  ccaID: number;
  markable: boolean;
  highlight?: boolean;
}) {
  return (
    <section
      className={
        highlight ? "rounded-lg border border-emerald-200 bg-emerald-50/40 p-3" : ""
      }
    >
      <div className="mb-2 flex items-baseline gap-2">
        <h2
          className={`text-sm font-semibold ${
            highlight ? "text-emerald-800" : "text-gray-900"
          }`}
        >
          {title}
        </h2>
        <span className="text-xs text-gray-400">{rows.length}</span>
      </div>
      <p className="mb-2 text-xs text-gray-500">{subtitle}</p>
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
    <li className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="shrink-0 rounded-md bg-gray-50 px-2 py-1 text-xs font-medium tabular-nums text-gray-700">
            {app.slot
              ? formatSlot(app.slot.startTime, app.slot.endTime)
              : "No time"}
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
      {open && <SessionDetail ccaID={ccaID} app={app} />}
    </li>
  );
}

function SessionDetail({ ccaID, app }: { ccaID: number; app: AppRow }) {
  const utils = api.useUtils();
  const applicationID = app.applicationID;
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
    <div className="space-y-3 border-t border-gray-100 bg-gray-50/50 p-3">
      {/* Full details + the notes they sent with the application */}
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <ApplicantDetails
          applicant={app.applicant}
          userID={app.userID}
          notes={app.notes}
        />
      </div>

      {/* Interview notes + add */}
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
          Interview notes
        </p>
        {detail.isPending ? (
          <div className="mt-1 h-10 animate-pulse rounded bg-gray-100" />
        ) : detail.error ? (
          <p className="mt-1 text-sm text-red-600">Couldn&rsquo;t load notes.</p>
        ) : detail.data.interviewNotes.length === 0 ? (
          <p className="mt-1 text-sm text-gray-400">No interview notes yet.</p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {detail.data.interviewNotes.map((n) => (
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
        )}

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
          className="mt-3 space-y-2"
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
    </div>
  );
}
