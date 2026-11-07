"use client";

import { useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { positionsErrorCopy } from "~/app/admin/positions/_components/errorCopy";
import DisabledNotice, { disabledCopy } from "./DisabledNotice";

type Position = RouterOutputs["jcrcPositions"]["list"][number];
type Member = RouterOutputs["jcrcPositions"]["jcrcMembers"][number];

/**
 * Who holds which JCRC position, set by staff.
 *
 * A position grants nothing (it only sets the JCRC's "My positions" filter),
 * but a position an RF, Hall Office or an admin assigned is what lets a JCRC
 * member hand it over to their successors. So this is where staff decide who
 * may hand over at the end of a term, and how a mistaken handover is undone:
 * assign the position to the member again.
 *
 * Creating, renaming and deleting positions stays with the JCRC on
 * /admin/positions; the procedures refuse it for staff.
 */
export default function PositionHoldersPanel() {
  const list = api.jcrcPositions.list.useQuery(undefined, { retry: false });
  const members = api.jcrcPositions.jcrcMembers.useQuery(undefined, {
    retry: false,
  });

  const loadError = list.error ?? members.error;
  if (loadError && disabledCopy(loadError.message)) {
    return <DisabledNotice message={loadError.message} />;
  }

  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <h2 className="text-lg font-semibold text-gray-900">JCRC positions</h2>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Assign each position to the JCRC member who holds it. A member can only
        hand a position over to their successors if you assigned it to them.
        Assigning it again also undoes a handover made by mistake.
      </p>

      {loadError ? (
        <p className="mt-4 text-sm text-red-600">
          {positionsErrorCopy(loadError.message)}
        </p>
      ) : !list.data || !members.data ? (
        <p className="mt-4 text-sm text-gray-500">Loading…</p>
      ) : list.data.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          The JCRC hasn&rsquo;t set up any positions yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {list.data.map((p) => (
            <PositionRow key={p.id} position={p} members={members.data} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PositionRow({
  position,
  members,
}: {
  position: Position;
  members: readonly Member[];
}) {
  const utils = api.useUtils();
  const [newHolder, setNewHolder] = useState("");
  const [error, setError] = useState<string | null>(null);

  const done = {
    onSuccess: async () => {
      setError(null);
      await utils.jcrcPositions.list.invalidate();
    },
    onError: (e: { message: string }) =>
      setError(positionsErrorCopy(e.message)),
  };
  const addHolder = api.jcrcPositions.addHolder.useMutation(done);
  const removeHolder = api.jcrcPositions.removeHolder.useMutation(done);
  const busy = addHolder.isPending || removeHolder.isPending;
  // Staff change a position that gives director powers from the Director
  // positions panel; this one shows it but does not edit it.
  const readOnly = position.powers.length > 0;

  // A holder stepping out is offered again: re-assigning cancels the handover.
  const openIDs = position.holders
    .filter((h) => h.endsAt === null)
    .map((h) => h.userID);
  const candidates = members.filter((m) => !openIDs.includes(m.userID));

  return (
    <li className="rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900">{position.name}</h3>
      {position.holders.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">Vacant.</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-100">
          {position.holders.map((h) => (
            <li
              key={h.userID}
              className="flex items-center justify-between gap-3 px-3 py-1.5"
            >
              <span className="min-w-0 text-sm text-gray-900">
                {h.name}
                <span className="ml-2 font-mono text-xs text-gray-400">
                  {h.userID}
                </span>
                {h.endsAt && (
                  <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">
                    steps out {new Date(h.endsAt).toLocaleDateString()}
                  </span>
                )}
              </span>
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="shrink-0 text-gray-400 hover:text-red-600"
                  onClick={() =>
                    removeHolder.mutate({ id: position.id, userID: h.userID })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {readOnly ? (
        <p className="mt-2 text-xs text-gray-500">
          This position gives director powers. Change it under Director
          positions.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={`JCRC member to assign to ${position.name}`}
            value={newHolder}
            onChange={(e) => setNewHolder(e.target.value)}
            className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm"
          >
            <option value="">Assign a JCRC member…</option>
            {candidates.map((m) => (
              <option key={m.userID} value={m.userID}>
                {m.name} ({m.userID})
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || newHolder === ""}
            onClick={() =>
              addHolder.mutate(
                { id: position.id, userID: newHolder },
                { onSuccess: () => setNewHolder("") },
              )
            }
          >
            Assign
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </li>
  );
}
