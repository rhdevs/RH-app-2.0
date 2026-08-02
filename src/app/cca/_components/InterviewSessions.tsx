"use client";

import { useState } from "react";
import { Check, ChevronDown, MapPin, Users } from "lucide-react";

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

/** One session: the slot, and everyone being seen in it. */
type Session = { slot: AppRow["slot"]; rows: AppRow[] };

/** Still to be run. Drives which SECTION a session lands in — see below. */
const isPending = (s: Session) =>
  s.rows.some((r) => r.status === "interview_scheduled");

/**
 * Group rows into sessions, preserving the caller's ordering.
 *
 * CALLED ONCE, OVER EVERY ROW — never per section. Sections partition by
 * status, and a capacity-4 slot where two applicants have been marked done and
 * two have not would otherwise be split into two sessions for the same slot,
 * each headed "2 applicants of 4". The slot is one event; it gets one header,
 * and the section it lands in is decided from the session as a whole
 * (isPending: anyone still to be seen keeps the whole session in the to-do
 * list). Per-row state — the Mark done button — stays per row.
 *
 * Grouped on slotID, NOT on the formatted time: two distinct slots can print
 * the same label (different locations, or a slot canceled and reopened), and
 * merging those into one session would put people in a room they are not in.
 * Applications with no slot each become their own single-row session, so
 * "No time" rows never collapse into one another.
 */
function groupBySlot(rows: AppRow[]): Session[] {
  const out: Session[] = [];
  const bySlot = new Map<number, Session>();
  for (const r of rows) {
    const id = r.slot?.slotID ?? null;
    if (id === null) {
      out.push({ slot: null, rows: [r] });
      continue;
    }
    const existing = bySlot.get(id);
    if (existing) {
      existing.rows.push(r);
    } else {
      const session: Session = { slot: r.slot, rows: [r] };
      bySlot.set(id, session);
      out.push(session);
    }
  }
  return out;
}

