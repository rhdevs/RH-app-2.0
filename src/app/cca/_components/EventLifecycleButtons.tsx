"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { EVENT_DECISION_REASON_MAX } from "~/lib/schemas/event";
import { formatDateRange } from "~/app/events/_lib/format";
import { eventErrorMessage } from "~/app/events/_lib/eventErrors";

export type OwnedEvent = RouterOutputs["event"]["getForOwner"]["event"];

/**
 * A row created by the "New event" button and never filled in (D-29, D-31).
 *
 * Mirrors the server's reuse filter in `event.create` (D-30) field for field,
 * plus `photoUrls`, which that filter checks in JS for the same reason: there is
 * no tested Prisma+Mongo spelling for `equals: []` on a scalar list. Keep the
 * two in step — if a field is added to one, add it to the other, or the head can
 * be told a row is empty that the server would refuse to reuse.
 *
 * Only ever used to make copy QUIETER. Every string it gates has a variant
 * behind it that is true of every row, so a false negative costs nothing and a
 * false positive would print "there's nothing in it" over somebody's work.
 */
export function isBlankDraft(event: OwnedEvent): boolean {
  return (
    event.status === "draft" &&
    !event.title?.trim() &&
    !event.description?.trim() &&
    !event.publicDescription?.trim() &&
    !event.bannerUrl &&
    event.photoUrls.length === 0 &&
    event.startTime == null &&
    event.endTime == null &&
    !event.location?.trim() &&
    event.facilityID == null &&
    event.capacity == null &&
    event.bookingID == null
  );
}

/**
 * Mirrors the server's NOT_DELETABLE rule: a draft that never went live and
 * holds no room. The server also refuses once anyone has signed up.
 */
export function isDeletableDraft(event: OwnedEvent, signupCount: number) {
  return (
    event.status === "draft" &&
    event.publishedAt == null &&
    event.bookingID == null &&
    signupCount === 0
  );
}

/* -------------------------------------------------------------------------- */
/* Publish (review off)                                                        */
/* -------------------------------------------------------------------------- */

export type EventPreview = {
  title: string;
  startTime: number | null;
  endTime: number | null;
  location: string | null;
  bannerUrl: string | null;
  publicDescription: string;
};

/** What residents will see, drawn from the unsaved form. */
function ResidentPreview({ preview }: { preview: EventPreview }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      {preview.bannerUrl ? (
        <div className="relative aspect-[16/6] w-full bg-gray-100">
          <Image
            src={preview.bannerUrl}
            alt={preview.title || "Event banner"}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, 640px"
            unoptimized
          />
        </div>
      ) : (
        <div className="flex aspect-[16/6] w-full items-center justify-center bg-gray-100 text-xs text-gray-400">
          No banner yet
        </div>
      )}
      <div className="space-y-1 p-4">
        <p className="text-lg font-semibold text-gray-900">
          {preview.title.trim() || "Untitled event"}
        </p>
        <p className="text-sm text-gray-500">
          {formatDateRange(preview.startTime, preview.endTime)}
          {preview.location ? ` · ${preview.location}` : ""}
        </p>
        <p className="whitespace-pre-wrap pt-2 text-sm leading-relaxed text-gray-700">
          {preview.publicDescription.trim() || "No public description yet."}
        </p>
      </div>
    </div>
  );
}

/**
 * The head's own publish. Two steps on purpose: the confirm shows what
 * residents will see and what happens to the room, because publishing is the
 * moment the event and its booking become real.
 *
 * `blockedReason` disables the button and says why (unsaved questions).
 */
