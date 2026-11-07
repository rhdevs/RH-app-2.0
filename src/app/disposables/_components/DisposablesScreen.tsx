"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { disposableErrorMessage } from "~/lib/disposables/errors";
import {
  filtersToInput,
  HALL_WIDE_FILTER,
  NO_FILTERS,
  type DisposableFilters,
} from "~/lib/disposables/filters";
import { ITEM_LABELS } from "~/lib/disposables/form";
import { NEW_DISPOSABLE_HREF, disposableHref } from "~/lib/disposables/links";
import {
  DISPOSABLE_STATUSES,
  DISPOSABLE_STATUS_LABELS,
} from "~/lib/disposables/status";
import {
  DISPOSABLE_ITEMS,
  DISPOSABLE_NOTE_MAX,
} from "~/lib/schemas/disposable";
import type { DisposableRequestView } from "~/server/api/services/disposables/read";

type Row = DisposableRequestView;

const fieldClass =
  "rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

/**
 * The disposables requests screen. ONE screen for everyone who may read:
 * a head sees their own CCAs' requests, the Social director and the other JCRC
 * members see all of them. NOT a guard: the list procedure checks the flag and
 * who may read, and each row carries `can`, the buttons the server says this
 * viewer may use (every action is checked again when it is done). Server text
 * is rendered as React text.
 *
 * With `ccaID` the screen is the CCA dashboard's tab: that CCA only.
 *
 * Each request shows the event it is for (its live title while the event
 * exists, the title kept when it was filed after that), a warning when the
 * event was canceled or declined (the request itself is unchanged), and the
 * other requests for the same event. A hall-wide request has no CCA.
 */
