"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, ChevronRight } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { isTerminalStatus } from "~/lib/schemas/ccaApplication";
import { Button } from "~/components/ui/button";
import { statusBadgeClass, residentStatusLabel } from "../_lib/status";
import BookedSlot from "./BookedSlot";
import SlotPicker from "./SlotPicker";
import CancelInterviewButton from "./CancelInterviewButton";

type MyApp =
  RouterOutputs["ccaApplications"]["myApplications"]["applications"][number];

export default function MyApplicationsList() {
  const q = api.ccaApplications.myApplications.useQuery(undefined, {
    retry: false,
  });

  if (q.isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg bg-gray-200" />
        ))}
      </div>
    );
  }

  // `!q.data`, NOT `q.error`. react-query KEEPS the last good `data` across a
  // failed BACKGROUND refetch, so testing the error first threw away a working
  // page on a transient blip — and this page invalidates after every successful
  // cancelSlot (MyApplicationRow.refresh), so a failed refetch there replaced
  // the whole list, open SlotPicker and all, with "These couldn't be loaded"
  // even though the cancellation had succeeded.
  //
  // Same reasoning and same fix as CcaApplyPanel, ApplicationsReview and the
  // admin panel. The compensating staleness signal is the strip below.
  if (!q.data) {
    if (q.error?.message === "CCA_APPLICATIONS_DISABLED") {
      return (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
          CCA applications aren&rsquo;t open right now.
        </p>
      );
    }
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800">
        These couldn&rsquo;t be loaded. Reload the page.
      </p>
    );
  }

  const isEmpty = q.data.applications.length === 0;
  // R2-M5. NOT `!isEmpty`. `myApplications` applies no status filter — it
  // returns accepted, rejected and withdrawn rows too, and MyApplicationRow
  // renders them with their decision reason. So a resident whose only
  // application was REJECTED has a non-empty list and nothing in flight, and
  // the reassuring variant — the one about applications staying where they are
  // and already-booked interviews still going ahead — is false in both clauses
  // while suppressing the one sentence they actually need: that they cannot
  // start a new application. That is precisely the resident CcaApplyPanel
  // invites to "apply again". (The quoted wording this comment used to carry
  // was replaced when booking was gated; the reasoning is unchanged.)
  const hasLiveApplications = q.data.applications.some(
    (a) => !isTerminalStatus(a.status),
  );

  return (
    <>
      <RecruitmentClosedNotice
        open={q.data.recruitmentOpen}
        hasApplications={hasLiveApplications}
      />
      <div className="space-y-4">
        {/* The compensating signal for the `!q.data` reorder above: keeping a
            working page on a failed background refetch is right, but going
            silent about it is not. */}
        {q.error && (
          <p
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            Couldn’t refresh just now, so this may be out of date.{" "}
            <button
              type="button"
              onClick={() => void q.refetch()}
              className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              Try again
            </button>
          </p>
        )}
        {isEmpty ? (
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-900">
              No applications yet
            </p>
            <Link
              href="/ccas"
              className="mt-2 inline-block text-sm font-medium text-emerald-700"
            >
              Browse CCAs →
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {q.data.applications.map((a) => (
              <MyApplicationRow
                key={a.applicationID}
                app={a}
                recruitmentOpen={q.data.recruitmentOpen}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The freeze notice for this page.
 *
 * IT RENDERS ON THE EMPTY PATH TOO, and that is the point of pulling it out
 * into a component. It used to sit below an early return for "no applications
 * yet", so the one resident who most needs telling — somebody with nothing in
 * flight, who came here to check on an application they were about to make —
 * was shown "No applications yet / Browse CCAs →" and nothing else, and sent
 * off to a grid where the Apply button is dead. The server was deliberately
 * restructured so `recruitmentOpen` rides the empty early return
 * (routers/ccaApplications.ts, myApplications); dropping it on the client made
 * that restructure pointless on the exact branch it was written for.
 *
 * TWO COPY VARIANTS, because the honest sentence differs. With applications
 * still IN FLIGHT the news is reassurance — nothing you have is affected. With
 * none live, the reassurance would be false, so it says what is actually true:
 * you cannot start one yet. Note the caller passes "has LIVE applications", not
 * "has rows": a resident whose only application was rejected has a row on
 * screen and nothing in flight, and telling them their applications are
 * unaffected would be wrong twice over.
 *
 * There is no APPLY button anywhere on this page — the buttons are Reschedule,
 * Cancel interview and Book an interview — so this banner never has to explain
 * a disabled Apply control the way the browse grid and the apply panel do.
 *
 * It does NOT follow that nothing here is frozen. Since 2026-08-25 the freeze
 * gates bookSlot, and both Reschedule and Book an interview open the SlotPicker,
 * which routes there — so a disabled control does now render on this very page,
 * inside the picker, which explains itself. Only Cancel interview still works,
 * and it carries its own confirmation while frozen because cancelling is
 * one-way then (see CancelInterviewButton). An earlier version of this comment
 * asserted the opposite — "all three keep working during a freeze (interviews
 * are not frozen)" — which was the pre-reversal D11 stated as fact.
 *
 * THE LIVE REGION IS THE ALWAYS-MOUNTED OUTER DIV, with the conditional inside
 * it. A live region inserted into the DOM together with its own content is not
 * reliably announced; the region has to already exist for the change to
 * register as one. On first load this is therefore silent, which is correct —
 * the banner is part of the initial page and reading order covers it — and it
 * speaks only when a background refetch flips the flag under a resident who is
 * already on the page.
 */
function RecruitmentClosedNotice({
  open,
  hasApplications,
}: {
  open: boolean;
  /** LIVE (non-terminal) applications, not merely rows on screen. */
  hasApplications: boolean;
}) {
  // Rendered OUTSIDE the caller's `space-y-4` container. As a direct child of a
  // `space-y-*` parent this always-mounted wrapper would occupy a sibling slot
  // and push everything after it down by 16px even while empty — a phantom gap
  // in the normal, recruitment-open case. Outside it, an empty wrapper costs
  // nothing and the banner carries its own margin.
  return (
    <div role="status" aria-live="polite">
      {!open && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-sm font-medium text-gray-900">
            CCA recruitment is closed
          </p>
          <p className="mt-1 text-sm text-gray-600">
            {hasApplications
              ? "Your applications stay exactly where they are and interviews you’ve already booked still go ahead. Until the JCRC reopens recruitment you can’t book or reschedule an interview, and heads can’t accept new members."
              : "You can still browse every CCA, but until the JCRC reopens recruitment new applications aren’t being taken and interviews can’t be booked."}
          </p>
        </div>
      )}
    </div>
  );
}

function MyApplicationRow({
  app,
  recruitmentOpen,
}: {
  app: MyApp;
  /** Hall-wide freeze; since 2026-08-25 it stops interview booking too. */
  recruitmentOpen: boolean;
}) {
  const utils = api.useUtils();
  const [picking, setPicking] = useState(false);

  const scheduled = app.status === "interview_scheduled";
  const canBook = app.status === "submitted";

  const refresh = async () => {
    await Promise.all([
      utils.ccaApplications.myApplications.invalidate(),
      utils.ccaApplications.availableSlots.invalidate({ ccaID: app.ccaID }),
    ]);
  };

  const cancelSlot = api.ccaApplications.cancelSlot.useMutation({
    onSuccess: refresh,
  });

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/ccas/${app.ccaID}`}
          className="group inline-flex items-center gap-1 font-medium text-gray-900 hover:text-emerald-700"
        >
          {app.ccaName ?? `CCA #${app.ccaID}`}
          <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-emerald-600" />
        </Link>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
            app.status,
          )}`}
        >
          {residentStatusLabel(app.status)}
        </span>
      </div>

      {/* Booked interview */}
      {scheduled && app.slot && (
        <div className="mt-2">
          <BookedSlot slot={app.slot} />
        </div>
      )}

      {app.status === "rejected" && app.decisionReason && (
        <p className="mt-2 text-sm text-gray-600">{app.decisionReason}</p>
      )}

      {/* Interview scheduling controls — the point of this view: change your
          timeslot without leaving the page. */}
      {(scheduled || canBook) && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          {picking ? (
            <SlotPicker
              ccaID={app.ccaID}
              applicationID={app.applicationID}
              currentSlotID={app.interviewSlotID}
              recruitmentOpen={recruitmentOpen}
              // Refresh WITHOUT closing — see the CCA detail panel's copy of
              // this comment: a picker that vanishes on a freeze refusal takes
              // the explanation with it.
              onRefresh={refresh}
              // Refetch BEFORE closing the picker, same ordering as the CCA
              // detail panel: `app` is still the pre-book row until
              // myApplications comes back, so closing first shows the OLD time
              // under an unchanged "Interview booked" pill after a reschedule.
              // react-query awaits a mutation's onSuccess, so the picker holds
              // on "Booking…" through the refetch instead.
              onDone={async () => {
                await refresh();
                setPicking(false);
              }}
              onCancel={() => setPicking(false)}
            />
          ) : scheduled ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => setPicking(true)}>
                Reschedule
              </Button>
              <CancelInterviewButton
                recruitmentOpen={recruitmentOpen}
                pending={cancelSlot.isPending}
                onConfirm={() =>
                  cancelSlot.mutate({ applicationID: app.applicationID })
                }
              />
            </div>
          ) : (
            <Button
              onClick={() => setPicking(true)}
              className="inline-flex items-center gap-1.5"
            >
              <CalendarClock className="h-4 w-4" /> Book an interview
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