export function PublishButton({
  preview,
  facilityName,
  pending,
  disabled,
  blockedReason,
  onConfirm,
}: {
  preview: EventPreview;
  /** The facility that will be booked, or null for a free-text location. */
  facilityName: string | null;
  pending: boolean;
  disabled: boolean;
  blockedReason: string | null;
  onConfirm: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          disabled={disabled || blockedReason != null}
          onClick={() => setConfirming(true)}
        >
          {pending ? "Publishing…" : "Publish"}
        </Button>
        {blockedReason && (
          <span className="text-xs text-amber-700">{blockedReason}</span>
        )}
      </div>
    );
  }
  return (
    <div className="w-full space-y-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <p className="text-sm font-medium text-emerald-900">
        Publish this event?
      </p>
      <p className="text-sm text-emerald-800">
        It goes live on the residents&rsquo; timeline straight away and people
        can sign up.
        {facilityName
          ? ` ${facilityName} is booked for its times; if it's already taken you'll be told what's in the way and nothing is published.`
          : ""}
      </p>
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-emerald-800">
          Preview as residents see it
        </p>
        <ResidentPreview preview={preview} />
      </div>
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
          {pending ? "Publishing…" : "Publish now"}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Register and publish (hall events, review on)                               */
/* -------------------------------------------------------------------------- */

export function RegisterAndPublishButton({
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
      <Button
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
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
 * "this event is not happening" and is terminal.
 *
 * The copy must not say "cancel", must not imply the event is deleted, and must
 * not promise the JCRC is notified — nothing sends a notification.
 */
export function WithdrawButton({
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
      // No toast. Landing on the editable form IS the feedback.
      await onInvalidate();
    } catch (e) {
      setError(eventErrorMessage(e));
    }
  }

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setConfirming(true)}
      >
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
        is lost.
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
 * The banner and photos are not copied, and that is FORCED: isOwnEventBlobUrl
 * requires a URL's path to start with /event/{eventID}/{kind}, so a banner
 * carried over from event 12 fails validation for event 13.
 */
export function DuplicateButton({
  event,
  manageHrefBase,
  backHref,
}: {
  event: OwnedEvent;
  manageHrefBase?: string;
  backHref: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const duplicate = api.event.duplicate.useMutation({
    onSuccess: (res) => {
      router.push(
        manageHrefBase ? `${manageHrefBase}/${res.eventID}` : backHref,
      );
    },
    onError: (e) => setError(eventErrorMessage(e)),
  });

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setConfirming(true)}
      >
        Duplicate
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-gray-200 bg-white p-3">
      <p className="text-sm font-medium text-gray-900">Duplicate this event?</p>
      <p className="text-sm text-gray-600">
        You&rsquo;ll get a new draft with the same details, times and location.
        The banner and photos aren&rsquo;t copied — add them again before it
        goes live.
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
/* Cancel                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Cancel, with a reason once the event is live. The reason is shown to
 * everyone who signed up, on their My events tab, so the copy says so.
 *
 * A FAILED CANCEL MUST SAY SO: without the error state the button simply did
 * nothing and the owner believed the event was cancelled.
 */
export function CancelEventButton({
  event,
  onInvalidate,
}: {
  event: OwnedEvent;
  onInvalidate: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancel = api.event.cancelEvent.useMutation({
    onSuccess: onInvalidate,
    onError: (e) => setError(eventErrorMessage(e)),
  });
  const isLive = event.status === "published";
  const reasonMissing = isLive && !reason.trim();

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
      {/* THREE VARIANTS, because the consequences genuinely differ. A live
          event has signups and a room; an unpublished one has neither; and a
          blank draft has nothing at all. Gated on the row being genuinely
          empty, never merely untitled. */}
      <p className="text-sm text-red-800">
        {isLive
          ? "It comes off the residents’ timeline and the facility booking is released. Everyone who signed up sees it as cancelled, with your reason. This can’t be undone."
          : isBlankDraft(event)
            ? "There’s nothing in it yet, so nothing is lost. It stays on your list as cancelled."
            : "It won’t go ahead. This can’t be undone."}
      </p>
      {isLive && (
        <div className="space-y-1">
          <label
            htmlFor={`cancel-reason-${event.eventID}`}
            className="block text-sm font-medium text-red-900"
          >
            Reason (shown to people who signed up)
          </label>
          <textarea
            id={`cancel-reason-${event.eventID}`}
            value={reason}
            maxLength={EVENT_DECISION_REASON_MAX}
            rows={2}
            disabled={cancel.isPending}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
            placeholder="e.g. The venue flooded, so we're moving to next week."
          />
        </div>
      )}
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
          disabled={cancel.isPending || reasonMissing}
          onClick={() =>
            cancel.mutate({
              eventID: event.eventID,
              reason: reason.trim() || undefined,
            })
          }
        >
          {cancel.isPending ? "Cancelling…" : "Yes, cancel"}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Delete draft                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Hard delete, for a draft that never went live. Cancelling one left a dead
 * row on the list forever; nothing about a never-published draft is worth
 * keeping. The caller renders this only when `isDeletableDraft` holds.
 */
export function DeleteDraftButton({
  event,
  onDeleted,
}: {
  event: OwnedEvent;
  onDeleted: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = api.event.deleteDraft.useMutation({
    onSuccess: onDeleted,
    onError: (e) =>
      setError(eventErrorMessage(e, "That didn't delete. Try again.")),
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
        Delete draft
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
      <p className="text-sm font-medium text-red-900">Delete this draft?</p>
      <p className="text-sm text-red-800">
        It&rsquo;s removed completely, with its images and signup questions.
        This can&rsquo;t be undone.
      </p>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => setConfirming(false)}
        >
          Keep it
        </Button>
        <Button
          type="button"
          size="sm"
          className="bg-red-600 hover:bg-red-700"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ eventID: event.eventID })}
        >
          {remove.isPending ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </div>
  );
}
