"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { disposableErrorMessage } from "~/lib/disposables/errors";
import {
  chooseEvent,
  chooseProposal,
  emptyForm,
  formFromRequest,
  ITEM_LABELS,
  parseCreate,
  parseUpdate,
  type DisposableFormState,
} from "~/lib/disposables/form";
import { DISPOSABLES_HREF } from "~/lib/disposables/links";
import {
  DISPOSABLE_DESCRIPTION_MAX,
  DISPOSABLE_ITEMS,
  DISPOSABLE_ITEM_CAP,
  DISPOSABLE_TITLE_MAX,
} from "~/lib/schemas/disposable";
import { sgtDayKey } from "~/lib/time/sgt";

const fieldClass =
  "w-full rounded-md border border-gray-300 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

/**
 * The request form. With `requestID` it edits that request (the Social
 * director); without, it files a new one for an event, or for a proposal that
 * has no event yet. There is no CCA field: the CCA comes from the event (or the
 * proposal) on the server, and who may file is decided there too. NOT a guard:
 * the procedures check the flag and who may do it.
 *
 * Choosing an event fills the collection date with the day the event starts,
 * in Singapore time; the person can change it. What a request is tagged to
 * cannot be edited (delete it and file it again), so an edit shows the tag but
 * does not offer it. Only the Social director edits. Editing an approved
 * request sends it back to pending and tells the CCA's heads, and the form says
 * so before it is saved.
 */
