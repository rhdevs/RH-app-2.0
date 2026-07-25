"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { createDraftInput } from "~/lib/schemas/event";
import { localInputToEpoch } from "~/app/events/_lib/format";
import EventProposalFields, {
  EMPTY_PROPOSAL,
  facilityPayload,
  type ProposalValue,
} from "./EventProposalFields";

/**
 * New-event form. Saving creates a DRAFT and redirects to the manage page,
 * where the proposal PDF (which needs the event's id in its blob path) is
 * attached and the event is submitted for review. Fields are optional at draft
 * time; completeness is enforced at submit.
 */
export default function EventCreateForm({ ccaID }: { ccaID: number }) {
  const router = useRouter();
  const [value, setValue] = useState<ProposalValue>(EMPTY_PROPOSAL);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const create = api.event.createDraft.useMutation({
    onSuccess: (res) => {
      router.push(`/cca/${ccaID}/events/${res.eventID}`);
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError(null);

    // Only send non-empty fields — the schema treats them as optional at draft
    // time, and empty strings would fail the min-length rules.
    const start = localInputToEpoch(value.startLocal);
    const end = localInputToEpoch(value.endLocal);
    const fp = facilityPayload(value);
    const payload = {
      ccaID,
      title: value.title.trim() || undefined,
      description: value.description.trim() || undefined,
      startTime: start ?? undefined,
      endTime: end ?? undefined,
      location: fp.location,
      facilityID: fp.facilityID,
      capacity: value.capacity.trim() ? Number(value.capacity) : undefined,
    };
    const parsed = createDraftInput.safeParse(payload);
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
        : create.error.message === "EVENTS_DISABLED"
          ? "Events aren't switched on yet."
          : "That didn't save. Try again."
    : null;

  return (
    <form
      onSubmit={submit}
      className="max-w-3xl space-y-5 rounded-lg border border-gray-200 bg-white p-5"
    >
      <EventProposalFields
        value={value}
        onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
        disabled={create.isPending}
      />

      <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Save the draft first — then you can attach the proposal PDF and submit it
        for review.
      </p>

      {fieldError && <p className="text-sm text-red-600">{fieldError}</p>}
      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Saving…" : "Save draft"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={create.isPending}
          onClick={() => router.push(`/cca/${ccaID}/events`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
