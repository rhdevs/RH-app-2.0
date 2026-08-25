"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, CalendarClock, Send, Users } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  applyInput,
  APPLICATION_NOTES_MAX,
  isTerminalStatus,
} from "~/lib/schemas/ccaApplication";
import { statusBadgeClass, residentStatusLabel } from "../_lib/status";
import BookedSlot from "./BookedSlot";
import SlotPicker from "./SlotPicker";
import CancelInterviewButton from "./CancelInterviewButton";
import ImageLightbox from "~/app/_components/ImageLightbox";

/** Friendly copy for the machine-readable error tokens the procedures throw. */
function applyErrorCopy(message: string | undefined): string | null {
  switch (message) {
    case undefined:
      return null;
    case "ALREADY_MEMBER":
      return "You're already a member of this CCA.";
    case "APPLICATION_OPEN":
      return "You already have an application in progress here.";
    case "HEAD_CANNOT_APPLY":
      return "You head this CCA — you can't apply to it.";
    case "MATRIC_REQUIRED":
      return "Add your matriculation number in your profile before applying.";
    case "NO_SUCH_CCA":
      return "This CCA no longer exists.";
    case "CCA_APPLICATIONS_DISABLED":
      return "Applications aren't open right now.";
    case "RECRUITMENT_CLOSED":
      return "CCA recruitment is closed right now, so new applications aren’t being taken.";
    // DISTINCT FROM THE LINE ABOVE, on purpose. RECRUITMENT_UNKNOWN means the
    // server could not READ the recruitment flag — the database was
    // unreachable — not that anybody closed anything. Showing the closed copy
    // here would blame the JCRC for a decision they never made and send the
    // resident off to ask them about it.
    case "RECRUITMENT_UNKNOWN":
      return "We couldn’t check whether recruitment is open. Try again in a moment.";
    default:
      return "That didn't go through. Try again.";
  }
}