export default function DisposableForm({
  requestID,
  initialCcaID,
  initialEventID,
}: {
  requestID?: string;
  /** Narrows the event choices to this CCA (the CCA tab's link). */
  initialCcaID?: number;
  /** The event page's link: this event starts chosen. */
  initialEventID?: number;
}) {
  const router = useRouter();
  const enabled = api.disposable.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const editing = requestID !== undefined;
  const today = sgtDayKey(new Date());

  const loaded = api.disposable.get.useQuery(
    { id: requestID ?? "" },
    { retry: false, enabled: on && editing },
  );
  const events = api.disposable.eventChoices.useQuery(undefined, {
    retry: false,
    enabled: on && !editing,
  });
  const proposals = api.disposable.proposalChoices.useQuery(undefined, {
    retry: false,
    enabled: on && !editing,
  });

  const [state, setState] = useState<DisposableFormState>(emptyForm(null));
  const [errors, setErrors] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (loaded.data && !hydrated) {
      setState(formFromRequest(loaded.data));
      setHydrated(true);
    }
  }, [loaded.data, hydrated]);
  useEffect(() => {
    // The event page's link: choose that event once the choices are in, if it
    // is one the person may tag (it may have ended or been canceled since).
    if (editing || seeded || !events.data) return;
    setSeeded(true);
    if (initialEventID === undefined) return;
    const found = events.data.find((e) => e.eventID === initialEventID);
    if (found) {
      setState((s) => chooseEvent(s, found, today));
    } else {
      setNotice(
        "That event cannot take a disposables request. Choose another event.",
      );
    }
  }, [editing, seeded, events.data, initialEventID, today]);

  const fail = (e: { message: string }) =>
    setErrors([disposableErrorMessage(e.message)]);
  const create = api.disposable.create.useMutation({
    onSuccess: () => router.push(DISPOSABLES_HREF),
    onError: fail,
  });
  const update = api.disposable.update.useMutation({
    onSuccess: () => router.push(DISPOSABLES_HREF),
    onError: fail,
  });

  if (enabled.isLoading) {
    return (
      <p className="text-sm text-gray-500 dark:text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500 dark:text-muted-foreground">
        Disposables requests are not switched on yet.
      </p>
    );
  }
  if (editing && loaded.isLoading) {
    return (
      <p className="text-sm text-gray-500 dark:text-muted-foreground">
        Loading request…
      </p>
    );
  }
  if (editing && loaded.data && !loaded.data.can.edit) {
    return (
      <p
        role="alert"
        className="text-sm text-gray-600 dark:text-muted-foreground"
      >
        Only the Social director can edit a request.
      </p>
    );
  }
  if (editing && (loaded.isError || !loaded.data)) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        That request could not be found.
      </p>
    );
  }
  if (!editing && (events.isLoading || proposals.isLoading)) {
    return (
      <p className="text-sm text-gray-500 dark:text-muted-foreground">
        Loading…
      </p>
    );
  }
  const eventList = (events.data ?? []).filter(
    (e) => initialCcaID === undefined || e.ccaID === initialCcaID,
  );
  const proposalList = (proposals.data ?? []).filter(
    (p) => initialCcaID === undefined || p.ccaID === initialCcaID,
  );
  const freeProposals = proposalList.filter(
    (p) => !p.taken && p.eventID === null,
  );
  if (
    !editing &&
    (events.isError || proposals.isError) &&
    eventList.length === 0 &&
    freeProposals.length === 0
  ) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        Could not load what you can ask for. Try again shortly.
      </p>
    );
  }
  if (!editing && eventList.length === 0 && freeProposals.length === 0) {
    return (
      <p
        role="alert"
        className="text-sm text-gray-600 dark:text-muted-foreground"
      >
        There is nothing to ask for disposables for. A CCA head can ask for an
        event of their CCA that has not ended or been canceled, or for one of
        its proposals. The JCRC and admins can ask for hall-wide events.
      </p>
    );
  }

  const set = (patch: Partial<DisposableFormState>) =>
    setState((s) => ({ ...s, ...patch }));
  const backToPending = editing && loaded.data?.status === "approved";
  const busy = create.isPending || update.isPending;
  const tag = loaded.data?.event ?? null;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) {
      const parsed = parseUpdate(state, requestID, loaded.data!.version, today);
      if (!parsed.ok) return setErrors(parsed.errors);
      setErrors([]);
      update.mutate(parsed.input);
      return;
    }
    const parsed = parseCreate(state, today);
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors([]);
    create.mutate(parsed.input);
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground">
        {editing ? "Edit disposables request" : "New disposables request"}
      </h2>

      {editing ? (
        <p className="text-sm text-gray-700 dark:text-foreground">
          {tag
            ? `For the event ${tag.title ?? "(untitled)"}${
                tag.state === "gone" ? " (no longer exists)" : ""
              }.`
            : loaded.data?.proposalID
              ? "For a proposal. It has no event yet."
              : ""}{" "}
          <span className="text-xs text-gray-500 dark:text-muted-foreground">
            What a request is for cannot be changed. Delete it and file it again
            to change that.
          </span>
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium text-gray-700 dark:text-foreground">
            Event
            <select
              className={`${fieldClass} mt-1`}
              value={state.eventID ?? ""}
              onChange={(e) => {
                setNotice(null);
                const chosen =
                  eventList.find(
                    (ev) => ev.eventID === Number(e.target.value),
                  ) ?? null;
                setState((s) => chooseEvent(s, chosen, today));
              }}
            >
              <option value="">No event chosen</option>
              {eventList.map((ev) => (
                <option key={ev.eventID} value={ev.eventID}>
                  {ev.title} ({ev.ccaName ?? "Hall-wide"})
                </option>
              ))}
            </select>
          </label>
          {notice && (
            <p
              role="status"
              className="text-xs text-amber-700 dark:text-amber-300"
            >
              {notice}
            </p>
          )}

          {proposalList.length > 0 && (
            <label className="block text-sm font-medium text-gray-700 dark:text-foreground">
              Or a proposal that has no event yet
              <select
                className={`${fieldClass} mt-1`}
                value={state.proposalID}
                onChange={(e) =>
                  setState((s) => chooseProposal(s, e.target.value))
                }
              >
                <option value="">No proposal</option>
                {proposalList.map((p) => (
                  <option
                    key={p.id}
                    value={p.id}
                    disabled={p.taken || p.eventID !== null}
                  >
                    {p.title} ({p.ccaName ?? "CCA"})
                    {p.taken
                      ? " (already has a request)"
                      : p.eventID !== null
                        ? " (has an event: choose the event)"
                        : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      <label className="block text-sm font-medium text-gray-700 dark:text-foreground">
        What is it for?
        <input
          className={`${fieldClass} mt-1`}
          value={state.title}
          maxLength={DISPOSABLE_TITLE_MAX}
          onChange={(e) => set({ title: e.target.value })}
        />
      </label>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-gray-700 dark:text-foreground">
          How many of each
        </legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {DISPOSABLE_ITEMS.map((item) => (
            <label
              key={item}
              className="text-xs text-gray-600 dark:text-muted-foreground"
            >
              {ITEM_LABELS[item]}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={DISPOSABLE_ITEM_CAP}
                className={`${fieldClass} mt-1`}
                value={state.quantities[item]}
                onChange={(e) =>
                  set({
                    quantities: {
                      ...state.quantities,
                      [item]: e.target.value,
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-foreground">
          Collection date
          <input
            type="date"
            min={today}
            className={`${fieldClass} mt-1`}
            value={state.collectionDay}
            onChange={(e) =>
              set({ collectionDay: e.target.value, collectionDayEdited: true })
            }
          />
        </label>
        <label className="block text-sm font-medium text-gray-700 dark:text-foreground">
          Collection time
          <input
            type="time"
            className={`${fieldClass} mt-1`}
            value={state.collectionTime}
            onChange={(e) => set({ collectionTime: e.target.value })}
          />
        </label>
      </div>

      <label className="block text-sm font-medium text-gray-700 dark:text-foreground">
        Notes (optional)
        <textarea
          className={`${fieldClass} mt-1`}
          rows={3}
          maxLength={DISPOSABLE_DESCRIPTION_MAX}
          value={state.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>

      {backToPending && (
        <p role="note" className="text-sm text-amber-700 dark:text-amber-300">
          This request is approved. Saving a change sends it back to pending and
          tells the CCA&apos;s heads.
        </p>
      )}
      {errors.length > 0 && (
        <ul
          role="alert"
          className="space-y-1 text-sm text-red-600 dark:text-red-400"
        >
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : editing ? "Save changes" : "Send request"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={DISPOSABLES_HREF}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
