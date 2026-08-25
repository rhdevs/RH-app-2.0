"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, AlertTriangle } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  updateEventInput,
  editScope,
  EVENT_PUBLIC_DESCRIPTION_MAX,
  type EventStatus,
} from "~/lib/schemas/event";
import {
  STATUS_META,
  formatDateRange,
  epochToLocalInput,
  localInputToEpoch,
} from "~/app/events/_lib/format";
import EventDetailsFields, {
  facilityPayload,
  type ProposalValue,
} from "./EventDetailsFields";
import EventImageField from "./EventImageField";
import EventGalleryField from "./EventGalleryField";
import EventAnalytics from "./EventAnalytics";
import EventAttendees from "./EventAttendees";

type OwnedEvent = RouterOutputs["event"]["getForOwner"]["event"];

const FIELD_LABELS: Record<string, string> = {
  title: "event name",
  description: "description",
  startTime: "start time",
  endTime: "end time",
  location: "location",
  banner: "banner image",
  publicDescription: "public description",
};

function incompleteMessage(message: string): string | null {
  if (!message.startsWith("INCOMPLETE:")) return null;
  const missing = message
    .slice("INCOMPLETE:".length)
    .split(",")
    .map((f) => FIELD_LABELS[f] ?? f);
  return `Please add: ${missing.join(", ")}.`;
}

function mapError(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  const incomplete = incompleteMessage(message);
  if (incomplete) return incomplete;
  if (message === "END_BEFORE_START")
    return "The end time must be after the start time.";
  if (message === "NOT_A_HEAD_OF_THIS_CCA")
    return "You're no longer a head of this CCA.";
  if (message === "EVENTS_DISABLED") return "Events aren't switched on yet.";
  if (message === "CAPABILITY_REQUIRED:manageHallEvents")
    return "You can't manage hall events.";
  if (message === "CAPABILITY_REQUIRED:reviewEvents")
    return "You can't review events.";
  // Deliberately ACTIONABLE. "This can't be edited any more" would be a lie for
  // a submitted event, which CAN be edited — after a withdraw. The same code is
  // thrown for declined and canceled, where withdrawal is impossible, but those
  // two never render an editor at all (see the terminal panels below), so the
  // string is unreachable there in practice.
  if (message === "EVENT_LOCKED")
    return "This event is in the review queue. Withdraw it first to make changes.";
  if (message === "NOT_WITHDRAWABLE")
    return "This event isn't in the review queue. Reload the page.";
  if (message === "NOT_UNDER_REVIEW")
    return "Someone has already decided this event. Reload the page.";
  // cancelEvent refuses an already-declined or already-canceled event. It is a
  // race the owner loses whenever a second tab, or the JCRC's own
  // reviewerCancel, got there first — and retrying can NEVER succeed, because
  // both refusing states are terminal. The generic fallback would tell them to
  // try again forever.
  if (message === "NOT_CANCELABLE")
    return "This event is already declined or cancelled, so there's nothing to cancel. Reload the page.";
  if (message === "NO_SUCH_EVENT") return "This event no longer exists.";
  return "That didn't save. Try again.";
}

/* -------------------------------------------------------------------------- */
/* Details editor (draft / changes_requested)                                  */
/* -------------------------------------------------------------------------- */

/**
 * ONE editor collecting EVERYTHING — details, banner, gallery and the public
 * description — because the JCRC now reviews a finished event. There is no
 * "add the public bits after approval" stage, and `submitForReview` requires
 * the banner and the public description just as it requires a title.
 *
 * Mounted ONLY for editScope === "all" (draft / changes_requested). Leaving it
 * mounted for `submitted` would give the head a form the server refuses every
 * save from, with EVENT_LOCKED.
 */
