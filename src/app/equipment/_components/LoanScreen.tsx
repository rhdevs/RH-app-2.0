"use client";

import Link from "next/link";
import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { formatDateRange, formatDateTime } from "~/app/events/_lib/format";
import { equipmentErrorMessage } from "~/lib/equipment/errors";
import { EQUIPMENT_HREF } from "~/lib/equipment/links";
import { parseShortMessage } from "~/lib/equipment/stock";
import { REASON_MAX, DIRECTOR_NOTE_MAX } from "~/lib/schemas/equipment";
import ReturnPanel from "./ReturnPanel";
import ShortNotice from "./ShortNotice";
import StatusBadge from "./StatusBadge";

const fieldClass =
  "w-full rounded-md border border-gray-300 dark:border-border bg-white dark:bg-card px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

type Mode = "idle" | "approve" | "reject" | "cancel" | "return" | "note";

/**
 * One equipment loan, with the actions the SERVER says this viewer may take
 * (`can`; every action is checked again when it is done). The reason, the
 * director's note and the photo are sent only to the Social director and the
 * event's leaders, so for anyone else they are simply not there. The photo is
 * shown through the app's own access-checked route, never a store address.
 */
export default function LoanScreen({ loanID }: { loanID: string }) {
  const utils = api.useUtils();
  const enabled = api.equipment.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const loan = api.equipment.get.useQuery(
    { id: loanID },
    { retry: false, enabled: on },
  );
  const [mode, setMode] = useState<Mode>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);

  const done = () => {
    setMode("idle");
    setText("");
    setError(null);
    void utils.equipment.get.invalidate({ id: loanID });
    void utils.equipment.list.invalidate();
  };
  const failed = (e: { message: string }) => {
    setError(e.message);
    void utils.equipment.get.invalidate({ id: loanID });
  };
  const approve = api.equipment.approve.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const reject = api.equipment.reject.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const cancel = api.equipment.cancel.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const collect = api.equipment.collect.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const note = api.equipment.note.useMutation({
    onSuccess: done,
    onError: failed,
  });
  const busy =
    note.isPending ||
    approve.isPending ||
    reject.isPending ||
    cancel.isPending ||
    collect.isPending;

  const muted = "text-sm text-gray-500 dark:text-muted-foreground";
  if (enabled.isLoading) return <p className={muted}>Loading…</p>;
  if (!on)
    return <p className={muted}>Equipment loans are not switched on yet.</p>;
  if (loan.isLoading) return <p className={muted}>Loading the loan…</p>;
  if (loan.isError || !loan.data) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {loan.error?.message.includes("EQUIPMENT_NOT_FOUND")
          ? "That loan no longer exists."
          : "Could not load the loan. Try again shortly."}
      </p>
    );
  }
  const l = loan.data;
  const short = error ? parseShortMessage(error) : null;
  const ref = { id: l.id, version: l.version };

  return (
    <article className="space-y-4">
      <Link
        href={EQUIPMENT_HREF}
        className="text-sm text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
      >
        All loans
      </Link>
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground">
          {l.eventTitle ?? "An event"}
        </h2>
        <StatusBadge status={l.status} overdue={l.overdue} />
        <p className="text-sm text-gray-600 dark:text-muted-foreground">
          {l.hallWide ? "Hall-wide" : (l.ccaName ?? "A CCA")}
          {" · "}
          {formatDateRange(l.collectAt, l.returnAt)}
          {l.requestedBy ? ` · asked by ${l.requestedBy}` : ""}
        </p>
        {(l.eventState === "canceled" || l.eventState === "declined") &&
          l.status === "approved" && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              The event is {l.eventState}, so this loan holds no stock and
              cannot be collected.
            </p>
          )}
        {(l.eventState === "canceled" || l.eventState === "declined") &&
          l.status === "collected" && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              The event is {l.eventState}, but the kit is out, so this loan
              still holds stock until it is returned.
            </p>
          )}
      </header>

      <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white dark:divide-border dark:border-border dark:bg-card">
        {l.lines.map((line) => (
          <li
            key={line.itemID}
            className="flex justify-between px-4 py-2 text-sm"
          >
            <span className="text-gray-900 dark:text-foreground">
              {line.name ?? "Removed item"}
            </span>
            <span className="text-gray-600 dark:text-muted-foreground">
              {line.quantity}
            </span>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 text-sm text-gray-700 dark:text-foreground">
        {l.decidedAt && (
          <div>
            Decided{" "}
            {formatDateTime(Math.floor(new Date(l.decidedAt).getTime() / 1000))}
            {l.decidedBy ? ` by ${l.decidedBy}` : ""}
          </div>
        )}
        {l.reason && <div>Reason: {l.reason}</div>}
        {l.canceledAt && (
          <div>
            Canceled{" "}
            {formatDateTime(
              Math.floor(new Date(l.canceledAt).getTime() / 1000),
            )}
            {l.canceledBy ? ` by ${l.canceledBy}` : ""}
          </div>
        )}
        {l.cancelReason && <div>Cancel reason: {l.cancelReason}</div>}
        {l.directorNote && (
          <div>Note from the Social director: {l.directorNote}</div>
        )}
        {l.collectedAt && (
          <div>
            Collected{" "}
            {formatDateTime(
              Math.floor(new Date(l.collectedAt).getTime() / 1000),
            )}
          </div>
        )}
        {l.returnedAt && (
          <div>
            Returned{" "}
            {formatDateTime(
              Math.floor(new Date(l.returnedAt).getTime() / 1000),
            )}
            {l.returnedBy ? ` by ${l.returnedBy}` : ""}
          </div>
        )}
      </dl>

      {l.hasPhoto && !photoFailed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/equipment-return/${l.id}`}
          alt="Photo of the returned equipment"
          className="max-h-96 rounded-md border border-gray-200 dark:border-border"
          onError={() => setPhotoFailed(true)}
        />
      )}
      {l.hasPhoto && photoFailed && (
        <p className={muted}>The photo could not be loaded.</p>
      )}

      {short ? <ShortNotice detail={short} /> : null}
      {error && !short && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {equipmentErrorMessage(error)}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {l.can.approve && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode(mode === "approve" ? "idle" : "approve");
              setText("");
            }}
          >
            Approve
          </Button>
        )}
        {l.can.reject && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode(mode === "reject" ? "idle" : "reject");
              setText("");
            }}
          >
            Reject
          </Button>
        )}
        {l.can.collect && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              collect.mutate(ref);
            }}
          >
            Mark collected
          </Button>
        )}
        {l.can.markReturned && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode(mode === "return" ? "idle" : "return");
            }}
          >
            Mark returned
          </Button>
        )}
        {l.can.note && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode(mode === "note" ? "idle" : "note");
              setText(l.directorNote ?? "");
            }}
          >
            {l.directorNote ? "Edit note" : "Add a note"}
          </Button>
        )}
        {l.can.cancel && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode(mode === "cancel" ? "idle" : "cancel");
              setText("");
            }}
          >
            Cancel loan
          </Button>
        )}
      </div>

      {(mode === "approve" || mode === "reject" || mode === "cancel") && (
        <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-border">
          <label className="block text-sm text-gray-700 dark:text-foreground">
            {mode === "approve"
              ? "Note for the requester (optional)"
              : mode === "reject"
                ? "Why is it rejected?"
                : l.viewerIs === "director"
                  ? "Reason (optional)"
                  : "Reason (optional, not sent)"}
            <textarea
              className={`${fieldClass} mt-1`}
              rows={2}
              maxLength={mode === "approve" ? DIRECTOR_NOTE_MAX : REASON_MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || (mode === "reject" && text.trim() === "")}
            onClick={() => {
              setError(null);
              const note = text.trim() === "" ? null : text;
              if (mode === "approve")
                approve.mutate({ ...ref, directorNote: note });
              else if (mode === "reject")
                reject.mutate({ ...ref, reason: text });
              else cancel.mutate({ ...ref, reason: note });
            }}
          >
            Confirm{" "}
            {mode === "approve"
              ? "approval"
              : mode === "reject"
                ? "rejection"
                : "cancellation"}
          </Button>
        </div>
      )}
      {mode === "note" && (
        <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-border">
          <label className="block text-sm text-gray-700 dark:text-foreground">
            Note for the event&apos;s leaders
            <textarea
              className={`${fieldClass} mt-1`}
              rows={3}
              maxLength={DIRECTOR_NOTE_MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || text.trim() === ""}
            onClick={() => {
              setError(null);
              note.mutate({ ...ref, directorNote: text });
            }}
          >
            Save note
          </Button>
        </div>
      )}
      {mode === "return" && (
        <ReturnPanel loanID={l.id} version={l.version} onDone={done} />
      )}
    </article>
  );
}
