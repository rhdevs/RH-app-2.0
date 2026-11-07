"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, AlertTriangle } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  updateEventInput,
  editScope,
  type EventStatus,
} from "~/lib/schemas/event";
import {
  STATUS_META,
  formatDateRange,
  localInputToEpoch,
} from "~/app/events/_lib/format";
import {
  eventErrorMessage,
  eventIssueMessage,
} from "~/app/events/_lib/eventErrors";
import EventDetailsFields, {
  facilityPayload,
  isFacilitySelected,
  proposalFromEvent,
  type ProposalValue,
} from "./EventDetailsFields";
import EventPublicFields, { type PublicFieldsValue } from "./EventPublicFields";
import EventLiveEditor from "./EventLiveEditor";
import {
  CancelEventButton,
  DeleteDraftButton,
  DuplicateButton,
  PublishButton,
  RegisterAndPublishButton,
  WithdrawButton,
  isDeletableDraft,
  type OwnedEvent,
} from "./EventLifecycleButtons";
import EventAnalytics from "./EventAnalytics";
import EventAttendees from "./EventAttendees";
import EventQuestionBuilder from "./EventQuestionBuilder";
import EventDoorSection from "./EventDoorSection";
import EventAttendanceStats from "./EventAttendanceStats";

const UNSAVED_QUESTIONS = "Save or discard your signup question changes first.";

/* -------------------------------------------------------------------------- */
/* Details editor (draft / changes_requested)                                  */
/* -------------------------------------------------------------------------- */

/**
 * ONE editor collecting EVERYTHING — details, banner, gallery, public
 * description and signup questions — because whatever goes live (published by
 * the head, or approved by JCRC while review is on) is the finished event.
 *
 * Mounted ONLY for editScope === "all" (draft / changes_requested).
 *
 * The primary action depends on `events.review.required`:
 *  - OFF (the default): Publish, for CCA and hall events alike.
 *  - ON: Submit for review; a hall event keeps "Register and publish", which
 *    submits then approves through the real procedures so the real guards run.
 */
