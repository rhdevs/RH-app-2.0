"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import {
  epochToLocalInput,
  localInputToEpoch,
} from "~/app/events/_lib/format";
import { resolveAttendanceWindow } from "~/lib/schemas/eventAttendance";
import EventScannerPicker from "./EventScannerPicker";

/**
 * THE DOOR SECTION — check-in timing, who may scan, and the way in.
 *
 * MOUNTED FOR A DRAFT *AND* FOR A PUBLISHED EVENT, deliberately, and that is the
 * point of it existing as its own component rather than living inside the
 * details editor. Everything else about a published event is frozen at approval
 * so a JCRC approves what residents actually get — but the check-in window and
 * the door list are the two things a head needs to change ON THE DAY:
 * registration starts earlier than planned, the event overruns, or the person
 * who was going to work the door is ill. Neither is visible to a resident or
 * part of what was approved, so freezing them protects nothing and just leaves
 * a head standing at a door unable to fix the evening in front of them.
 *
 * THE WINDOW HAS THREE STATES, not two — see `resolveAttendanceWindow`:
 * untouched (derived from the start time), an explicit window, or OPEN-ENDED,
 * meaning open until the head closes it.
 */
export default function EventDoorSection({
  eventID,
  ccaID,
  status,
  startTime,
  endTime,
  attendanceOpensAt,
  attendanceClosesAt,
  scannerUserIDs,
  onSaved,
}: {
  eventID: number;
  ccaID: number | null;
  status: string;
  startTime: number | null;
  endTime: number | null;
  attendanceOpensAt: number | null;
  attendanceClosesAt: number | null;
  scannerUserIDs: string[];
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [opensDraft, setOpensDraft] = useState(
    epochToLocalInput(attendanceOpensAt),
  );
  const [closesDraft, setClosesDraft] = useState(
    epochToLocalInput(attendanceClosesAt),
  );

  const update = api.event.update.useMutation({
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e) =>
      setError(
        e.message === "EVENT_LOCKED"
          ? "This event can't be edited any more."
          : "That didn't save. Try again.",
      ),
  });

  const window = resolveAttendanceWindow({
    startTime,
    endTime,
    attendanceOpensAt,
    attendanceClosesAt,
  });
  const nowSec = Math.floor(Date.now() / 1000);
  const openEnded = window != null && window.closesAt == null;
  const touched = attendanceOpensAt != null || attendanceClosesAt != null;

  const fmt = (sec: number) =>
    new Date(sec * 1000).toLocaleString("en-SG", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });

  // Says what is true RIGHT NOW rather than restating the settings, because
  // "is my door working" is the only question this section is ever asked.
  let stateLine: string;
  if (!window) {
    stateLine =
      "There's no check-in window — this event needs a start time before the door can work.";
  } else if (openEnded) {
    stateLine =
      nowSec >= window.opensAt
        ? `The door is OPEN and stays open until you close it. Opened ${fmt(window.opensAt)}.`
        : `The door opens ${fmt(window.opensAt)} and stays open until you close it.`;
  } else if (nowSec < window.opensAt) {
    stateLine = `The door opens ${fmt(window.opensAt)}${touched ? "" : " (an hour before the start)"} and closes ${fmt(window.closesAt!)}.`;
  } else if (nowSec <= window.closesAt!) {
    stateLine = `The door is OPEN now, and closes ${fmt(window.closesAt!)}.`;
  } else {
    stateLine = `The door closed ${fmt(window.closesAt!)}.`;
  }

  const busy = update.isPending;

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">At the door</h3>
        <p className="mt-1 text-sm text-gray-600">{stateLine}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* OPEN NOW writes an explicit open and CLEARS the close, which is what
            makes it open-ended. */}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            update.mutate({
              eventID,
              attendanceOpensAt: Math.floor(Date.now() / 1000),
              attendanceClosesAt: null,
            })
          }
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Open the door now
        </button>

        {/* CLOSE NOW writes a close time of now. It does not clear the open
            time — the record of when the door was open stays true. */}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            update.mutate({
              eventID,
              attendanceClosesAt: Math.floor(Date.now() / 1000),
            })
          }
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Close the door now
        </button>

        {touched && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpensDraft("");
              setClosesDraft("");
              update.mutate({
                eventID,
                attendanceOpensAt: null,
                attendanceClosesAt: null,
              });
            }}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Back to the usual times
          </button>
        )}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-gray-600">
          Set exact times instead
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-gray-500">Opens</span>
            <input
              type="datetime-local"
              value={opensDraft}
              onChange={(e) => setOpensDraft(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">
              Closes — leave blank to stay open until you close it
            </span>
            <input
              type="datetime-local"
              value={closesDraft}
              onChange={(e) => setClosesDraft(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={busy || !opensDraft}
          onClick={() =>
            update.mutate({
              eventID,
              attendanceOpensAt: localInputToEpoch(opensDraft),
              attendanceClosesAt: closesDraft
                ? localInputToEpoch(closesDraft)
                : null,
            })
          }
          className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save these times"}
        </button>
        <p className="mt-2 text-xs text-gray-400">
          An open time is required. Without a close time the door stays open
          until you close it.
        </p>
      </details>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <EventScannerPicker
        eventID={eventID}
        ccaID={ccaID}
        scannerUserIDs={scannerUserIDs}
        onSaved={onSaved}
      />

      {status === "published" && (
        <div className="border-t border-gray-100 pt-4">
          <a
            href={`/events/${eventID}/door`}
            className="inline-block rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
          >
            Open the door scanner
          </a>
          <p className="mt-2 text-sm text-gray-500">
            Scan arrivals, or tick them off the list if a phone won&rsquo;t
            cooperate. Send this link to whoever you put on the door.
          </p>
        </div>
      )}
    </section>
  );
}