function DetailsEditor({
  event,
  isHallEvent,
  onInvalidate,
}: {
  event: OwnedEvent;
  isHallEvent: boolean;
  onInvalidate: () => Promise<void>;
}) {
  const [value, setValue] = useState<ProposalValue>({
    title: event.title ?? "",
    description: event.description ?? "",
    startLocal: epochToLocalInput(event.startTime),
    endLocal: epochToLocalInput(event.endTime),
    // Facility → its id; free-text location → "other"; nothing → unset.
    facilitySelection:
      event.facilityID != null
        ? String(event.facilityID)
        : event.location
          ? "other"
          : "",
    location: event.facilityID != null ? "" : (event.location ?? ""),
    capacity: event.capacity != null ? String(event.capacity) : "",
  });
  const [bannerUrl, setBannerUrl] = useState<string | null>(event.bannerUrl);
  const [photoUrls, setPhotoUrls] = useState<string[]>(event.photoUrls);
  const [publicDescription, setPublicDescription] = useState(
    event.publicDescription ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = api.event.update.useMutation();
  const submit = api.event.submitForReview.useMutation();
  const decide = api.event.decide.useMutation();

  function buildPatch() {
    const fp = facilityPayload(value);
    return {
      eventID: event.eventID,
      title: value.title.trim() || undefined,
      description: value.description.trim() || undefined,
      startTime: localInputToEpoch(value.startLocal) ?? undefined,
      endTime: value.endLocal ? localInputToEpoch(value.endLocal) : null,
      location: fp.location,
      facilityID: fp.facilityID,
      capacity: value.capacity.trim() ? Number(value.capacity) : null,
      publicDescription: publicDescription.trim(),
      bannerUrl,
      photoUrls,
    };
  }

  /** Mirror the server's own rules client-side — same schema, one definition. */
  function validate(): boolean {
    const parsed = updateEventInput.safeParse(buildPatch());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.message === "NOT_A_VALID_EVENT_BLOB_URL"
          ? "An image doesn't belong to this event. Re-upload it."
          : (issue?.message ?? "Please check the fields."),
      );
      return false;
    }
    return true;
  }

  async function save() {
    setError(null);
    setSaved(false);
    if (!validate()) return;
    try {
      await update.mutateAsync(buildPatch());
      setSaved(true);
      await onInvalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  async function submitForReview() {
    setError(null);
    setSaved(false);
    if (!validate()) return;
    try {
      await update.mutateAsync(buildPatch());
      await submit.mutateAsync({ eventID: event.eventID });
      await onInvalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  /**
   * HALL EVENTS ONLY. Two client calls, back to back, and deliberately NOT one
   * fused server procedure: a fused one would have to re-implement `decide`'s
   * live getUserRoles + reviewEvents re-check, which is the guard that catches a
   * role revoked mid-session — a second copy of the one check that must not have
   * a second copy. Calling the real procedures means the real guards run.
   *
   * ON A STEP-2 FAILURE THE EVENT STAYS AT `submitted`. It is NOT rolled back to
   * draft: `submitted` is a legitimate state any reviewer (including this actor,
   * on retry) can resolve, whereas an automatic rollback would mean a transient
   * network error silently un-submits a real submission.
   *
   * Both calls audit — `event.submit` then `event.approve`, same actor, seconds
   * apart. That pairing IS the record of a self-approval and is meant to be
   * legible; it is not a bug to be collapsed.
   */
  async function registerAndPublish() {
    setError(null);
    setSaved(false);
    if (!validate()) return;
    try {
      await update.mutateAsync(buildPatch());
      await submit.mutateAsync({ eventID: event.eventID });
    } catch (e) {
      // Step 1 failed — the event is still a draft. The ordinary INCOMPLETE:
      // path, with no special casing.
      setError(mapError(e));
      await onInvalidate();
      return;
    }
    try {
      await decide.mutateAsync({ eventID: event.eventID, decision: "approve" });
    } catch (e) {
      // The event is now `submitted`, and the copy must say so rather than
      // implying nothing happened.
      setError(
        `Your event was registered but couldn't be published: ${mapError(e)} ` +
          `It's sitting in the review queue now. Try publishing again, or leave it ` +
          `for another JCRC member to approve.`,
      );
    }
    await onInvalidate();
  }

  const busy = update.isPending || submit.isPending || decide.isPending;

  return (
    <div className="max-w-3xl space-y-5 rounded-lg border border-gray-200 bg-white p-5">
      <EventDetailsFields
        value={value}
        onChange={(patch) => {
          setValue((v) => ({ ...v, ...patch }));
          setSaved(false);
        }}
        disabled={busy}
      />

      <div className="space-y-5 border-t border-gray-100 pt-5">
        <EventImageField
          eventID={event.eventID}
          label="Banner"
          help="The wide image residents see first. Required before you can submit."
          value={bannerUrl}
          onChange={(url) => {
            setBannerUrl(url);
            setSaved(false);
          }}
          disabled={busy}
        />

        <EventGalleryField
          eventID={event.eventID}
          value={photoUrls}
          onChange={(urls) => {
            setPhotoUrls(urls);
            setSaved(false);
          }}
          disabled={busy}
        />

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700">
            Public description
          </label>
          <p className="text-xs text-gray-500">
            What residents read on the event page. Required before you can
            submit.
          </p>
          <textarea
            value={publicDescription}
            maxLength={EVENT_PUBLIC_DESCRIPTION_MAX}
            rows={6}
            disabled={busy}
            onChange={(e) => {
              setPublicDescription(e.target.value);
              setSaved(false);
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            placeholder="Tell residents what to expect…"
          />
          <p className="text-right text-xs text-gray-500">
            {publicDescription.length}/{EVENT_PUBLIC_DESCRIPTION_MAX}
          </p>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        Uploads attach immediately but only save with the event.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4">
        <Button type="button" variant="outline" disabled={busy} onClick={save}>
          {update.isPending && !submit.isPending && !decide.isPending
            ? "Saving…"
            : "Save and finish later"}
        </Button>
        {/* A hall event NEVER shows both: "Register and publish" REPLACES
            "Submit for review" on that surface. The gate is for clarity — the
            real one is that `decide` sits on roleManagerProcedure and refuses a
            CCA head regardless of what the client renders. */}
        {isHallEvent ? (
          <RegisterAndPublishButton
            location={event.facilityID != null ? event.location : null}
            pending={submit.isPending || decide.isPending}
            disabled={busy}
            onConfirm={registerAndPublish}
          />
        ) : (
          <Button type="button" disabled={busy} onClick={submitForReview}>
            {submit.isPending ? "Submitting…" : "Submit for review"}
          </Button>
        )}
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Public content editor (published only)                                      */
/* -------------------------------------------------------------------------- */

/**
 * The narrowed editor for a LIVE event. editScope("published") is "public", so
 * the server accepts only these three fields and silently ignores the rest —
 * this component simply does not offer the others.
 */
function PublicEditor({
  event,
  onInvalidate,
}: {
  event: OwnedEvent;
  onInvalidate: () => Promise<void>;
}) {
  const [bannerUrl, setBannerUrl] = useState<string | null>(event.bannerUrl);
  const [photoUrls, setPhotoUrls] = useState<string[]>(event.photoUrls);
  const [publicDescription, setPublicDescription] = useState(
    event.publicDescription ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = api.event.update.useMutation();

  function buildPayload() {
    return {
      eventID: event.eventID,
      publicDescription: publicDescription.trim(),
      bannerUrl,
      photoUrls,
    };
  }

  function validate(): boolean {
    const parsed = updateEventInput.safeParse(buildPayload());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.message === "NOT_A_VALID_EVENT_BLOB_URL"
          ? "An image doesn't belong to this event. Re-upload it."
          : (issue?.message ?? "Please check the fields."),
      );
      return false;
    }
    return true;
  }

  async function save() {
    setError(null);
    setSaved(false);
    if (!validate()) return;
    try {
      await update.mutateAsync(buildPayload());
      setSaved(true);
      await onInvalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  const busy = update.isPending;

  return (
    <div className="max-w-3xl space-y-5">
      <EventImageField
        eventID={event.eventID}
        label="Banner"
        help="The wide image residents see first. Required before you can submit."
        value={bannerUrl}
        onChange={(url) => {
          setBannerUrl(url);
          setSaved(false);
        }}
        disabled={busy}
      />

      <EventGalleryField
        eventID={event.eventID}
        value={photoUrls}
        onChange={(urls) => {
          setPhotoUrls(urls);
          setSaved(false);
        }}
        disabled={busy}
      />

      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-gray-700">
          Public description
        </label>
        <p className="text-xs text-gray-500">
          What residents read on the event page. Required before you can submit.
        </p>
        <textarea
          value={publicDescription}
          maxLength={EVENT_PUBLIC_DESCRIPTION_MAX}
          rows={6}
          disabled={busy}
          onChange={(e) => {
            setPublicDescription(e.target.value);
            setSaved(false);
          }}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          placeholder="Tell residents what to expect…"
        />
        <p className="text-right text-xs text-gray-500">
          {publicDescription.length}/{EVENT_PUBLIC_DESCRIPTION_MAX}
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy} onClick={save}>
          {update.isPending ? "Saving…" : "Save changes"}
        </Button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Register and publish (hall events only)                                     */
/* -------------------------------------------------------------------------- */

function RegisterAndPublishButton({
  location,
  pending,
  disabled,
  onConfirm,
}: {
  /** The facility name, or null when the location is free text. */
  location: string | null;
  pending: boolean;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button type="button" disabled={disabled} onClick={() => setConfirming(true)}>
        {pending ? "Publishing…" : "Register and publish"}
      </Button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <p className="text-sm font-medium text-emerald-900">
        Register and publish this event?
      </p>
      <p className="text-sm text-emerald-800">
        It goes live on the residents&rsquo; timeline straight away.
        You&rsquo;re approving it yourself, and both steps are recorded in the
        audit log.
        {location ? ` ${location} is booked for its times.` : ""}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Not yet
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            void onConfirm();
          }}
        >
          {pending ? "Publishing…" : "Register and publish"}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Withdraw                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `submitted` -> `draft`. Rendered ONLY for a submitted event.
 *
 * NOT the same act as cancelling, and the two must never be one button. This is
 * "I am still doing this event, stop reviewing it for a moment"; cancelling is
 * "this event is not happening" and is terminal. Offering one control for both
 * is how a head loses an event they meant to edit.
 *
 * The copy must not say "cancel", must not imply the event is deleted, and must
 * not promise the JCRC is notified — nothing sends a notification. "Nothing is
 * lost" is accurate: withdraw clears only the decision fields, which are null on
 * a submitted event anyway, and touches no content field.
 */
function WithdrawButton({
  event,
  onInvalidate,
}: {
  event: OwnedEvent;
  onInvalidate: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withdraw = api.event.withdraw.useMutation();

  async function run() {
    setError(null);
    try {
      await withdraw.mutateAsync({ eventID: event.eventID });
      setConfirming(false);
      // No toast. Landing on the editable form with the badge reading
      // "Not submitted" IS the feedback.
      await onInvalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  if (!confirming) {
    return (
      <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
        Withdraw
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-white p-3">
      <p className="text-sm font-medium text-gray-900">
        Withdraw this event from review?
      </p>
      <p className="text-sm text-gray-600">
        It comes out of the JCRC queue and goes back to being editable. Nothing
        is lost — submit it again when you&rsquo;re ready.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={withdraw.isPending}
          onClick={() => setConfirming(false)}
        >
          Keep it in the queue
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={withdraw.isPending}
          onClick={() => void run()}
        >
          {withdraw.isPending ? "Withdrawing…" : "Withdraw"}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Duplicate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A recurring event is N duplicates — there is no series model.
 *
 * The confirmation says the banner and photos are not copied because they
 * genuinely are not, and that is FORCED rather than chosen: isOwnEventBlobUrl
 * requires a URL's path to start with /event/{eventID}/{kind}, so a banner
 * carried over from event 12 fails validation for event 13 — from the very
 * check that is the security boundary.
 */
function DuplicateButton({
  event,
  manageHref,
  backHref,
}: {
  event: OwnedEvent;
  manageHref?: (eventID: number) => string;
  backHref: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const duplicate = api.event.duplicate.useMutation({
    onSuccess: (res) => {
      // Straight to the copy's own manage page — the same interaction shape as
      // create. No toast.
      router.push(manageHref ? manageHref(res.eventID) : backHref);
    },
    onError: (e) => setError(mapError(e)),
  });

  if (!confirming) {
    return (
      <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
        Duplicate
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-gray-200 bg-white p-3">
      <p className="text-sm font-medium text-gray-900">Duplicate this event?</p>
      <p className="text-sm text-gray-600">
        You&rsquo;ll get a new unsubmitted copy with the same details, times and
        location. The banner and photos aren&rsquo;t copied — add them again
        before you submit.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={duplicate.isPending}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={duplicate.isPending}
          onClick={() => duplicate.mutate({ eventID: event.eventID })}
        >
          Duplicate
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Cancel button                                                               */
/* -------------------------------------------------------------------------- */

function CancelEventButton({
  event,
  onInvalidate,
}: {
  event: OwnedEvent;
  onInvalidate: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  // A FAILED CANCEL MUST SAY SO. This mutation can genuinely fail —
  // NOT_CANCELABLE when the row is already terminal, NOT_A_HEAD_OF_THIS_CCA
  // after a handover, EVENTS_DISABLED after a kill-switch flip — and without
  // this state the button simply did nothing at all: no message, no spinner
  // change, no navigation. A destructive control that fails silently reads as a
  // broken app, and the owner is left believing the event is cancelled.
  const [error, setError] = useState<string | null>(null);
  const cancel = api.event.cancelEvent.useMutation({
    onSuccess: onInvalidate,
    onError: (e) => setError(mapError(e)),
  });

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="text-red-600 hover:bg-red-50 hover:text-red-700"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        Cancel event
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
      <p className="text-sm font-medium text-red-900">Cancel this event?</p>
      {/* TWO VARIANTS, because the consequences genuinely differ. A published
          event has signups and a room held for it; an unpublished one has
          neither, and promising a resident's place was lost when nobody had one
          is the copy-drift class this repo has paid for four times. */}
      <p className="text-sm text-red-800">
        {event.status === "published"
          ? "It comes off the residents’ timeline, everyone who signed up loses their place, and the facility booking is released. This can’t be undone."
          : "It won’t go ahead and can’t be resubmitted. This can’t be undone."}
      </p>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => setConfirming(false)}
        >
          No
        </Button>
        <Button
          type="button"
          size="sm"
          className="bg-red-600 hover:bg-red-700"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate({ eventID: event.eventID })}
        >
          {cancel.isPending ? "Cancelling…" : "Yes, cancel"}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Auto-booking status                                                         */
/* -------------------------------------------------------------------------- */

function AutoBookingNotice({ event }: { event: OwnedEvent }) {
  // Only relevant when a facility (not free-text) was chosen.
  if (event.facilityID == null) return null;
  if (event.bookingID != null) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <span className="font-medium">Facility booked automatically</span>
        {event.location ? ` — ${event.location}` : ""}. It appears in the
        bookings calendar under your name.
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
 * a number means a CCA event at /cca/[ccaID]/events/[eventID]. `backHref` and
 * `manageHref` are passed in rather than derived, because a hall event has no
 * /cca/{id} route to derive them from.
 *
 * WHICH SURFACE A STATUS GETS IS DRIVEN BY `editScope`, IMPORTED — not by a hand
 * re-derivation of the same branching. That duplication is what let the client
 * and the server disagree before, and the import is what kills it.
 */
export default function EventManage({
  ccaID,
  eventID,
  backHref,
  manageHref,
}: {
  ccaID: number | null;
  eventID: number;
  backHref: string;
  manageHref?: (eventID: number) => string;
}) {
  const utils = api.useUtils();
  const query = api.event.getForOwner.useQuery({ eventID }, { retry: false });
  // Keep the collapsible public editor state across refetches.
  const [editingPublic, setEditingPublic] = useState(false);
  useEffect(() => {
    setEditingPublic(false);
  }, [eventID]);

  async function invalidate() {
    await Promise.all([
      utils.event.getForOwner.invalidate({ eventID }),
      utils.event.listForOwner.invalidate({ ccaID }),
    ]);
  }

  if (query.isPending) {
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

  const event = query.data.event;
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
                Edit below and submit again.
              </p>
            </div>
          )}
          <DetailsEditor
            event={event}
            isHallEvent={isHallEvent}
            onInvalidate={invalidate}
          />
          <div className="border-t border-gray-100 pt-4">
            <CancelEventButton event={event} onInvalidate={invalidate} />
          </div>
        </div>
      )}

      {/* SUBMITTED — READ-ONLY. The panel REPLACES the editor; it does not sit
          above one. Leaving DetailsEditor mounted here would give the head a
          form the server refuses every save from, with EVENT_LOCKED. */}
      {status === "submitted" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6">
            <p className="text-sm font-medium text-amber-900">
              Submitted — waiting for JCRC review.
            </p>
            <p className="mt-1 text-sm text-amber-700">
              You can&rsquo;t edit it while it&rsquo;s in the queue. Need to
              change something? Withdraw it, edit, and submit again.
            </p>
          </div>
          <WithdrawButton event={event} onInvalidate={invalidate} />
          <div className="border-t border-gray-100 pt-4">
            <CancelEventButton event={event} onInvalidate={invalidate} />
          </div>
        </div>
      )}

      {/* PUBLISHED — monitor + narrowed edit. */}
      {status === "published" && (
        <div className="space-y-8">
          <AutoBookingNotice event={event} />
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              Signups
            </h3>
            <EventAnalytics eventID={event.eventID} />
          </section>

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
                onClick={() => setEditingPublic((v) => !v)}
              >
                {editingPublic ? "Close" : "Edit details"}
              </Button>
            </div>
            <p className="mb-3 text-sm text-gray-500">
              This event is live. You can still change the banner, photos and
              public description — the date, location and capacity are fixed
              now.
            </p>
            {editingPublic && (
              <PublicEditor event={event} onInvalidate={invalidate} />
            )}
          </section>

          <div className="flex flex-wrap items-start gap-3 border-t border-gray-100 pt-4">
            <DuplicateButton
              event={event}
              manageHref={manageHref}
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
            manageHref={manageHref}
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
              <p className="mt-1 text-sm text-gray-500">
                It no longer appears on the residents’ timeline.
              </p>
            </div>
          </div>
          <DuplicateButton
            event={event}
            manageHref={manageHref}
            backHref={backHref}
          />
        </div>
      )}
    </div>
  );
}
