"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { updateEventInput } from "~/lib/schemas/event";
import { localInputToEpoch } from "~/app/events/_lib/format";
import {
  eventErrorMessage,
  eventIssueMessage,
} from "~/app/events/_lib/eventErrors";
import EventDetailsFields, {
  facilityPayload,
  proposalFromEvent,
  type ProposalValue,
} from "./EventDetailsFields";
import EventPublicFields, { type PublicFieldsValue } from "./EventPublicFields";
import type { OwnedEvent } from "./EventLifecycleButtons";

/**
 * Editing a LIVE event, keeping its signups.
 *
 * Time, location and capacity can change; the server moves the facility
 * booking with them (refusing with what is in the way on a clash), refuses a
 * capacity below the signups already in, and marks the event so residents who
 * signed up see "time or place changed". The name and internal description
 * render read-only and are not sent.
 */
export default function EventLiveEditor({
  event,
  onInvalidate,
}: {
  event: OwnedEvent;
  onInvalidate: () => Promise<void>;
}) {
  const [details, setDetails] = useState<ProposalValue>(() =>
    proposalFromEvent(event),
  );
  const [pub, setPub] = useState<PublicFieldsValue>({
    bannerUrl: event.bannerUrl,
    photoUrls: event.photoUrls,
    publicDescription: event.publicDescription ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = api.event.update.useMutation();

  function buildPatch() {
    const fp = facilityPayload(details);
    return {
      eventID: event.eventID,
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

  async function save() {
    setError(null);
    setSaved(false);
    const patch = buildPatch();
    const parsed = updateEventInput.safeParse(patch);
    if (!parsed.success) {
      setError(eventIssueMessage(parsed.error.issues[0] ?? {}));
      return;
    }
    try {
      await update.mutateAsync(patch);
      setSaved(true);
      await onInvalidate();
    } catch (e) {
      setError(eventErrorMessage(e));
    }
  }

  const busy = update.isPending;

  return (
    <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-5">
      <EventDetailsFields
        value={details}
        onChange={(patch) => {
          setDetails((v) => ({ ...v, ...patch }));
          setSaved(false);
        }}
        disabled={busy}
        lockIdentity
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

      <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Changing the time or place tells everyone who signed up, on their My
        events tab. The facility booking moves with the event.
      </p>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </div>
  );
}