export default function CcaApplyPanel({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  const cca = api.ccaApplications.getCca.useQuery({ ccaID }, { retry: false });

  const [notes, setNotes] = useState("");
  const [showApply, setShowApply] = useState(false);
  /**
   * R2-M2. The frozen Apply and Submit buttons are `aria-disabled` rather than
   * natively disabled, so they stay focusable and their explanations stay
   * reachable — which means a click now REACHES the handler and is refused by a
   * guard. A guard that returns silently is its own defect: the resident presses
   * the button and absolutely nothing happens.
   *
   * `aria-describedby` does not cover this. It is announced on FOCUS, not on
   * activation, so a screen-reader user who has already tabbed past the
   * description hears nothing at all when they press. This state is what the
   * press itself says.
   */
  const [refused, setRefused] = useState<{
    /**
     * WHICH BRANCH produced it. `showApply` decides which of two entirely
     * different panels is on screen, and each has its own guard with its own
     * sentence, so an untagged string leaked across the swap: a Submit refusal
     * ("recruitment closed WHILE YOU WERE WRITING") survived Cancel and
     * rendered next to "Apply to join", with no form and no draft in existence.
     * `refused` is cleared only by a successful press, so it persisted there.
     *
     * Same defect, same shape and same fix as `Refusal` on the head's review
     * screen: bind each sentence to the condition that makes it true, and gate
     * on that rather than on a disjunction of everything.
     */
    where: "reveal" | "form";
    text: string;
  } | null>(null);

  const refresh = async () => {
    await Promise.all([
      utils.ccaApplications.getCca.invalidate({ ccaID }),
      utils.ccaApplications.browse.invalidate(),
      utils.ccaApplications.availableSlots.invalidate({ ccaID }),
    ]);
  };

  const apply = api.ccaApplications.submitApplication.useMutation({
    onSuccess: async () => {
      setShowApply(false);
      setNotes("");
      await refresh();
    },
    // H1. WITHOUT THIS, THE PAGE GOES ON INSISTING RECRUITMENT IS OPEN AFTER
    // THE SERVER HAS REFUSED. `getCca` is cached with a 30s staleTime and no
    // refetch interval, so a resident whose cached `recruitmentOpen: true`
    // predates the JCRC's Stop sees an enabled Apply button, clicks it, gets
    // RECRUITMENT_CLOSED — and the button stays enabled, because nothing
    // re-fetched. They can sit there clicking it. The 15s propagation window
    // guarantees this state happens at least once per Stop, which makes it the
    // single most likely moment for the UI to lie about the very thing this
    // feature exists to communicate.
    //
    // ONLY RECRUITMENT_CLOSED, and RECRUITMENT_UNKNOWN is deliberately absent.
    //
    // Round 2 had both, which was self-defeating: RECRUITMENT_UNKNOWN is thrown
    // from exactly one place — the `catch` in services/ccaRecruitment.ts — and
    // it means THE DATABASE COULD NOT BE REACHED. Refetching against a database
    // that is down fails (the query is `retry: false`), and a failed fetch used
    // to replace this whole panel with "This CCA couldn't be loaded",
    // destroying the very "we couldn't check" message the sentinel exists to
    // display. The `!cca.data` guard below now prevents that teardown, but the
    // refetch is still pointless: nothing was decided, so there is nothing new
    // to fetch.
    //
    // RECRUITMENT_CLOSED is the opposite case and does need it: the database is
    // up, `recruitmentOpen` in the cache is merely stale, the refetch succeeds,
    // and the Apply button correctly goes to its disabled state.
    //
    // Nothing else invalidates: ALREADY_MEMBER, APPLICATION_OPEN and the rest
    // are answers about THIS request that a refetch cannot change, and
    // re-fetching on every failure would turn a rejected submit into a request
    // amplifier.
    onError: async (e) => {
      if (e.message === "RECRUITMENT_CLOSED") {
        await refresh();
      }
    },
  });
  const withdraw = api.ccaApplications.withdraw.useMutation({
    onSuccess: refresh,
  });
  const cancelSlot = api.ccaApplications.cancelSlot.useMutation({
    onSuccess: refresh,
  });

  if (cca.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-200" />;
  }
  // `!cca.data`, NOT `cca.error`. react-query KEEPS the last good `data` across
  // a failed BACKGROUND refetch, and testing the error first replaced a working
  // panel — including any half-written application in the form below — with a
  // dead end, on nothing worse than a three-second network hiccup. Same
  // reasoning and same fix as ApplicationsReview and the admin panel.
  if (!cca.data) {
    const disabled = cca.error?.message === "CCA_APPLICATIONS_DISABLED";
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-900">
          {disabled
            ? "CCA applications aren't open right now"
            : "This CCA couldn't be loaded"}
        </p>
        <Link
          href="/ccas"
          className="mt-3 inline-block text-sm font-medium text-emerald-700"
        >
          ← Back to all CCAs
        </Link>
      </div>
    );
  }

  const d = cca.data;
  const app = d.application;
  const openApp = app && !isTerminalStatus(app.status);

  return (
    <div className="space-y-5">
      <Link
        href="/ccas"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" /> All CCAs
      </Link>

      {/* Header card */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {/* Cropped hard here — this container is ~6:1 on a desktop against a
            4:1 upload — so it opens to the full image on click. */}
        {d.bannerUrl && (
          <ImageLightbox
            src={d.bannerUrl}
            title={`${d.ccaName} banner`}
            className="relative block h-32 w-full sm:h-40"
            sizes="(min-width: 1024px) 960px, 100vw"
          />
        )}
        <div className="flex items-start gap-4 p-5">
          {d.logoUrl ? (
            <Image
              src={d.logoUrl}
              alt=""
              width={56}
              height={56}
              className="h-14 w-14 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-lg font-semibold text-emerald-700">
              {d.ccaName.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-gray-900">{d.ccaName}</h1>
            {d.category && (
              <p className="text-sm text-gray-500">{d.category}</p>
            )}
          </div>
          {d.isMember && (
            <span className="inline-flex items-center rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20">
              Member
            </span>
          )}
        </div>
        {d.description && (
          <p className="whitespace-pre-line border-t border-gray-100 px-5 py-4 text-sm text-gray-600">
            {d.description}
          </p>
        )}
      </div>

      {/* Who runs it + how big it is */}
      {(d.heads.length > 0 || d.memberCount > 0) && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Run by
              </p>
              {d.heads.length === 0 ? (
                <p className="mt-1 text-sm text-gray-400">—</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {d.heads.map((h) => (
                    <li
                      key={h.userID}
                      className="flex flex-wrap items-center gap-x-2 text-sm text-gray-800"
                    >
                      <span>{h.displayName ?? h.userID}</span>
                      {h.telegramHandle && (
                        <a
                          href={`https://t.me/${h.telegramHandle}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                        >
                          <Send className="h-3 w-3" />@{h.telegramHandle}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Members
              </p>
              <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-gray-800">
                <Users className="h-4 w-4 text-gray-400" />
                {d.memberCount}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Application state */}
      {d.isMember ? (
        <Card>
          <p className="text-sm text-gray-700">
            You&rsquo;re a member of {d.ccaName}. 🎉
          </p>
        </Card>
      ) : openApp ? (
        <ApplicationInProgress
          ccaID={ccaID}
          app={app}
          openSeatCount={d.openSeatCount}
          onWithdraw={() =>
            withdraw.mutate({ applicationID: app.applicationID })
          }
          withdrawing={withdraw.isPending}
          onCancelSlot={() =>
            cancelSlot.mutate({ applicationID: app.applicationID })
          }
          cancelingSlot={cancelSlot.isPending}
          onChanged={refresh}
          recruitmentOpen={d.recruitmentOpen}
        />
      ) : (
        <Card>
          {app && (
            <div className="mb-3 flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
                  app.status,
                )}`}
              >
                {residentStatusLabel(app.status)}
              </span>
              {app.status === "rejected" && (
                <span className="text-sm text-gray-500">
                  You can apply again below.
                </span>
              )}
            </div>
          )}

          {app?.status === "rejected" && app.decisionReason && (
            <p className="mb-3 text-sm text-gray-600">
              <span className="font-medium text-gray-700">
                Note from the CCA:
              </span>{" "}
              {app.decisionReason}
            </p>
          )}

          {!showApply ? (
            <div className="flex flex-wrap items-center gap-3">
              <p id="apply-why" className="text-sm text-gray-600">
                {!d.recruitmentOpen
                  ? "CCA recruitment is closed right now."
                  : d.canApply
                    ? "Interested? Apply to become a member."
                    : "You can't apply right now."}
              </p>
              {/* DELIBERATE DIVERGENCE from the two cases beside it. When the
                  reason is about YOU — already a member, application already in
                  flight — this branch never runs at all: the isMember and
                  openApp branches above render a different panel that explains
                  itself. "The hall is closed" has no such panel, so an ABSENT
                  button would read as "this CCA doesn't take members", and the
                  resident would go ask a head.

                  `aria-disabled`, NOT the native `disabled` attribute, and that
                  is the point rather than a nicety. A natively disabled button
                  is removed from the tab order and cannot take focus, so a
                  keyboard or screen-reader user never lands on it and never
                  hears the aria-describedby text — the description would be
                  wired to a control nobody can reach, which is the same dead
                  end a `title` attribute produces. aria-disabled keeps the
                  button focusable and announced as unavailable, and the guard
                  in the handler is what actually refuses the click. (The server
                  refuses regardless; this only decides what the resident is
                  told.) */}
              {(d.canApply || !d.recruitmentOpen) && (
                <Button
                  onClick={() => {
                    // EVERY GUARD SPEAKS — see the `refused` state at the top.
                    if (!d.recruitmentOpen) {
                      // R3-L9: deliberately NOT a restatement of the
                      // `#apply-why` line sitting beside it. That line says what
                      // the STATE is; this answers the PRESS, which is the only
                      // thing a screen reader hears on activation and the only
                      // new information a sighted resident gains by clicking.
                      setRefused({
                        where: "reveal",
                        text: "Nothing to apply to yet — the button turns back on when the JCRC reopens recruitment.",
                      });
                      return;
                    }
                    setRefused(null);
                    setShowApply(true);
                  }}
                  // `|| undefined` so the attribute is ABSENT rather than
                  // aria-disabled="false" when the button is live. A literal
                  // "false" alongside no native `disabled` is just noise, and
                  // where the two coexist (the Submit button below) it reads as
                  // a contradiction of the native state.
                  aria-disabled={!d.recruitmentOpen || undefined}
                  aria-describedby="apply-why"
                  className={
                    d.recruitmentOpen
                      ? undefined
                      : "cursor-not-allowed opacity-50 hover:bg-primary"
                  }
                >
                  Apply to join
                </Button>
              )}
              {/* Gated on TWO things, both necessary. The freeze must still be
                  in force — a refusal is true only while its cause is, so the
                  moment recruitment reopens the sentence must stop being shown.
                  And the refusal must have come from THIS branch, or the form's
                  "while you were writing" sentence renders here after a Cancel,
                  next to an Apply button and no form at all. */}
              {refused?.where === "reveal" && !d.recruitmentOpen && (
                <p role="alert" className="text-sm text-amber-800">
                  {refused.text}
                </p>
              )}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // The Submit button is aria-disabled rather than natively
                // disabled while frozen (so it stays focusable and its
                // explanation is announced), which means Enter and a click both
                // still reach this handler. This is the refusal — and it SAYS
                // so, because a silent return leaves the resident pressing
                // Enter into nothing.
                if (!d.recruitmentOpen) {
                  setRefused({
                    where: "form",
                    text: "CCA recruitment closed while you were writing, so this can’t be submitted yet. Your notes are kept.",
                  });
                  return;
                }
                setRefused(null);
                const parsed = applyInput.safeParse({ ccaID, notes });
                if (!parsed.success) return;
                apply.mutate(parsed.data);
              }}
              className="space-y-3"
            >
              <label
                htmlFor="apply-notes"
                className="block text-sm font-medium text-gray-700"
              >
                Anything you&rsquo;d like the CCA to know?{" "}
                <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <textarea
                id="apply-notes"
                value={notes}
                maxLength={APPLICATION_NOTES_MAX}
                rows={5}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Why you're interested, relevant experience, availability…"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <p className="text-right text-xs text-gray-400">
                {notes.length}/{APPLICATION_NOTES_MAX}
              </p>
              {/* The grey "recruitment closed while you were writing" box
                  below states this same fact in a calmer register, so a freeze
                  refusal would otherwise be told twice, in two colours, one
                  line apart. The grey box is the better of the two — it also
                  explains what happens to the draft — so the red line stands
                  down for exactly that one duplicate.

                  RECRUITMENT_CLOSED ONLY, deliberately not RECRUITMENT_UNKNOWN.
                  The two are not interchangeable here: the grey box asserts
                  that recruitment closed, and on the UNKNOWN path nobody closed
                  anything — the database was unreachable. Suppressing the red
                  line there would leave only a sentence that is false. It can
                  co-occur with the grey box (the cached read fails closed while
                  the live read throws), and when it does the more accurate
                  statement is the one that must survive. */}
              {apply.error &&
                !(
                  !d.recruitmentOpen &&
                  apply.error.message === "RECRUITMENT_CLOSED"
                ) && (
                  <p className="text-sm text-red-600">
                    {applyErrorCopy(apply.error.message)}
                  </p>
                )}
              {/* Same two conditions as the collapsed branch: the cause must
                  still hold, and the refusal must belong to THIS branch. */}
              {refused?.where === "form" && !d.recruitmentOpen && (
                <p role="alert" className="text-sm text-amber-800">
                  {refused.text}
                </p>
              )}
              {/* `showApply` is cleared only on success and by Cancel, so a
                  freeze that lands WHILE the resident is typing leaves them
                  inside this form. The <p id="apply-why"> that explains a
                  disabled Apply button lives in the OTHER branch of this
                  ternary and is not in the DOM here at all, so without this
                  line the resident gets a dead grey Submit and no explanation
                  anywhere on the page.

                  Deliberately NOT solved by resetting showApply: that would
                  discard notes they may have spent minutes writing, to punish
                  them for something a JCRC did. Keep the draft, explain the
                  state, and let them submit the moment it reopens. */}
              {!d.recruitmentOpen && (
                <p
                  id="apply-why-form"
                  className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600"
                >
                  CCA recruitment closed while you were writing, so this can’t
                  be submitted right now. Your notes are kept here — you can
                  submit as soon as the JCRC reopens recruitment.
                </p>
              )}
              <div className="flex items-center gap-3">
                {/* `disabled` for the in-flight case (a genuinely transient
                    state where preventing a double submit matters more than
                    focus), `aria-disabled` for the freeze (a state that can
                    persist for days and MUST stay explainable to a screen
                    reader — see the note on the reveal button above). The
                    form's onSubmit carries the matching guard, since an
                    aria-disabled submit button still submits. */}
                <Button
                  type="submit"
                  disabled={apply.isPending}
                  aria-disabled={!d.recruitmentOpen || undefined}
                  aria-describedby={
                    d.recruitmentOpen ? undefined : "apply-why-form"
                  }
                  className={
                    d.recruitmentOpen
                      ? undefined
                      : "cursor-not-allowed opacity-50 hover:bg-primary"
                  }
                >
                  {apply.isPending ? "Submitting…" : "Submit application"}
                </Button>
                <button
                  type="button"
                  onClick={() => setShowApply(false)}
                  className="text-sm font-medium text-gray-500 hover:text-gray-800"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      {children}
    </div>
  );
}

/**
 * /ccas/applications is otherwise reachable only from the avatar dropdown, which
 * nobody finds — so every state that already shows scheduling controls offers it
 * (submitted and scheduled alike), not just the booked one.
 */
function ViewAllApplicationsButton() {
  return (
    <Button variant="outline" asChild>
      <Link href="/ccas/applications">View all applications</Link>
    </Button>
  );
}

type AppShape = RouterOutputs["ccaApplications"]["getCca"]["application"];

/**
 * The panel shown while an application is live (submitted / scheduled).
 *
 * `openSeatCount` is SEATS across every future open slot, not slots — one group
 * slot taking four people is four bookable things. It is only ever tested as
 * "> 0" here (is there anything to book at all?), but it is named for what it
 * counts so a future "3 slots open" caption cannot quietly print the wrong noun.
 */
function ApplicationInProgress({
  ccaID,
  app,
  openSeatCount,
  onWithdraw,
  withdrawing,
  onCancelSlot,
  cancelingSlot,
  onChanged,
  recruitmentOpen,
}: {
  ccaID: number;
  app: NonNullable<AppShape>;
  openSeatCount: number;
  onWithdraw: () => void;
  withdrawing: boolean;
  onCancelSlot: () => void;
  cancelingSlot: boolean;
  onChanged: () => Promise<void>;
  /** Hall-wide freeze; since 2026-08-25 it stops interview booking too. */
  recruitmentOpen: boolean;
}) {
  const scheduled = app.status === "interview_scheduled";
  const [picking, setPicking] = useState(false);
  // Set the moment a booking lands so the panel can say "booked ✓" rather than
  // the neutral "Your interview" — the confirmation the resident just did
  // something, which the status pill alone doesn't give. It is deliberately not
  // persisted: reopening the picker means they're changing their mind, so it
  // clears there and on a plain page load.
  const [justBooked, setJustBooked] = useState(false);

  const openPicker = () => {
    setJustBooked(false);
    setPicking(true);
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
              app.status,
            )}`}
          >
            {residentStatusLabel(app.status)}
          </span>
          {/* The slot panel below carries the scheduled case, with the details a
              bare sentence never had — but only if the slot row came back. It
              can be missing (the pointer outlived the row), and that state used
              to read "Your interview is booked.", so keep saying at least that
              rather than leaving the pill on its own with no sentence at all. */}
          {(!scheduled || !app.slot) && (
            <p className="mt-2 text-sm text-gray-600">
              {/* The freeze is checked FIRST: with booking gated, "book a slot
                  below" is an instruction the resident cannot follow, and
                  "slots soon" implies they will be claimable. Both are false
                  while closed, so neither is shown. */}
              {app.status === "submitted" &&
                (!recruitmentOpen
                  ? "Your application is in. Interview booking is paused while the JCRC has recruitment closed."
                  : openSeatCount > 0
                    ? "Your application is in. Book an interview slot below."
                    : "Your application is in. The CCA will open interview slots soon.")}
              {scheduled && "Your interview is booked."}
              {app.status === "interviewed" &&
                "Your interview's done — the CCA will be in touch with a decision."}
            </p>
          )}
        </div>
        {!scheduled && (
          <button
            onClick={onWithdraw}
            disabled={withdrawing}
            className="shrink-0 text-sm font-medium text-gray-400 hover:text-red-600 disabled:opacity-50"
          >
            {withdrawing ? "Withdrawing…" : "Withdraw"}
          </button>
        )}
      </div>

      {/* What was booked. Only the status pill used to say anything at all, so a
          resident had to go hunting for the date, time and room they had just
          chosen; this is the same renderer My Applications uses. */}
      {scheduled && app.slot && !picking && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/60 p-3">
          <p
            className={`text-[11px] font-medium uppercase tracking-wide ${
              justBooked ? "text-emerald-700" : "text-gray-500"
            }`}
          >
            {justBooked ? "Interview booked ✓" : "Your interview"}
          </p>
          <div className="mt-1.5">
            <BookedSlot slot={app.slot} />
          </div>
        </div>
      )}

      {(app.status === "submitted" || scheduled) && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          {!picking ? (
            <div className="flex flex-wrap items-center gap-3">
              {scheduled ? (
                <>
                  <ViewAllApplicationsButton />
                  <Button variant="outline" onClick={openPicker}>
                    Reschedule interview
                  </Button>
                  <CancelInterviewButton
                    recruitmentOpen={recruitmentOpen}
                    pending={cancelingSlot}
                    onConfirm={onCancelSlot}
                  />
                </>
              ) : openSeatCount > 0 ? (
                <>
                  <Button
                    onClick={openPicker}
                    className="inline-flex items-center gap-1.5"
                  >
                    <CalendarClock className="h-4 w-4" /> Book an interview
                  </Button>
                  <ViewAllApplicationsButton />
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-500">
                    No interview slots are open yet.
                  </p>
                  <ViewAllApplicationsButton />
                </>
              )}
            </div>
          ) : (
            <SlotPicker
              ccaID={ccaID}
              applicationID={app.applicationID}
              currentSlotID={app.interviewSlotID}
              recruitmentOpen={recruitmentOpen}
              // Refresh WITHOUT closing: if the server refuses because the
              // freeze landed mid-session, the picker must stay open and
              // re-render into its frozen state rather than vanish.
              onRefresh={onChanged}
              // Refetch BEFORE closing the picker. `app` is still the pre-book
              // data until getCca comes back, so closing first shows the panel
              // built from it: the OLD time under a green "Interview booked ✓"
              // after a reschedule, or "Book an interview slot below" as if the
              // booking never happened. react-query awaits a mutation's
              // onSuccess, so the picker simply stays on "Booking…" instead.
              onDone={async () => {
                await onChanged();
                setPicking(false);
                setJustBooked(true);
              }}
              onCancel={() => setPicking(false)}
            />
          )}
        </div>
      )}
    </Card>
  );
}
