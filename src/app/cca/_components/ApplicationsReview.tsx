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
import {
  formatSlot,
  statusBadgeClass,
  statusLabel,
} from "~/app/ccas/_lib/status";
import ApplicantDetails from "./ApplicantDetails";

type AppRow =
  RouterOutputs["ccaApplicationsHead"]["listApplications"]["applications"][number];
type Filter = "all" | ApplicationStatus;
const FILTERS: Filter[] = ["all", ...APPLICATION_STATUSES];

export default function ApplicationsReview({ ccaID }: { ccaID: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const list = api.ccaApplicationsHead.listApplications.useQuery(
    { ccaID, ...(filter === "all" ? {} : { status: filter }) },
    {
      retry: false,
      // `filter` is in the query key, so every pill click is a cache MISS and
      // without this the whole surface — the recruitment banner along with it —
      // collapses to the grey skeleton below and then reappears. Keeping the
      // previous page's data on screen while the new one loads means a head
      // who is filtering during a freeze never watches the "recruitment is
      // closed" notice flicker in and out.
      placeholderData: (prev) => prev,
    },
  );

  if (list.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-200" />;
  }
  // `!list.data`, NOT `list.error`. react-query KEEPS the last good `data`
  // across a failed BACKGROUND refetch, and testing the error first tore the
  // whole queue down on a blip: the rows, the filter pills, the amber banner,
  // and any half-typed denial reason (that state lives on ApplicationRow, so it
  // dies with the subtree). A head 25 rows into a review lost their place to a
  // three-second network hiccup and got "These couldn't be loaded. Reload the
  // page." — which names neither the real cause nor anything they can act on.
  //
  // This is the same reasoning, and the same fix, as
  // admin/ccas/_components/RecruitmentControlPanel.tsx's `if (!data)`. A
  // refetch failure on top of good data renders the non-destructive strip
  // below the filter pills and changes nothing else.
  if (!list.data) {
    const msg =
      list.error?.message === "NOT_A_HEAD_OF_THIS_CCA"
        ? "You can only review applications for CCAs you head."
        : list.error?.message === "CCA_APPLICATIONS_DISABLED"
          ? "CCA applications aren't open right now."
          : "These couldn't be loaded. Reload the page.";
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-600">
        {msg}
      </div>
    );
  }

  const apps = list.data.applications;
  const recruitmentOpen = list.data.recruitmentOpen;
  // R2-M6. `filter` is in the query key, so a pill click is a cache miss; with
  // placeholderData the PREVIOUS filter's rows stay on screen while the new
  // ones load, and the pill highlight below flips synchronously. Without this
  // flag a head sees an active "Accepted" pill over a list of `submitted` rows
  // with fully live Accept/Deny buttons, and can decide the wrong person while
  // believing they are looking at a filtered list. Before placeholderData the
  // skeleton made that impossible; this restores the guarantee without
  // restoring the flicker.
  const stale = list.isPlaceholderData;

  return (
    <>
      {/* OUTSIDE the `space-y-4` container below, deliberately. This region is
          always mounted (see the next comment), so as a direct child of a
          `space-y-*` parent it would occupy a sibling slot and push everything
          after it down by 16px even while empty — a phantom gap in the normal,
          recruitment-open case. As a sibling of that container it costs nothing
          when empty, and the banner carries its own margin when it appears.

          Amber, not grey: this is the head-side idiom (see
          `admin/manage-ccas/page.tsx`) for "you are looking at a surface whose
          writes are switched off".

          THE LIVE REGION IS THE OUTER DIV, WHICH IS ALWAYS MOUNTED, and the
          conditional is INSIDE it. That is not a stylistic choice: a live
          region inserted into the DOM together with its own content is not
          reliably announced by screen readers — the region has to already
          exist for the change to register as a change. Since a head can be
          mid-review when the freeze lands and the banner appears under them,
          announcing it is the entire point, so the empty region is mounted up
          front and only its contents swap. `polite`, not `assertive`: it is
          news, not an interruption. */}
      <div role="status" aria-live="polite">
        {!recruitmentOpen && (
          <div
            id="recruitment-frozen"
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
          >
            <p className="text-sm font-medium text-amber-900">
              Recruitment is closed hall-wide
            </p>
            <p className="mt-1 text-sm text-amber-800">
              You can’t accept new members until the JCRC reopens recruitment,
              and applicants can’t book or reschedule an interview while it is
              closed. You can still deny applications, open slots, run the
              interviews already booked and add notes.
            </p>
          </div>
        )}
      </div>

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

        {/* The compensating signal for the `!list.data` reorder above. Without
            it, a failed BACKGROUND refetch is completely silent: the head keeps
            a working queue (which is the point) but has no way to know the
            figures stopped updating. `role="status"`, not `alert` — nothing is
            broken and nothing they did caused it. */}
        {list.error && (
          <p
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            Couldn’t refresh this queue just now, so it may be out of date.{" "}
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              Try again
            </button>
          </p>
        )}

        {/* Visible, and therefore usable as an aria-describedby target for the
            two decision buttons while the list is stale — a description that
            only a screen reader can reach is the same dead end as a `title`. */}
        {stale && (
          <p id="filter-loading" className="text-xs text-gray-500">
            Loading this filter…
          </p>
        )}

        {/* R2-M6: while the new filter's rows are loading, the list on screen
            still belongs to the PREVIOUS filter. Dim it and mark it busy so the
            mismatch between an active pill and the rows under it is visible;
            the decision buttons are refused through the same flag below.

            Dimmed and aria-busy, but NOT `pointer-events-none`: that would
            swallow mouse clicks before they reached the guards in
            DecisionButtons, so a mouse user would get the silence R2-M2 was
            raised about while a keyboard user got an explanation. The guards
            refuse both, and both hear why. */}
        {apps.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
            {filter === "all"
              ? "No applications yet."
              : `No ${statusLabel(filter).toLowerCase()} applications.`}
          </div>
        ) : (
          <ul
            aria-busy={stale}
            className={`space-y-3 transition-opacity ${
              stale ? "opacity-50" : ""
            }`}
          >
            {apps.map((a) => (
              <ApplicationRow
                key={a.applicationID}
                ccaID={ccaID}
                app={a}
                recruitmentOpen={recruitmentOpen}
                stale={stale}
              />
            ))}
          </ul>
        )}
      </div>
    </>
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
              <div
                className={i === 0 ? "flex-1 opacity-0" : line(i <= stage)}
              />
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

/**
 * A refusal produced by a CLIENT-SIDE guard, tagged with WHICH guard produced it.
 *
 * The tag is the whole point and it is not decoration. Two independent guards
 * refuse the decision buttons — the list is still loading (`stale`), and
 * recruitment is frozen (`!recruitmentOpen`) — and an untagged `string | null`
 * forced the render gate to be a DISJUNCTION over both causes. That produced two
 * live defects:
 *
 *   - the "still loading" sentence outlived the load indefinitely, because
 *     `!recruitmentOpen` kept the disjunction true for days, so the card went on
 *     telling a head to wait for a fetch that had finished and never named the
 *     real reason;
 *   - after the JCRC reopened recruitment, one filter click set `stale` for a
 *     round trip and re-showed the stale "recruitment is closed" sentence in a
 *     `role="alert"` — assertively announcing something FALSE while Accept was
 *     live.
 *
 * Tagging binds each sentence to the one flag that makes it true, so the gate
 * tests exactly that flag and a message can never outlive its own cause. Add a
 * third guard and you add a third `cause`; do not widen the gate.
 */
type Refusal = {
  cause: "stale" | "frozen";
  text: string;
};

/** True while the refusal's OWN cause still holds. Nothing else may gate it. */
function refusalStillTrue(
  r: Refusal,
  { stale, recruitmentOpen }: { stale: boolean; recruitmentOpen: boolean },
): boolean {
  return r.cause === "stale" ? stale : !recruitmentOpen;
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
    case "RECRUITMENT_CLOSED":
      return "CCA recruitment is closed, so you can’t accept new members right now. You can still deny applications and run interviews already booked.";
    // DISTINCT FROM THE LINE ABOVE, on purpose. RECRUITMENT_UNKNOWN means the
    // server could not READ the recruitment flag — the database was
    // unreachable — not that the JCRC closed anything. Telling a head that
    // recruitment is closed during an outage sends them to ask the JCRC about
    // a decision nobody made.
    case "RECRUITMENT_UNKNOWN":
      return "We couldn’t check whether recruitment is open. Try again in a moment.";
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
  recruitmentOpen,
  stale,
  onRefused,
}: {
  pending: boolean;
  onDecide: (decision: "accepted" | "rejected") => void;
  block?: boolean;
  recruitmentOpen: boolean;
  /** These rows belong to the previous filter — see R2-M6. */
  stale: boolean;
  /**
   * Called with a TAGGED refusal when a guard refuses a press, and with null
   * when a press is allowed through (so a stale refusal does not sit under a
   * decision that then succeeded). The parent renders it where a server error
   * would go, and gates it on the tagged cause alone — see `Refusal`.
   */
  onRefused: (refusal: Refusal | null) => void;
}) {
  return (
    <>
      {/* ONLY Accept is frozen. Deny stays live, deliberately: a freeze that
          also blocked rejections would strand every submitted applicant with
          no way to be told no.

          NATIVE `disabled` FOR `pending`, `aria-disabled` FOR THE FREEZE, and
          the split is deliberate. `pending` is a sub-second state where
          preventing a double submit is what matters. The freeze can last days,
          and a natively disabled button is removed from the tab order and
          cannot take focus — so a keyboard or screen-reader head would never
          land on it and would never hear the aria-describedby text pointing at
          the banner. The description would be wired to a control nobody can
          reach. aria-disabled keeps it focusable and announced as unavailable;
          the guard in the click handler is what actually refuses. */}
      <Button
        disabled={pending}
        aria-disabled={!recruitmentOpen || stale || undefined}
        // Points at whichever VISIBLE text explains the CURRENT reason, in the
        // same precedence the click guard uses: stale first, then frozen. A
        // control that announces "unavailable" with no reason is the failure
        // this attribute exists to prevent, and before this the stale case had
        // no description at all.
        aria-describedby={
          stale
            ? "filter-loading"
            : recruitmentOpen
              ? undefined
              : "recruitment-frozen"
        }
        onClick={() => {
          // EVERY GUARD SPEAKS. A silent `return` here is the bug this whole
          // arrangement was nearly responsible for: the button is not natively
          // disabled, so the press lands, and doing nothing at all leaves the
          // head pressing Enter into silence.
          // The tag must name the flag actually tested on its own line, and
          // the ORDER here is the precedence the gate and the aria-describedby
          // both follow: `stale` is checked first, so a press made while both
          // are true is a "stale" refusal and says so.
          if (stale) {
            onRefused({
              cause: "stale",
              text: "Still loading this filter — wait a moment before deciding.",
            });
            return;
          }
          if (!recruitmentOpen) {
            onRefused({
              cause: "frozen",
              text: "Recruitment is closed hall-wide, so new members can’t be accepted right now. You can still deny.",
            });
            return;
          }
          onRefused(null);
          onDecide("accepted");
        }}
        className={`inline-flex items-center justify-center gap-1.5 ${
          recruitmentOpen
            ? ""
            : "cursor-not-allowed opacity-50 hover:bg-primary"
        } ${block ? "flex-1" : ""}`}
      >
        <Check className="h-4 w-4" />
        {pending ? "Saving…" : "Accept"}
      </Button>
      {/* Deny is NEVER frozen (a freeze is not a gag order) but it IS blocked
          while the list is stale, for the R2-M6 reason: denying the wrong
          person because the pill said "Accepted" and the rows said otherwise is
          the same mistake as accepting the wrong person. Native `disabled`
          would be wrong here for the same focus reason as Accept. */}
      <button
        disabled={pending}
        aria-disabled={stale || undefined}
        // Deny has only ONE reason to be unavailable, so unlike Accept this is
        // unconditional on that single cause. It had no description at all
        // before, so a screen-reader head heard "unavailable" and nothing else.
        aria-describedby={stale ? "filter-loading" : undefined}
        onClick={() => {
          if (stale) {
            onRefused({
              cause: "stale",
              text: "Still loading this filter — wait a moment before deciding.",
            });
            return;
          }
          onRefused(null);
          onDecide("rejected");
        }}
        className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 ${
          stale ? "cursor-not-allowed opacity-50 hover:bg-transparent" : ""
        } ${block ? "flex-1" : ""}`}
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
function ApplicationRow({
  ccaID,
  app,
  recruitmentOpen,
  stale,
}: {
  ccaID: number;
  app: AppRow;
  recruitmentOpen: boolean;
  /** The rows on screen belong to the previous filter; see R2-M6 above. */
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  /**
   * R2-M2. The frozen Accept button is `aria-disabled` rather than natively
   * disabled, so that it stays focusable and its explanation stays reachable —
   * but that means a click now REACHES the handler and is refused by a guard.
   * A guard that returns silently is its own defect: the head presses Enter and
   * absolutely nothing happens, no error line, no announcement. That is exactly
   * the condition decideErrorMessage's own docblock says the card-level error
   * exists to prevent ("a head who clicks one and sees nothing happen has no
   * panel open and no other clue about why") — and the guard prevents the
   * mutation that would have produced it.
   *
   * So the refusal speaks for itself, in the same place and the same style a
   * real server refusal would. It matters most for the head who has scrolled
   * the amber banner off screen, and for a screen-reader head who has already
   * tabbed past the aria-describedby text — that is announced on FOCUS, never
   * on activation.
   */
  const [refused, setRefused] = useState<Refusal | null>(null);
  const utils = api.useUtils();
  const name = app.applicant.displayName ?? app.userID;
  const panelId = `application-${app.applicationID}`;

  const decide = api.ccaApplicationsHead.decide.useMutation({
    onSuccess: async () => {
      // Cleared so a denial reason written for THIS applicant cannot survive
      // into the next one. Normally the row unmounts on invalidation and the
      // state goes with it — but if the invalidation fails, the box would
      // otherwise still hold the previous reason.
      setReason("");
      await utils.ccaApplicationsHead.listApplications.invalidate({ ccaID });
    },
    // WITHOUT THIS, THE QUEUE GOES ON INSISTING RECRUITMENT IS OPEN AFTER THE
    // SERVER HAS REFUSED. `listApplications` is cached with a 30s staleTime and
    // no refetch interval, so a head whose cached `recruitmentOpen: true`
    // predates the JCRC's Stop sees every Accept button in the queue still
    // enabled and the amber banner still absent. They click Accept on the next
    // applicant, and the next, collecting the same refusal each time while the
    // page tells them nothing is wrong. The 15s propagation window guarantees
    // this state arises at least once per Stop.
    //
    // Narrowed to the two freeze sentinels rather than invalidating on every
    // error: ALREADY_DECIDED, NO_SUCH_APPLICATION and CCA_BUSY are answers
    // about this one request that a refetch cannot change, and re-fetching the
    // whole queue on every failure would turn a rejected decide into a request
    // amplifier.
    // ONLY RECRUITMENT_CLOSED, and RECRUITMENT_UNKNOWN is deliberately absent.
    //
    // Round 2 had both, which was self-defeating: RECRUITMENT_UNKNOWN is thrown
    // from exactly one place — the `catch` in services/ccaRecruitment.ts — and
    // it means THE DATABASE COULD NOT BE REACHED. Refetching against a database
    // that is down fails (the query is `retry: false`), and a failed fetch used
    // to tear the whole queue down, destroying the very "we couldn't check"
    // message the sentinel exists to display. The `!list.data` guard above now
    // prevents the teardown, but the refetch is still pointless: nothing was
    // decided and there is nothing new to fetch. So we do not fire it.
    //
    // RECRUITMENT_CLOSED is the opposite case and does need it: there the
    // database is up, `recruitmentOpen` in the cache is merely stale, the
    // refetch succeeds, and the banner and disabled Accept buttons appear as
    // intended. Without it the queue goes on offering live Accept buttons after
    // the server has started refusing them.
    //
    // Nothing else invalidates: ALREADY_DECIDED, NO_SUCH_APPLICATION and
    // CCA_BUSY are answers about this one request that a refetch cannot change,
    // and refetching the whole queue on every failure would turn a rejected
    // decide into a request amplifier.
    onError: async (e) => {
      if (e.message === "RECRUITMENT_CLOSED") {
        await utils.ccaApplicationsHead.listApplications.invalidate({ ccaID });
      }
    },
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
              <DecisionButtons
                pending={decide.isPending}
                onDecide={submit}
                recruitmentOpen={recruitmentOpen}
                stale={stale}
                onRefused={setRefused}
              />
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
              recruitmentOpen={recruitmentOpen}
              stale={stale}
              onRefused={setRefused}
            />
          </div>
        )}
      </div>

      {/* Card-level, so a quick decision that fails says why WITHOUT the head
          having to expand the row to find out.

          A CLIENT-SIDE refusal renders in the same slot and the same style as a
          server one, because to the head they are the same event — "I pressed
          Accept and it did not happen" — and splitting them into two visual
          registers would only make the client one look less real. `role="alert"`
          because unlike the server error this is not accompanied by any other
          change on screen; without it the press is silent. The server error is
          left without one: it already interrupts a visible pending state.

          GATED ON ITS OWN CAUSE STILL HOLDING, rather than cleared by an
          effect. A refusal is true only while the thing that produced it is
          true, so the gate asks `refusalStillTrue`, which tests THE ONE FLAG
          THE TAG NAMES — not both.

          An earlier version gated on `!recruitmentOpen || stale`, reasoning
          that deriving from "the same flags the guards test" made the message
          and the buttons agree by construction. It does not: with two guards
          feeding one untagged string, a disjunction lets either cause keep the
          other's sentence alive. See the `Refusal` docblock for the two defects
          that produced.

          `canDecide` is in the gate as well: if a co-head's decision arrives by
          refetch, the buttons unmount, and an amber refusal must not outlive
          the controls it is about. */}
      {decide.error ? (
        <p className="border-t border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">
          {decideErrorMessage(decide.error.message)}
        </p>
      ) : canDecide &&
        refused &&
        refusalStillTrue(refused, { stale, recruitmentOpen }) ? (
        <p
          role="alert"
          className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          {refused.text}
        </p>
      ) : null}

      {open && (
        <div id={panelId}>
          <ApplicationDetail
            ccaID={ccaID}
            app={app}
            reason={reason}
            setReason={setReason}
            onDecide={submit}
            pending={decide.isPending}
            recruitmentOpen={recruitmentOpen}
            stale={stale}
            onRefused={setRefused}
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
  recruitmentOpen,
  stale,
  onRefused,
}: {
  ccaID: number;
  app: AppRow;
  reason: string;
  setReason: (value: string) => void;
  onDecide: (decision: "accepted" | "rejected") => void;
  pending: boolean;
  recruitmentOpen: boolean;
  stale: boolean;
  onRefused: (refusal: Refusal | null) => void;
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
            <DecisionButtons
              pending={pending}
              onDecide={onDecide}
              recruitmentOpen={recruitmentOpen}
              stale={stale}
              onRefused={onRefused}
            />
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
    return (
      <p className="mt-1 text-sm text-gray-400">No interview notes yet.</p>
    );
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
