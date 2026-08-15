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

/**
 * Every failure mode of `decide`, in the head's language.
 *
 * Named exhaustively rather than collapsed into one line because the Accept /
 * Deny buttons now sit on the COLLAPSED card: a head who clicks one and sees
 * nothing happen has no panel open and no other clue about why. "That didn't go
 * through" is the fallback for an unrecognised code, not the default answer.
 */
function decideErrorMessage(code: string): string {
  switch (code) {
    case "ALREADY_DECIDED":
      return "This application was already decided. Reload the page.";
    case "NOT_A_HEAD_OF_THIS_CCA":
      return "You can only decide applications for CCAs you head.";
    case "CCA_APPLICATIONS_DISABLED":
      return "CCA applications aren't open right now.";
    case "CCA_BUSY":
      return "Someone else is updating this CCA. Try again in a moment.";
    case "MEMBERSHIP_WRITE_FAILED":
      return "Couldn't add them to the roster, so the decision wasn't saved. Tell the RHApp team.";
    case "NO_SUCH_APPLICATION":
      return "This application no longer exists. Reload the page.";
    default:
      return "That didn't go through. Try again.";
  }
}

/**
 * Accept / Deny. Rendered in three places — inline on the card at `sm` and up,
 * stacked under the applicant on a phone, and beside the reason box in the
 * expanded panel — so the pair is defined once and cannot drift.
 *
 * `block` stretches both to equal halves of their row. That is the phone
 * layout: sharing one line with the name squeezed "Ong Shao Aik" down to "O…"
 * and folded the interview slot into a six-line stack.
 */
function DecisionButtons({
  pending,
  onDecide,
  block = false,
}: {
  pending: boolean;
  onDecide: (decision: "accepted" | "rejected") => void;
  block?: boolean;
}) {
  return (
    <>
      <Button
        disabled={pending}
        onClick={() => onDecide("accepted")}
        className={`inline-flex items-center justify-center gap-1.5 ${
          block ? "flex-1" : ""
        }`}
      >
        <Check className="h-4 w-4" />
        {pending ? "Saving…" : "Accept"}
      </Button>
      <button
        disabled={pending}
        onClick={() => onDecide("rejected")}
        className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 ${
          block ? "flex-1" : ""
        }`}
      >
        <X className="h-4 w-4" />
        Deny
      </button>
    </>
  );
}

/**
 * One application card.
 *
 * THE DECISION LIVES ON THE CARD, not only in the expanded panel. Accept / Deny
 * used to render inside `ApplicationDetail`, so a head had to know to click a
 * row before any button existed — a queue of 30 applicants looked like a
 * read-only list, and at least one head reported being unable to decide at all.
 * The panel keeps its own copy of the buttons because that is where the reason
 * box is; both drive the SAME mutation and the SAME `reason` state, held here,
 * so the two can never disagree about what is in flight.
 *
 * The header is a flex ROW of controls rather than one big `<button>` — a
 * button cannot legally contain the decision buttons — so the expand toggle is
 * the name region plus the chevron, and both carry `aria-expanded`.
 */
function ApplicationRow({ ccaID, app }: { ccaID: number; app: AppRow }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const utils = api.useUtils();
  const name = app.applicant.displayName ?? app.userID;
  const panelId = `application-${app.applicationID}`;

  const decide = api.ccaApplicationsHead.decide.useMutation({
    onSuccess: () =>
      utils.ccaApplicationsHead.listApplications.invalidate({ ccaID }),
  });

  // Terminal is accepted / rejected / withdrawn — the three states with nothing
  // left to decide. One check, so the card and the panel agree by construction.
  const canDecide = !isTerminalStatus(app.status);
  const toggle = () => setOpen((o) => !o);

  const submit = (decision: "accepted" | "rejected") =>
    decide.mutate({
      ccaID,
      applicationID: app.applicationID,
      decision,
      // Empty stays undefined: the reason is optional, and "" would be stored
      // as a decision reason the head never wrote.
      reason: reason.trim() || undefined,
    });

  return (
    <li className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="p-4 transition-colors hover:bg-gray-50">
        <div className="flex items-center gap-3">
          <button
            onClick={toggle}
            aria-expanded={open}
            aria-controls={panelId}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700">
              {(name || "?").slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-gray-900">
                  {name}
                </span>
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
                // flex-wrap, not inline-flex: the time and the room are two
                // chunks that must break BETWEEN themselves on a narrow screen,
                // not mid-phrase into a stack of single words.
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-emerald-700">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                    {formatSlot(app.slot.startTime, app.slot.endTime)}
                  </span>
                  {app.slot.location && (
                    <span className="inline-flex items-center gap-1 text-gray-500">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {app.slot.location}
                    </span>
                  )}
                </span>
              )}
            </div>
          </button>

          {/* Inline on the right from `sm` up; the phone gets the stacked row
              below instead. */}
          {canDecide && (
            <div className="hidden shrink-0 items-center gap-2 sm:flex">
              <DecisionButtons pending={decide.isPending} onDecide={submit} />
            </div>
          )}

          <button
            onClick={toggle}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={
              open ? `Hide ${name}'s details` : `Show ${name}'s details`
            }
            className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>
        </div>

        {canDecide && (
          <div className="mt-3 flex items-center gap-2 sm:hidden">
            <DecisionButtons
              pending={decide.isPending}
              onDecide={submit}
              block
            />
          </div>
        )}
      </div>

      {/* Card-level, so a quick decision that fails says why WITHOUT the head
          having to expand the row to find out. */}
      {decide.error && (
        <p className="border-t border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">
          {decideErrorMessage(decide.error.message)}
        </p>
      )}

      {open && (
        <div id={panelId}>
          <ApplicationDetail
            ccaID={ccaID}
            app={app}
            reason={reason}
            setReason={setReason}
            onDecide={submit}
            pending={decide.isPending}
          />
        </div>
      )}
    </li>
  );
}

/** Expanded detail: progress, the applicant's full details + application notes,
 *  the interview notes (read-only — notes are added on the Interviews tab), and
 *  the Accept / Deny decision WITH its optional reason.
 *
 *  The mutation and the `reason` string are owned by ApplicationRow and passed
 *  in, so the buttons here and the ones on the card are the same action — see
 *  the note on ApplicationRow. */
function ApplicationDetail({
  ccaID,
  app,
  reason,
  setReason,
  onDecide,
  pending,
}: {
  ccaID: number;
  app: AppRow;
  reason: string;
  setReason: (value: string) => void;
  onDecide: (decision: "accepted" | "rejected") => void;
  pending: boolean;
}) {
  const detail = api.ccaApplicationsHead.getApplication.useQuery(
    { ccaID, applicationID: app.applicationID },
    { retry: false },
  );

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
          {/* The error renders once, at card level, so it is visible whether or
              not this panel is open. */}
          <div className="flex items-center gap-2">
            <DecisionButtons pending={pending} onDecide={onDecide} />
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