export default function DisposablesScreen({ ccaID }: { ccaID?: number }) {
  const enabled = api.disposable.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const [filters, setFilters] = useState<DisposableFilters>(NO_FILTERS);
  const list = api.disposable.list.useQuery(filtersToInput(filters, ccaID), {
    retry: false,
    enabled: on,
  });
  // The event filter offers the events seen on any list so far, so choosing one
  // does not remove it from the choices.
  const [knownEvents, setKnownEvents] = useState<Map<number, string>>(
    new Map(),
  );
  useEffect(() => {
    const items = list.data?.items;
    if (!items) return;
    setKnownEvents((prev) => {
      const next = new Map(prev);
      for (const r of items) {
        if (r.event) next.set(r.event.eventID, r.event.title ?? "(untitled)");
      }
      return next.size === prev.size &&
        [...next].every(([id, title]) => prev.get(id) === title)
        ? prev
        : next;
    });
  }, [list.data]);

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
  if (list.isLoading) {
    return <p className="text-sm text-gray-500">Loading requests…</p>;
  }
  if (list.isError || !list.data) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {list.error?.message.includes("NOT_DISPOSABLE_READER")
          ? "You do not have access to disposables requests."
          : "Could not load the requests. Try again shortly."}
      </p>
    );
  }

  const { items, viewer, ccaOptions, more, skipped, hasSocialDirector } =
    list.data;
  const eventOptions = new Map(knownEvents);
  for (const r of items) {
    if (r.event)
      eventOptions.set(r.event.eventID, r.event.title ?? "(untitled)");
  }
  const set = (patch: Partial<DisposableFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">
          Disposables requests
        </h2>
        {viewer.canCreate && (
          <Button asChild size="sm">
            <Link
              href={
                ccaID !== undefined
                  ? `${NEW_DISPOSABLE_HREF}?cca=${ccaID}`
                  : NEW_DISPOSABLE_HREF
              }
            >
              <Plus /> New request
            </Link>
          </Button>
        )}
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter requests"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="text-xs text-gray-600">
          Status
          <select
            className={`${fieldClass} mt-1 block`}
            value={filters.status}
            onChange={(e) => set({ status: e.target.value })}
          >
            <option value="">All</option>
            {DISPOSABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {DISPOSABLE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        {ccaID === undefined &&
          (ccaOptions.length > 1 || viewer.showHallWide) && (
            <label className="text-xs text-gray-600">
              CCA
              <select
                className={`${fieldClass} mt-1 block`}
                value={filters.ccaID}
                onChange={(e) => set({ ccaID: e.target.value })}
              >
                <option value="">All</option>
                {viewer.showHallWide && (
                  <option value={HALL_WIDE_FILTER}>Hall-wide</option>
                )}
                {ccaOptions.map((c) => (
                  <option key={c.ccaID} value={c.ccaID}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        {eventOptions.size > 0 && (
          <label className="text-xs text-gray-600">
            Event
            <select
              className={`${fieldClass} mt-1 block`}
              value={filters.eventID}
              onChange={(e) => set({ eventID: e.target.value })}
            >
              <option value="">All</option>
              {[...eventOptions].map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-xs text-gray-600">
          Collection from
          <input
            type="date"
            className={`${fieldClass} mt-1 block`}
            value={filters.from}
            onChange={(e) => set({ from: e.target.value })}
          />
        </label>
        <label className="text-xs text-gray-600">
          Collection to
          <input
            type="date"
            className={`${fieldClass} mt-1 block`}
            value={filters.to}
            onChange={(e) => set({ to: e.target.value })}
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setFilters(NO_FILTERS)}
        >
          Clear filters
        </Button>
      </form>

      {!hasSocialDirector ? (
        <p role="status" className="text-sm text-amber-700">
          Nobody holds the Social director position right now, so requests
          cannot be decided yet. The staff have been told.
        </p>
      ) : (
        !viewer.isSocialDirector &&
        !viewer.canCreate && (
          <p className="text-xs text-gray-500">
            You can see these requests. Only the Social director decides them.
          </p>
        )
      )}
      {skipped > 0 && (
        <p role="status" className="text-xs text-amber-700">
          {skipped} request{skipped === 1 ? "" : "s"} could not be shown.
        </p>
      )}
      {more && (
        <p role="status" className="text-xs text-gray-500">
          Showing the first 300 requests. Narrow the filters to see others.
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
          {viewer.canCreate
            ? "No requests match. Ask for plates, cups, bowls, forks or spoons when your CCA needs them."
            : "No requests match."}
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
          {items.map((r) => (
            <RequestItem key={r.id} row={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function quantitiesText(r: Record<(typeof DISPOSABLE_ITEMS)[number], number>) {
  return DISPOSABLE_ITEMS.filter((i) => r[i] > 0)
    .map((i) => `${r[i]} ${ITEM_LABELS[i].toLowerCase()}`)
    .join(", ");
}

function RequestItem({ row }: { row: Row }) {
  const utils = api.useUtils();
  const [nudged, setNudged] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "approve" | "reject" | "delete">(
    "idle",
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    setMode("idle");
    setNote("");
    setError(null);
    void utils.disposable.list.invalidate();
  };
  const failed = (e: { message: string }) =>
    setError(disposableErrorMessage(e.message));
  const approve = api.disposable.approve.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const reject = api.disposable.reject.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const remove = api.disposable.delete.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const nudge = api.disposable.nudge.useMutation({
    onSuccess: (res) => {
      setError(null);
      setNudged(
        res.status === "no_director"
          ? "There is no Social director to tell right now."
          : res.status === "already_sent"
            ? "You already nudged today."
            : "The Social director has been nudged.",
      );
    },
    onError: failed,
  });
  const busy =
    approve.isPending ||
    reject.isPending ||
    remove.isPending ||
    nudge.isPending;
  const decide = (kind: "approve" | "reject") => {
    setError(null);
    const input = {
      id: row.id,
      version: row.version,
      note: note.trim() === "" ? null : note,
    };
    if (kind === "approve") approve.mutate(input);
    else reject.mutate(input);
  };

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">
            {row.title}
          </p>
          <p className="text-xs text-gray-500">
            {row.hallWide ? "Hall-wide" : (row.ccaName ?? `CCA ${row.ccaID}`)}
            {row.requestedBy ? ` · ${row.requestedBy}` : ""}
          </p>
          {row.event && (
            <p className="text-xs text-gray-700">
              For {row.event.title ?? "an event"}
              {row.event.state === "gone" && " (the event no longer exists)"}
            </p>
          )}
          {row.event?.state === "canceled" && (
            <p role="status" className="text-xs font-medium text-amber-700">
              This event was canceled. The request is unchanged.
            </p>
          )}
          {row.event?.state === "declined" && (
            <p role="status" className="text-xs font-medium text-amber-700">
              This event was declined. The request is unchanged.
            </p>
          )}
          <p className="text-xs text-gray-700">{quantitiesText(row)}</p>
          <p className="text-xs text-gray-500">
            Collect {row.collectionDay} at {row.collectionTime}
          </p>
          {row.description && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600">
              {row.description}
            </p>
          )}
          {row.decisionNote && (
            <p className="mt-1 text-xs text-gray-600">
              Note: {row.decisionNote}
            </p>
          )}
          {row.sameEvent.length > 0 && (
            <div className="mt-2 rounded-md bg-gray-50 px-3 py-2">
              <p className="text-xs font-medium text-gray-700">
                Other requests for this event
              </p>
              <ul className="mt-1 space-y-0.5">
                {row.sameEvent.map((o) => (
                  <li key={o.id} className="text-xs text-gray-600">
                    {o.title} · {DISPOSABLE_STATUS_LABELS[o.status]} ·{" "}
                    {quantitiesText(o)} · {o.collectionDay} {o.collectionTime}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            row.status === "approved"
              ? "bg-emerald-100 text-emerald-800"
              : row.status === "rejected"
                ? "bg-red-100 text-red-800"
                : "bg-gray-100 text-gray-700"
          }`}
        >
          {DISPOSABLE_STATUS_LABELS[row.status]}
        </span>
      </div>

      {mode === "idle" ? (
        <div className="flex flex-wrap gap-2">
          {row.can.approve && (
            <Button size="sm" onClick={() => setMode("approve")}>
              Approve
            </Button>
          )}
          {row.can.reject && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMode("reject")}
            >
              Reject
            </Button>
          )}
          {row.can.edit && (
            <Button asChild size="sm" variant="outline">
              <Link href={disposableHref(row.id)}>Edit</Link>
            </Button>
          )}
          {row.can.nudge && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setNudged(null);
                nudge.mutate({ id: row.id });
              }}
            >
              Nudge the Social director
            </Button>
          )}
          {row.can.delete && (
            <Button size="sm" variant="ghost" onClick={() => setMode("delete")}>
              Delete
            </Button>
          )}
        </div>
      ) : mode === "delete" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-700">
            Delete this request for good?
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => remove.mutate({ id: row.id })}
          >
            Yes, delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs text-gray-600">
            Note for the CCA (optional)
            <textarea
              className={`${fieldClass} mt-1 block w-full`}
              rows={2}
              maxLength={DISPOSABLE_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide(mode)}>
              {mode === "approve" ? "Confirm approve" : "Confirm reject"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {nudged && (
        <p role="status" className="text-xs text-gray-700">
          {nudged}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}
