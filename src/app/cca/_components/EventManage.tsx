"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, AlertTriangle } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  updatePublicContentInput,
  EVENT_PUBLIC_DESCRIPTION_MAX,
  type EventStatus,
} from "~/lib/schemas/event";
import {
  STATUS_META,
  formatDateRange,
  epochToLocalInput,
  localInputToEpoch,
} from "~/app/events/_lib/format";
import EventProposalFields, {
  facilityPayload,
  type ProposalValue,
} from "./EventProposalFields";
import EventFileField from "./EventFileField";
import EventImageField from "./EventImageField";
import EventGalleryField from "./EventGalleryField";
import EventAnalytics from "./EventAnalytics";
import EventAttendees from "./EventAttendees";

type HeadEvent = RouterOutputs["event"]["getForHead"]["event"];

const FIELD_LABELS: Record<string, string> = {
  title: "event name",
  description: "description",
  startTime: "start time",
  endTime: "end time",
  location: "location",
  proposalUrl: "proposal PDF",
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

/* -------------------------------------------------------------------------- */
/* Proposal editor (draft / rejected)                                          */
/* -------------------------------------------------------------------------- */

function ProposalEditor({ event }: { event: HeadEvent }) {
  const utils = api.useUtils();
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
  const [proposalUrl, setProposalUrl] = useState<string | null>(
    event.proposalUrl,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = api.event.updateDraft.useMutation();
  const submit = api.event.submitForReview.useMutation();

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
      proposalUrl,
    };
  }

  async function invalidate() {
    await Promise.all([
      utils.event.getForHead.invalidate({ eventID: event.eventID }),
      utils.event.listMineForCca.invalidate({ ccaID: event.ccaID }),
    ]);
  }

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync(buildPatch());
      setSaved(true);
      await invalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  async function submitForReview() {
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync(buildPatch());
      await submit.mutateAsync({ eventID: event.eventID });
      await invalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  const busy = update.isPending || submit.isPending;

  return (
    <div className="max-w-3xl space-y-5 rounded-lg border border-gray-200 bg-white p-5">
      {event.status === "rejected" && event.decisionReason && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-medium">JCRC asked for changes</p>
          <p className="mt-0.5">{event.decisionReason}</p>
          <p className="mt-1 text-xs text-red-600">
            Edit below and submit again.
          </p>
        </div>
      )}

      <EventProposalFields
        value={value}
        onChange={(patch) => {
          setValue((v) => ({ ...v, ...patch }));
          setSaved(false);
        }}
        disabled={busy}
      />

      <div className="border-t border-gray-100 pt-4">
        <EventFileField
          eventID={event.eventID}
          value={proposalUrl}
          onChange={(url) => {
            setProposalUrl(url);
            setSaved(false);
          }}
          disabled={busy}
        />
      </div>

      <p className="text-xs text-gray-400">
        Uploads attach immediately but only save with the draft.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4">
        <Button type="button" variant="outline" disabled={busy} onClick={save}>
          {update.isPending && !submit.isPending ? "Saving…" : "Save draft"}
        </Button>
        <Button type="button" disabled={busy} onClick={submitForReview}>
          {submit.isPending ? "Submitting…" : "Submit for review"}
        </Button>
        {saved && (
          <span className="text-sm text-emerald-700">Saved.</span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Public content editor (approved / published)                                */
/* -------------------------------------------------------------------------- */

function PublicEditor({
  event,
  mode,
}: {
  event: HeadEvent;
  mode: "publish" | "edit";
}) {
  const utils = api.useUtils();
  const [bannerUrl, setBannerUrl] = useState<string | null>(event.bannerUrl);
  const [photoUrls, setPhotoUrls] = useState<string[]>(event.photoUrls);
  const [publicDescription, setPublicDescription] = useState(
    event.publicDescription ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = api.event.updatePublicContent.useMutation();
  const publish = api.event.publish.useMutation();

  function buildPayload() {
    return {
      eventID: event.eventID,
      publicDescription: publicDescription.trim(),
      bannerUrl,
      photoUrls,
    };
  }

  async function invalidate() {
    await Promise.all([
      utils.event.getForHead.invalidate({ eventID: event.eventID }),
      utils.event.listMineForCca.invalidate({ ccaID: event.ccaID }),
    ]);
  }

  function validate(): boolean {
    const parsed = updatePublicContentInput.safeParse(buildPayload());
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
      await invalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  async function saveAndPublish() {
    setError(null);
    setSaved(false);
    if (!validate()) return;
    try {
      await update.mutateAsync(buildPayload());
      await publish.mutateAsync({ eventID: event.eventID });
      await invalidate();
    } catch (e) {
      setError(mapError(e));
    }
  }

  const busy = update.isPending || publish.isPending;

  return (
    <div className="max-w-3xl space-y-5">
      <EventImageField
        eventID={event.eventID}
        label="Banner"
        help="The wide hero image residents see first. Required to publish."
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
          What residents read on the event page. This can differ from your JCRC
          proposal.
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
        {mode === "publish" ? (
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={save}>
              Save
            </Button>
            <Button type="button" disabled={busy} onClick={saveAndPublish}>
              {publish.isPending ? "Publishing…" : "Publish event"}
            </Button>
          </>
        ) : (
          <Button type="button" disabled={busy} onClick={save}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        )}
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Cancel button                                                               */
/* -------------------------------------------------------------------------- */

function CancelEventButton({ event }: { event: HeadEvent }) {
  const utils = api.useUtils();
  const [confirming, setConfirming] = useState(false);
  const cancel = api.event.cancelEvent.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.event.getForHead.invalidate({ eventID: event.eventID }),
        utils.event.listMineForCca.invalidate({ ccaID: event.ccaID }),
      ]);
    },
  });

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="text-red-600 hover:bg-red-50 hover:text-red-700"
        onClick={() => setConfirming(true)}
      >
        Cancel event
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2">
      <span className="text-sm text-red-800">Cancel this event?</span>
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
  );
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                                */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Auto-booking status                                                         */
/* -------------------------------------------------------------------------- */

function AutoBookingNotice({ event }: { event: HeadEvent }) {
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

function mapError(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  const incomplete = incompleteMessage(message);
  if (incomplete) return incomplete;
  if (message === "END_BEFORE_START")
    return "The end time must be after the start time.";
  if (message === "FACILITY_UNAVAILABLE")
    return "That facility is already booked for this time. Pick another time or facility before submitting.";
  if (message === "NOT_A_HEAD_OF_THIS_CCA")
    return "You're no longer a head of this CCA.";
  if (message === "EVENTS_DISABLED") return "Events aren't switched on yet.";
  if (message.includes("NOT_APPROVED"))
    return "This event isn't approved yet.";
  return "That didn't save. Try again.";
}

export default function EventManage({
  ccaID,
  eventID,
}: {
  ccaID: number;
  eventID: number;
}) {
  const query = api.event.getForHead.useQuery({ eventID }, { retry: false });
  // Keep the collapsible public editor state across refetches.
  const [editingPublic, setEditingPublic] = useState(false);
  useEffect(() => {
    setEditingPublic(false);
  }, [eventID]);

  if (query.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-200" />;
  }
  if (query.error || !query.data) {
    const msg = query.error?.message;
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
        <p className="text-sm font-medium text-gray-900">
          {msg === "NOT_A_HEAD_OF_THIS_CCA"
            ? "You don’t have access to this event."
            : msg === "NO_SUCH_EVENT"
              ? "This event no longer exists."
              : "This event couldn’t be loaded."}
        </p>
        <Link
          href={`/cca/${ccaID}/events`}
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href={`/cca/${ccaID}/events`}
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

      {/* DRAFT / REJECTED — edit the proposal and submit. */}
      {(status === "draft" || status === "rejected") && (
        <ProposalEditor event={event} />
      )}

      {/* SUBMITTED — waiting on JCRC. */}
      {status === "submitted" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6">
          <p className="text-sm font-medium text-amber-900">
            Submitted — waiting for JCRC review.
          </p>
          <p className="mt-1 text-sm text-amber-700">
            You’ll be able to add a banner, photos and a public description once
            it’s approved.
          </p>
        </div>
      )}

      {/* APPROVED — add public content and publish. */}
      {status === "approved" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            Approved. Add a banner, photos and a public description, then publish
            to put it on the residents’ timeline.
          </div>
          <AutoBookingNotice event={event} />
          <PublicEditor event={event} mode="publish" />
          <div className="border-t border-gray-100 pt-4">
            <CancelEventButton event={event} />
          </div>
        </div>
      )}

      {/* PUBLISHED — monitor + edit. */}
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
            {editingPublic && <PublicEditor event={event} mode="edit" />}
          </section>

          <div className="border-t border-gray-100 pt-4">
            <CancelEventButton event={event} />
          </div>
        </div>
      )}

      {/* CANCELED — read-only. */}
      {status === "canceled" && (
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
      )}
    </div>
  );
}
