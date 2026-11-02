"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { disposableErrorMessage } from "~/lib/disposables/errors";
import {
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
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

/**
 * The request form. With `requestID` it edits that request (the Social
 * director); without, it files a new one for a CCA the
 * person heads. NOT a guard: the procedures check the flag and who may do it.
 * Only the Social director edits (heads create and read). Editing an approved
 * request sends it back to pending and tells the CCA's heads, and the form
 * says so before it is saved.
 */
export default function DisposableForm({
  requestID,
  initialCcaID,
}: {
  requestID?: string;
  initialCcaID?: number;
}) {
  const router = useRouter();
  const enabled = api.disposable.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const editing = requestID !== undefined;

  const loaded = api.disposable.get.useQuery(
    { id: requestID ?? "" },
    { retry: false, enabled: on && editing },
  );
  const ccas = api.disposable.headCcas.useQuery(undefined, {
    retry: false,
    enabled: on && !editing,
  });

  const [state, setState] = useState<DisposableFormState>(
    emptyForm(initialCcaID ?? null),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (loaded.data && !hydrated) {
      setState(formFromRequest(loaded.data));
      setHydrated(true);
    }
  }, [loaded.data, hydrated]);
  useEffect(() => {
    // One CCA to choose from is already chosen.
    const choices = ccas.data;
    if (!editing && choices?.length === 1 && state.ccaID === null) {
      setState((s) => ({ ...s, ccaID: choices[0]!.ccaID }));
    }
  }, [ccas.data, editing, state.ccaID]);

  const proposals = api.disposable.proposalChoices.useQuery(
    { ccaID: state.ccaID ?? 1 },
    { retry: false, enabled: on && state.ccaID !== null && !editing },
  );

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
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Disposables requests are not switched on yet.
      </p>
    );
  }
  if (editing && loaded.isLoading) {
    return <p className="text-sm text-gray-500">Loading request…</p>;
  }
  if (editing && loaded.data && !loaded.data.can.edit) {
    return (
      <p role="alert" className="text-sm text-gray-600">
        Only the Social director can edit a request.
      </p>
    );
  }
  if (editing && (loaded.isError || !loaded.data)) {
    return (
      <p role="alert" className="text-sm text-red-600">
        That request could not be found.
      </p>
    );
  }
  if (!editing && ccas.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!editing && (ccas.isError || (ccas.data?.length ?? 0) === 0)) {
    return (
      <p role="alert" className="text-sm text-gray-600">
        Only a CCA head can ask for disposables.
      </p>
    );
  }

  const set = (patch: Partial<DisposableFormState>) =>
    setState((s) => ({ ...s, ...patch }));
  const today = sgtDayKey(new Date());
  const backToPending = editing && loaded.data?.status === "approved";
  const canEditLink = !editing;
  const busy = create.isPending || update.isPending;

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
      <h2 className="text-lg font-semibold text-gray-900">
        {editing ? "Edit disposables request" : "New disposables request"}
      </h2>

      {!editing && (ccas.data?.length ?? 0) > 1 && (
        <label className="block text-sm font-medium text-gray-700">
          CCA
          <select
            className={`${fieldClass} mt-1`}
            value={state.ccaID ?? ""}
            onChange={(e) =>
              set({
                ccaID: e.target.value === "" ? null : Number(e.target.value),
                proposalID: "",
              })
            }
          >
            <option value="">Choose a CCA</option>
            {ccas.data?.map((c) => (
              <option key={c.ccaID} value={c.ccaID}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="block text-sm font-medium text-gray-700">
        What is it for?
        <input
          className={`${fieldClass} mt-1`}
          value={state.title}
          maxLength={DISPOSABLE_TITLE_MAX}
          onChange={(e) => set({ title: e.target.value })}
        />
      </label>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-gray-700">
          How many of each
        </legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {DISPOSABLE_ITEMS.map((item) => (
            <label key={item} className="text-xs text-gray-600">
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
        <label className="block text-sm font-medium text-gray-700">
          Collection date
          <input
            type="date"
            min={today}
            className={`${fieldClass} mt-1`}
            value={state.collectionDay}
            onChange={(e) => set({ collectionDay: e.target.value })}
          />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Collection time
          <input
            type="time"
            className={`${fieldClass} mt-1`}
            value={state.collectionTime}
            onChange={(e) => set({ collectionTime: e.target.value })}
          />
        </label>
      </div>

      <label className="block text-sm font-medium text-gray-700">
        Notes (optional)
        <textarea
          className={`${fieldClass} mt-1`}
          rows={3}
          maxLength={DISPOSABLE_DESCRIPTION_MAX}
          value={state.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>

      {canEditLink && (proposals.data?.length ?? 0) > 0 && (
        <label className="block text-sm font-medium text-gray-700">
          Link to a proposal (optional)
          <select
            className={`${fieldClass} mt-1`}
            value={state.proposalID}
            onChange={(e) => set({ proposalID: e.target.value })}
          >
            <option value="">No proposal</option>
            {proposals.data?.map((p) => (
              <option key={p.id} value={p.id} disabled={p.taken}>
                {p.title}
                {p.taken ? " (already has a request)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {backToPending && (
        <p role="note" className="text-sm text-amber-700">
          This request is approved. Saving a change sends it back to pending and
          tells the CCA&apos;s heads.
        </p>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 text-sm text-red-600">
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