function DetailsEditor({
  event,
  reviewRequired,
  onInvalidate,
  onHandoff,
}: {
  event: OwnedEvent;
  reviewRequired: boolean;
  onInvalidate: () => Promise<void>;
  /**
   * Report a failure that leaves the event in a status THIS COMPONENT DOES NOT
   * RENDER — only registerAndPublish's step 2, which lands it at `submitted`.
   * The refetch that follows unmounts this editor, so local error state would
   * die with it; the parent renders the message on the panel the head lands on.
   */
  onHandoff: (message: string) => void;
}) {
  const isHallEvent = event.ccaID == null;
  const [details, setDetails] = useState<ProposalValue>(() =>
    proposalFromEvent(event),
  );
  const [pub, setPub] = useState<PublicFieldsValue>({
    bannerUrl: event.bannerUrl,
    photoUrls: event.photoUrls,
    publicDescription: event.publicDescription ?? "",
  });
  const [questionsDirty, setQuestionsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = api.event.update.useMutation();
  const submit = api.event.submitForReview.useMutation();
  const decide = api.event.decide.useMutation();
  const publish = api.event.publish.useMutation();
  // Same cached query EventDetailsFields reads, for the facility's name.
  const facilities = api.bookings.getAllFacilities.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

  function buildPatch() {
    const fp = facilityPayload(details);
    return {
      eventID: event.eventID,
      title: details.title.trim() || undefined,
      description: details.description.trim() || undefined,
      startTime: localInputToEpoch(details.startLocal) ?? undefined,
      endTime: details.endLocal ? localInputToEpoch(details.endLocal) : null,
      location: fp.location,
      facilityID: fp.facilityID,
      capacity: details.capacity.trim() ? Number(details.capacity) : null,
      publicDescription: pub.publicDescription.trim(),
      bannerUrl: pub.bannerUrl,
      photoUrls: pub.photoUrls,
    };
  }

  /** Mirror the server's own rules client-side — same schema, one definition. */
  function validate(): boolean {
    const parsed = updateEventInput.safeParse(buildPatch());
    if (!parsed.success) {
      setError(eventIssueMessage(parsed.error.issues[0] ?? {}));
      return false;
    }
    return true;
  }

  /** Save, then run `next`. Errors land beside the buttons. */
  async function saveThen(next?: () => Promise<unknown>) {
    setError(null);
    setSaved(false);
    if (!validate()) return;
    try {
      await update.mutateAsync(buildPatch());
      if (next) await next();
      else setSaved(true);
      await onInvalidate();
    } catch (e) {
      setError(eventErrorMessage(e));
      // A save that landed before the failing step is real; show it.
      await onInvalidate();
    }
  }

  /**
   * HALL EVENTS, REVIEW ON. Two client calls, deliberately NOT one fused
   * server procedure: a fused one would re-implement `decide`'s live
   * reviewEvents re-check. On a step-2 failure the event stays `submitted`
   * rather than being rolled back, and the parent explains.
   */
  async function registerAndPublish() {
    setError(null);
    setSaved(false);
    if (!validate()) return;
    try {
      await update.mutateAsync(buildPatch());
      await submit.mutateAsync({ eventID: event.eventID });
    } catch (e) {
      setError(eventErrorMessage(e));
      await onInvalidate();
      return;
    }
    try {
      await decide.mutateAsync({ eventID: event.eventID, decision: "approve" });
    } catch (e) {
      onHandoff(
        `Your event was registered but couldn't be published: ${eventErrorMessage(e)} ` +
          `It's sitting in the review queue now — open it in the queue to ` +
          `approve it, or leave it for another JCRC member.`,
      );
    }
    await onInvalidate();
  }

  const busy =
    update.isPending || submit.isPending || decide.isPending || publish.isPending;
  const facilityName = isFacilitySelected(details)
    ? (facilities.data?.find(
        (f) => f.facilityID === Number(details.facilitySelection),
      )?.facilityName ?? "The facility")
    : null;

  return (
    <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-5">
      <EventDetailsFields
        value={details}
        onChange={(patch) => {
          setDetails((v) => ({ ...v, ...patch }));
          setSaved(false);
        }}
        disabled={busy}
      />

      <div className="border-t border-gray-100 pt-5">
        <EventPublicFields
          eventID={event.eventID}
          value={pub}
          onChange={(patch) => {
            setPub((v) => ({ ...v, ...patch }));
            setSaved(false);
          }}
          disabled={busy}
        />
      </div>

      <p className="text-xs text-gray-400">
        Uploads attach immediately but only save with the event.
      </p>

      <EventQuestionBuilder
        eventID={event.eventID}
        onDirtyChange={setQuestionsDirty}
      />

      {/* THE CONTRACT SENTENCE: the last thing the head reads before the
          primary action, saying what that action actually does. */}
      <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
        {!reviewRequired || isHallEvent ? (
          <>
            This is the whole event. Publishing puts it on the residents&rsquo;
            timeline straight away.
          </>
        ) : (
          <>
            This is everything JCRC sees. When they approve it, it goes live on
            the residents&rsquo; timeline straight away &mdash; there&rsquo;s
            nothing more for you to do.
          </>
        )}
      </p>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-start gap-3 border-t border-gray-100 pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void saveThen()}
        >
          {update.isPending && !submit.isPending && !publish.isPending
            ? "Saving…"
            : "Save and finish later"}
        </Button>
        {!reviewRequired ? (
          <PublishButton
            preview={{
              title: details.title,
              startTime: localInputToEpoch(details.startLocal),
              endTime: details.endLocal
                ? localInputToEpoch(details.endLocal)
                : null,
              location:
                details.facilitySelection === "other"
                  ? details.location
                  : facilityName,
              bannerUrl: pub.bannerUrl,
              publicDescription: pub.publicDescription,
            }}
            facilityName={facilityName}
            pending={publish.isPending}
            disabled={busy}
            blockedReason={questionsDirty ? UNSAVED_QUESTIONS : null}
            onConfirm={() =>
              saveThen(() => publish.mutateAsync({ eventID: event.eventID }))
            }
          />
        ) : isHallEvent ? (
          <RegisterAndPublishButton
            location={facilityName}
            pending={submit.isPending || decide.isPending}
            disabled={busy || questionsDirty}
            onConfirm={registerAndPublish}
          />
        ) : (
          <Button
            type="button"
            disabled={busy || questionsDirty}
            onClick={() =>
              void saveThen(() =>
                submit.mutateAsync({ eventID: event.eventID }),
              )
            }
          >
            {submit.isPending ? "Submitting…" : "Submit for review"}
          </Button>
        )}
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Auto-booking status                                                         */
/* -------------------------------------------------------------------------- */

function AutoBookingNotice({ event }: { event: OwnedEvent }) {
  if (event.facilityID == null) return null;
  if (event.bookingID != null) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <span className="font-medium">Facility booked automatically</span>
        {event.location ? ` — ${event.location}` : ""}. It appears in the
        bookings calendar and moves with the event if you change its time or
        place.
      </div>
    );
  }
  if (event.autoBookFailed) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span className="font-medium">Facility not booked.</span>{" "}
        {event.location ?? "The facility"} was already booked for this time, so
        no automatic booking was made — please book it manually.
      </div>
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Manage one event, on either surface.
 *
 * `ccaID` null means a HALL-WIDE event authored at /admin/events/hall/[eventID];
 * a number means a CCA event at /cca/[ccaID]/events/[eventID].
 *
 * `manageHrefBase` IS A STRING, NOT A BUILDER FUNCTION, AND MUST STAY ONE.
 * React refuses to serialise a function across the server/client boundary and
 * the throw happens at RENDER — tsc, ESLint and `next build` all pass while
 * every authoring route 500s. It shipped once in Phase 1. Every manage URL is
 * `base/{eventID}`, so a base string carries everything a closure would.
 *
 * WHICH SURFACE A STATUS GETS IS DRIVEN BY `editScope`, IMPORTED, so the client
 * and the server cannot disagree.
 */
export default function EventManage({
  ccaID,
  eventID,
  backHref,
  manageHrefBase,
}: {
  ccaID: number | null;
  eventID: number;
  backHref: string;
  manageHrefBase?: string;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const query = api.event.getForOwner.useQuery({ eventID }, { retry: false });
  const settings = api.event.settings.useQuery(undefined, {
    staleTime: 60_000,
  });
  const [editingLive, setEditingLive] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  useEffect(() => {
    setEditingLive(false);
    setHandoffError(null);
  }, [eventID]);

  // Every list an event appears on, so no screen shows it in its old state.
  const invalidate = useCallback(async () => {
    await Promise.all([
      utils.event.getForOwner.invalidate({ eventID }),
      utils.event.listForOwner.invalidate({ ccaID }),
      utils.event.listAll.invalidate(),
      utils.event.listPublished.invalidate(),
      utils.event.listMySignups.invalidate(),
      utils.event.getQuestionsForOwner.invalidate({ eventID }),
    ]);
  }, [utils, eventID, ccaID]);

  if (query.isPending || settings.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-200" />;
  }
  if (query.error || !query.data) {
    const msg = query.error?.message;
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
        <p className="text-sm font-medium text-gray-900">
          {msg === "NOT_A_HEAD_OF_THIS_CCA" ||
          msg === "CAPABILITY_REQUIRED:manageHallEvents"
            ? "You don’t have access to this event."
            : msg === "NO_SUCH_EVENT"
              ? "This event no longer exists."
              : "This event couldn’t be loaded."}
        </p>
        <Link
          href={backHref}
          className="mt-2 inline-block text-sm text-emerald-700 hover:underline"
        >
          ← Back to events
        </Link>
      </div>
    );
  }

  const { event, signupCount } = query.data;
  // An unreadable flag is treated as off, matching the server.
  const reviewRequired = settings.data?.reviewRequired ?? false;
  const status: EventStatus = event.status;
  const meta = STATUS_META[status];
  const scope = editScope(status);
  const isHallEvent = event.ccaID == null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href={backHref}
            className="text-sm text-emerald-700 hover:underline"
          >
            ← All events
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h2 className="text-xl font-semibold text-gray-900">
              {event.title?.trim() || "Untitled event"}
            </h2>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
            >
              {meta.label}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-gray-500">
            {formatDateRange(event.startTime, event.endTime)}
            {event.location ? ` · ${event.location}` : ""}
          </p>
        </div>
        {status === "published" && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/events/${event.eventID}`} target="_blank">
              <ExternalLink className="mr-1.5 h-4 w-4" />
              View public page
            </Link>
          </Button>
        )}
      </div>

      {/* EDITABLE — draft / changes_requested. */}
      {scope === "all" && (
        <div className="space-y-4">
          {status === "changes_requested" && (
            <div className="rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900">
              <p className="font-medium">JCRC asked for changes</p>
              {event.decisionReason && (
                <p className="mt-0.5">{event.decisionReason}</p>
              )}
              <p className="mt-1 text-xs text-orange-700">
                Edit below and {reviewRequired ? "submit" : "publish"} again.
              </p>
            </div>
          )}
          <DetailsEditor
            event={event}
            reviewRequired={reviewRequired}
            onInvalidate={invalidate}
            onHandoff={setHandoffError}
          />
          <div className="flex flex-wrap items-start gap-3 border-t border-gray-100 pt-4">
            {isDeletableDraft(event, signupCount) ? (
              <DeleteDraftButton
                event={event}
                onDeleted={async () => {
                  await invalidate();
                  router.push(backHref);
                }}
              />
            ) : (
              <CancelEventButton event={event} onInvalidate={invalidate} />
            )}
          </div>
        </div>
      )}

      {/* THE DOOR SECTION, MOUNTED ONCE AND OUTSIDE BOTH BRANCHES, so the
          editable and live surfaces cannot drift. */}
      {(scope === "all" || status === "published") && (
        <EventDoorSection
          eventID={event.eventID}
          ccaID={event.ccaID}
          status={status}
          startTime={event.startTime}
          endTime={event.endTime}
          attendanceOpensAt={event.attendanceOpensAt}
          attendanceClosesAt={event.attendanceClosesAt}
          scannerUserIDs={event.scannerUserIDs}
          onSaved={invalidate}
        />
      )}

      {/* SUBMITTED — READ-ONLY. The panel REPLACES the editor. */}
      {status === "submitted" && (
        <div className="space-y-4">
          {handoffError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm text-red-800">{handoffError}</p>
              {isHallEvent && (
                <Link
                  href={`/admin/events/${event.eventID}`}
                  className="mt-1 inline-block text-sm font-medium text-red-900 underline"
                >
                  Open it in the review queue
                </Link>
              )}
            </div>
          )}
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6">
            <p className="text-sm font-medium text-amber-900">
              Submitted — waiting for JCRC review.
            </p>
            <p className="mt-1 text-sm text-amber-700">
              {reviewRequired
                ? "You can’t edit it while it’s in the queue. Need to change something? Withdraw it, edit, and submit again."
                : "JCRC review has since been switched off. Withdraw it to edit and publish it yourself."}
            </p>
          </div>
          <WithdrawButton event={event} onInvalidate={invalidate} />
          <div className="border-t border-gray-100 pt-4">
            <CancelEventButton event={event} onInvalidate={invalidate} />
          </div>
        </div>
      )}

      {/* PUBLISHED — monitor + live edit. */}
      {status === "published" && (
        <div className="space-y-8">
          <AutoBookingNotice event={event} />

          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              Signups
            </h3>
            <EventAnalytics eventID={event.eventID} />
          </section>

          {/* NO WRAPPER: renders nothing with attendance off, and an empty
              <section> would open a blank gap in this stack. */}
          <EventAttendanceStats eventID={event.eventID} />

          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              Attendees
            </h3>
            <EventAttendees eventID={event.eventID} />
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Event details
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingLive((v) => !v)}
              >
                {editingLive ? "Close" : "Edit details"}
              </Button>
            </div>
            <p className="mb-3 text-sm text-gray-500">
              This event is live. You can change the time, place, capacity,
              banner, photos and public description; the name and internal
              description stay as published.
            </p>
            {editingLive && (
              <EventLiveEditor event={event} onInvalidate={invalidate} />
            )}
          </section>

          {/* Locks itself once anyone signs up (or while review is on). */}
          <EventQuestionBuilder eventID={event.eventID} />

          <div className="flex flex-wrap items-start gap-3 border-t border-gray-100 pt-4">
            <DuplicateButton
              event={event}
              manageHrefBase={manageHrefBase}
              backHref={backHref}
            />
            <CancelEventButton event={event} onInvalidate={invalidate} />
          </div>
        </div>
      )}

      {/* DECLINED — terminal, no editor, no resubmit. */}
      {status === "declined" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-6">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
            <div>
              <p className="text-sm font-medium text-red-900">
                JCRC declined this event.
              </p>
              {event.decisionReason && (
                <p className="mt-1 text-sm text-red-800">
                  {event.decisionReason}
                </p>
              )}
              <p className="mt-1 text-sm text-red-700">
                Declined events can&rsquo;t be resubmitted. You can duplicate it
                and start a fresh one.
              </p>
            </div>
          </div>
          <DuplicateButton
            event={event}
            manageHrefBase={manageHrefBase}
            backHref={backHref}
          />
        </div>
      )}

      {/* CANCELED — terminal, read-only. */}
      {status === "canceled" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-6">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
            <div>
              <p className="text-sm font-medium text-gray-900">
                This event was cancelled.
              </p>
              {event.decisionReason && (
                <p className="mt-1 text-sm text-gray-700">
                  Reason: {event.decisionReason}
                </p>
              )}
              <p className="mt-1 text-sm text-gray-500">
                It&rsquo;s off the residents&rsquo; timeline. People who signed
                up still see it, marked cancelled, in their own events.
              </p>
            </div>
          </div>
          <DuplicateButton
            event={event}
            manageHrefBase={manageHrefBase}
            backHref={backHref}
          />
        </div>
      )}
    </div>
  );
}
