"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { createEventInput } from "~/lib/schemas/event";
import { localInputToEpoch } from "~/app/events/_lib/format";
import EventDetailsFields, {
  EMPTY_PROPOSAL,
  facilityPayload,
  type ProposalValue,
} from "./EventDetailsFields";

/**
 * New-event form. Creating the row and routing straight to the manage page is
 * ONE interaction: the primary button says "Continue", not "Save draft", and
 * the word "draft" appears nowhere on this screen.
 *
 * That is deliberate. `draft` survives only as a TECHNICAL staging state — a row
 * has to exist before a banner can be uploaded, because the blob path is
 * event/{eventID}/banner — and a head must never be parked in it thinking they
 * have finished. The banner and the public description are collected on the next
 * screen and are BOTH required to submit.
 *
 * `ccaID` null means a HALL-WIDE event, authored by the JCRC at
 * /admin/events/hall/new. The key is OMITTED from the payload in that case; the
 * server's create branches on its absence and requires `manageHallEvents`.
 * `backHref` / `manageHref` are passed in rather than derived, because a hall
 * event has no /cca/{id} route to derive them from.
 */
export default function EventCreateForm({
  ccaID,
  backHref,
  manageHref,
}: {
  ccaID: number | null;
  backHref: string;
  manageHref: (eventID: number) => string;
}) {
  const router = useRouter();
  const [value, setValue] = useState<ProposalValue>(EMPTY_PROPOSAL);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const create = api.event.create.useMutation({
    onSuccess: (res) => {
      router.push(manageHref(res.eventID));
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError(null);

    // Only send non-empty fields — the schema treats them as optional at create
    // time, and empty strings would fail the min-length rules.
    const start = localInputToEpoch(value.startLocal);
    const end = localInputToEpoch(value.endLocal);
    const fp = facilityPayload(value);
    const payload = {
      // Omitted entirely for a hall event. The schema accepts absent OR null;
      // the SERVER is what turns that into a stored `ccaID: null`.
      ...(ccaID == null ? {} : { ccaID }),
      title: value.title.trim() || undefined,
      description: value.description.trim() || undefined,
      startTime: start ?? undefined,
      endTime: end ?? undefined,
      location: fp.location,
      facilityID: fp.facilityID,
      capacity: value.capacity.trim() ? Number(value.capacity) : undefined,
    };
    const parsed = createEventInput.safeParse(payload);
    if (!parsed.success) {
      setFieldError(
        parsed.error.issues[0]?.message ?? "Please check the fields.",
      );
      return;
    }
    create.mutate(parsed.data);
  }

  const serverError = create.error
    ? create.error.message === "NO_SUCH_CCA"
      ? "This CCA no longer exists."
      : create.error.message === "NOT_A_HEAD_OF_THIS_CCA"
        ? "You're no longer a head of this CCA."
        : create.error.message === "CAPABILITY_REQUIRED:manageHallEvents"
          ? "You can't manage hall events."
          : create.error.message === "EVENTS_DISABLED"
            ? "Events aren't switched on yet."
            : "That didn't save. Try again."
    : null;

  return (
    <form
      onSubmit={submit}
      className="max-w-3xl space-y-5 rounded-lg border border-gray-200 bg-white p-5"
    >
      <EventDetailsFields
        value={value}
        onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
        disabled={create.isPending}
        isHall={ccaID == null}
      />

      {/* HALL-AWARE, for the same reason as EventsListPanel's empty state: a
          hall event (ccaID null) never goes for review, so "submit it for
          review" describes something that will not happen on this surface. */}
      <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Fill in what you know now. You&rsquo;ll add the banner and the
        description residents see on the next screen, then{" "}
        {ccaID == null ? "register and publish it" : "submit it for review"}.
      </p>

      {fieldError && <p className="text-sm text-red-600">{fieldError}</p>}
      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Saving…" : "Continue"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={create.isPending}
          onClick={() => router.push(backHref)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
