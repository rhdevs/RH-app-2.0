"use client";

import { useMemo, useState } from "react";

import { api } from "~/trpc/react";
import { MAX_SCANNERS_PER_EVENT } from "~/lib/schemas/eventAttendance";

/**
 * Who may work this event's door, picked from the CCA's own member list.
 *
 * WHY A PICKER AND NOT A FREE-TEXT FIELD. Typing an account id is how you get
 * L-27: `userIDSchema` enforces `/^E\d{7}$/`, but `g.s_samuel@u.nus.edu`
 * canonicalises to `G.S_SAMUEL` and is a real row here. A picker over the live
 * directory cannot produce an id that does not exist, and it cannot lock out the
 * people whose ids do not look the way someone assumed they would.
 *
 * NOT RENDERED FOR HALL EVENTS AT ALL, and the server refuses them too. A hall
 * event has no membership set to validate a nominee against, and everyone who
 * could legitimately scan one already holds `manageHallEvents`, which the
 * scanner check admits outright — so the control would change nothing. The
 * original plan specified a picker backed by an SCRC-gated procedure that the
 * JCRC members it was for could not have called.
 *
 * THE STORED LIST IS A CONVENIENCE, NOT A PERMISSION. Every nominee is
 * re-validated against live CCA membership at scan time, because nothing sweeps
 * this list when someone leaves the CCA.
 */
export default function EventScannerPicker({
  eventID,
  ccaID,
  scannerUserIDs,
  onSaved,
}: {
  eventID: number;
  /** null means a hall event — this component renders nothing. */
  ccaID: number | null;
  scannerUserIDs: string[];
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(scannerUserIDs);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const directory = api.cca.memberDirectory.useQuery(
    { ccaID: ccaID ?? 0 },
    { enabled: ccaID !== null, retry: false },
  );

  const save = api.event.saveScanners.useMutation({
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e) => {
      const m = e.message ?? "";
      if (m.startsWith("NOT_MEMBERS:")) {
        // Names the people rather than saying "someone" — the head has to be
        // able to act on it, and they picked from a list, so a stale entry is
        // the interesting case.
        setError(
          `No longer in this CCA: ${m.slice("NOT_MEMBERS:".length).split(",").join(", ")}. Remove them and save again.`,
        );
        return;
      }
      if (m === "HALL_EVENT_HAS_NO_SCANNERS") {
        setError(
          "Hall events don't need a door list — anyone who can run hall events can already scan.",
        );
        return;
      }
      if (m === "EVENT_LOCKED") {
        setError("This event can't be edited any more.");
        return;
      }
      setError("That didn't save. Try again.");
    },
  });

  const rows = useMemo(() => {
    // NORMALISED TO A NON-NULL userID, which is also the filter.
    //
    // `entries` is a union: a resolved member, or a membership key no account
    // matches. Unresolved rows have nobody to nominate — and a resolved row can
    // still carry a null userID — so both are dropped here rather than being
    // rendered as a button that cannot produce a valid nomination. The server
    // would refuse them anyway via the live-membership check; this just avoids
    // offering the head a choice that is guaranteed to fail.
    const all = (directory.data?.entries ?? []).flatMap((d) =>
      d.resolved && d.userID
        ? [{ rowKey: d.rowKey, userID: d.userID, name: d.name, role: d.role }]
        : [],
    );
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (d) =>
        (d.name ?? "").toLowerCase().includes(q) ||
        d.userID.toLowerCase().includes(q),
    );
  }, [directory.data, query]);

  if (ccaID === null) return null;

  const atCap = selected.length >= MAX_SCANNERS_PER_EVENT;
  const dirty =
    selected.length !== scannerUserIDs.length ||
    selected.some((id) => !scannerUserIDs.includes(id));

  function toggle(userID: string) {
    setError(null);
    setSelected((cur) =>
      cur.includes(userID)
        ? cur.filter((x) => x !== userID)
        : atCap
          ? cur
          : [...cur, userID],
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">
          Who&rsquo;s on the door
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          Pick the people who&rsquo;ll scan arrivals at this event. You can
          always scan it yourself — this is for everyone else.
        </p>
      </div>

      {directory.isPending && (
        <p className="text-sm text-gray-500">Loading your members…</p>
      )}
      {directory.error && (
        <p className="text-sm text-red-700">
          Couldn&rsquo;t load your member list.
        </p>
      )}

      {directory.data && (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your members"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />

          <ul className="max-h-64 divide-y divide-gray-100 overflow-y-auto">
            {rows.map((d) => {
              const on = selected.includes(d.userID);
              return (
                <li
                  key={d.rowKey}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-gray-900">
                      {d.name ?? d.userID}
                    </p>
                    <p className="text-xs text-gray-500">{d.role}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(d.userID)}
                    disabled={!on && atCap}
                    className={`shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40 ${
                      on
                        ? "border-gray-900 bg-gray-900 text-white"
                        : "border-gray-300"
                    }`}
                  >
                    {on ? "On the door" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>

          {rows.length === 0 && (
            <p className="text-sm text-gray-500">
              {query.trim()
                ? "Nobody in your CCA matches that."
                : "Your CCA has no members listed yet."}
            </p>
          )}

          {atCap && (
            <p className="text-xs text-amber-700">
              That&rsquo;s {MAX_SCANNERS_PER_EVENT} people — the most one door
              needs. Remove someone to add another.
            </p>
          )}

          {error && <p className="text-sm text-red-700">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate({ eventID, scannerUserIDs: selected })
              }
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save the door list"}
            </button>
            <span className="text-xs text-gray-500">
              {selected.length === 0
                ? "Only you can scan right now."
                : `${selected.length} ${selected.length === 1 ? "person" : "people"} plus you.`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