/**
 * The "Interviews" tab — the head's run-sheet, distinct from "Interview slots"
 * (availability). Today's interviews sit at the top, then everything else still
 * to be interviewed, then the ones already done at the bottom. Each row's Mark
 * done button moves it to Interviewed; accept/reject happens on the Applications
 * tab. Expanding a row shows the applicant's full details, the notes they sent,
 * and the interview notes (which can be added here, during the interview).
 *
 * Applicants sharing a slot are GROUPED under one session header rather than
 * listed as siblings that happen to repeat the same time. A group interview is
 * one thing that happens once, with four people in the room — a run-sheet that
 * prints the 10:00 slot four times is a run-sheet you cannot follow. Mark-done
 * stays PER APPLICANT: they are interviewed together but assessed individually.
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
  // Sort and group ONCE across both statuses, so a part-done group slot stays a
  // single session. Sorting first means the sessions come out time-ordered and
  // each session's rows are in time order too (they share a time, so this just
  // makes the order stable).
  const runnable = apps
    .filter(
      (a) => a.status === "interview_scheduled" || a.status === "interviewed",
    )
    .sort(byTime);
  const sessions = groupBySlot(runnable);

  const today = dayKey(Math.floor(Date.now() / 1000));
  const isToday = (s: Session) =>
    s.slot?.startTime != null && dayKey(s.slot.startTime) === today;
  const pending = sessions.filter(isPending);
  const todays = pending.filter(isToday);
  const upcoming = pending.filter((s) => !isToday(s));
  const completed = sessions.filter((s) => !isPending(s));

  if (sessions.length === 0) {
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
          sessions={todays}
          ccaID={ccaID}
          highlight
        />
      )}
      {upcoming.length > 0 && (
        <Section
          title="To be interviewed"
          subtitle="Booked — mark each done once you've met the applicant."
          sessions={upcoming}
          ccaID={ccaID}
        />
      )}
      {completed.length > 0 && (
        <Section
          title="Already interviewed"
          subtitle="Done — review and accept or reject on the Applications tab."
          sessions={completed}
          ccaID={ccaID}
        />
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  sessions,
  ccaID,
  highlight = false,
}: {
  title: string;
  subtitle: string;
  /** Already grouped by the caller — see the note on groupBySlot. */
  sessions: Session[];
  ccaID: number;
  highlight?: boolean;
}) {
  const rowCount = sessions.reduce((n, s) => n + s.rows.length, 0);
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
        <span className="text-xs text-gray-400">
          {rowCount}
          {sessions.length !== rowCount
            ? ` · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>
      <p className="mb-2 text-xs text-gray-500">{subtitle}</p>
      <ul className="space-y-3">
        {sessions.map((s, i) => (
          <SessionGroup
            key={s.slot?.slotID ?? `unslotted-${s.rows[0]?.applicationID ?? i}`}
            ccaID={ccaID}
            session={s}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * One session header with its applicants underneath.
 *
 * The header is shown whenever the SLOT is a group slot (capacity > 1) — not
 * merely when more than one person has booked. A capacity-4 slot with one
 * booking is still a group session: three more people may walk in before it
 * runs, and rendering it as an ordinary 1:1 row would tell the head the exact
 * opposite. That is the deliberate choice; the alternative (header only when
 * rows > 1) makes the run-sheet silently change shape as bookings arrive.
 *
 * A genuine 1:1 renders WITHOUT a header — today's layout, and the
 * overwhelmingly common case. Wrapping every single interview in a "1 applicant"
 * banner would make every existing CCA's run-sheet noisier to buy a feature
 * none of them use yet.
 */
function SessionGroup({ ccaID, session }: { ccaID: number; session: Session }) {
  const { slot, rows } = session;
  const capacity = slot?.capacity ?? 1;
  const grouped = rows.length > 1 || capacity > 1;

  if (!grouped) {
    return <SessionRow ccaID={ccaID} app={rows[0]!} showTime />;
  }

  const done = rows.filter((r) => r.status === "interviewed").length;

  return (
    <li className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 px-3 py-2">
        <span className="text-sm font-semibold tabular-nums text-amber-900">
          {slot ? formatSlot(slot.startTime, slot.endTime) : "No time"}
        </span>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800">
          <Users className="h-3.5 w-3.5" />
          {rows.length} applicant{rows.length === 1 ? "" : "s"}
          {capacity > rows.length ? ` of ${capacity}` : ""}
        </span>
        {done > 0 && done < rows.length && (
          <span className="text-xs text-amber-700">{done} done</span>
        )}
        {slot?.location && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-800">
            <MapPin className="h-3.5 w-3.5" />
            {slot.location}
          </span>
        )}
      </div>
      <ul className="space-y-2 p-2">
        {rows.map((a) => (
          <SessionRow
            key={a.applicationID}
            ccaID={ccaID}
            app={a}
            showTime={false}
          />
        ))}
      </ul>
    </li>
  );
}

function SessionRow({
  ccaID,
  app,
  showTime,
}: {
  ccaID: number;
  app: AppRow;
  /** False inside a grouped session — the header already says the time, and
   *  repeating it on every row is the fragmentation the grouping removes. */
  showTime: boolean;
}) {
  // PER ROW, not per section. A group session sits in "To be interviewed" while
  // some of its applicants are already done; those rows must not offer Mark
  // done again (the server would refuse it with NOT_INTERVIEWABLE anyway).
  const markable = app.status === "interview_scheduled";
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
          {showTime && (
            <span className="shrink-0 rounded-md bg-gray-50 px-2 py-1 text-xs font-medium tabular-nums text-gray-700">
              {app.slot
                ? formatSlot(app.slot.startTime, app.slot.endTime)
                : "No time"}
            </span>
          )}
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
        {markable ? (
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
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-gray-400">
            <Check className="h-3.5 w-3.5" /> Done
          </span>
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
