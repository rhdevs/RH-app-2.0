"use client";

import { useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import CcaChecklist from "./CcaChecklist";
import DirectorFlags from "./DirectorFlags";
import { positionsErrorCopy } from "./errorCopy";

export type PositionRow = RouterOutputs["jcrcPositions"]["list"][number];
type Member = RouterOutputs["jcrcPositions"]["jcrcMembers"][number];
export type DirectorsStatus = RouterOutputs["jcrcPositions"]["directorsStatus"];

const dateLabel = (d: Date) =>
  d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * One position: its name and order, whether it oversees every CCA, its CCA
 * list and its holders. Every control saves on its own and the card re-reads
 * the list afterwards; nothing renders optimistically.
 *
 * A flagged position is locked: only an admin sees working controls for its
 * name, CCAs and holders (the server refuses anyone else regardless). The flag
 * controls show only to an admin while `directors.enabled` is on.
 */
export default function PositionCard({
  position,
  members,
  directors,
}: {
  position: PositionRow;
  members: readonly Member[];
  directors: DirectorsStatus | undefined;
}) {
  const utils = api.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(position.name);
  const [order, setOrder] = useState(String(position.order));
  const [pickingCcas, setPickingCcas] = useState(false);
  const [newHolder, setNewHolder] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const done = {
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        utils.jcrcPositions.list.invalidate(),
        utils.jcrcPositions.mine.invalidate(),
      ]);
    },
    onError: (e: { message: string }) =>
      setError(positionsErrorCopy(e.message)),
  };
  const update = api.jcrcPositions.update.useMutation(done);
  const remove = api.jcrcPositions.delete.useMutation(done);
  const setCcas = api.jcrcPositions.setCcas.useMutation(done);
  const addHolder = api.jcrcPositions.addHolder.useMutation(done);
  const removeHolder = api.jcrcPositions.removeHolder.useMutation(done);

  const busy =
    update.isPending ||
    remove.isPending ||
    setCcas.isPending ||
    addHolder.isPending ||
    removeHolder.isPending;

  const flagged = position.vetsProposals || position.handlesDisposables;
  const locked = flagged && directors?.isAdmin !== true;

  const holderIDs = position.holders.map((h) => h.userID);
  const candidates = members.filter((m) => !holderIDs.includes(m.userID));

  const saveDetails = () => {
    const parsedOrder = Number.parseInt(order, 10);
    update.mutate(
      {
        id: position.id,
        name: name.trim(),
        order: Number.isFinite(parsedOrder) ? parsedOrder : 0,
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {editing ? (
          <div className="flex flex-wrap items-end gap-2">
            <Input
              aria-label="Position name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              className="h-9 w-64"
            />
            <Input
              aria-label="Order"
              type="number"
              min={0}
              max={999}
              value={order}
              onChange={(e) => setOrder(e.target.value)}
              className="h-9 w-20"
            />
            <Button
              size="sm"
              disabled={busy || name.trim() === ""}
              onClick={saveDetails}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setName(position.name);
                setOrder(String(position.order));
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div>
            <h3 className="text-base font-semibold text-gray-900">
              {position.name}
            </h3>
            <p className="text-xs text-gray-400">Order {position.order}</p>
            {flagged && (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                {position.vetsProposals && (
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">
                    Vets proposals
                  </span>
                )}
                {position.handlesDisposables && (
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">
                    Social director
                  </span>
                )}
                {position.vacant === true && (
                  <span
                    role="status"
                    className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900"
                  >
                    Vacant: no current holder with JCRC
                  </span>
                )}
                {position.vacant === null && (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                    Vacancy unknown
                  </span>
                )}
                <span className="text-gray-500">
                  Locked: only an admin, an RF or the Hall Office can change its
                  name, CCAs or holders.
                </span>
              </p>
            )}
          </div>
        )}
        <div className="flex items-center gap-1">
          {!editing && (
            <Button
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => setEditing(true)}
            >
              Rename
            </Button>
          )}
          {confirmDelete ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => remove.mutate({ id: position.id })}
              >
                Delete position
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={locked}
              className="text-gray-400 hover:text-red-600"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Checkbox
          id={`oversees-${position.id}`}
          checked={position.overseesAll}
          disabled={busy}
          onCheckedChange={(v) =>
            update.mutate({ id: position.id, overseesAll: v === true })
          }
        />
        <label
          htmlFor={`oversees-${position.id}`}
          className="text-sm text-gray-700"
        >
          Oversees every CCA (for example, the President)
        </label>
      </div>

      <section className="mt-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-gray-900">
            CCAs{" "}
            <span className="font-normal text-gray-400">
              ({position.ccas.length})
            </span>
          </h4>
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => setPickingCcas((v) => !v)}
          >
            {pickingCcas ? "Close" : "Choose CCAs"}
          </Button>
        </div>
        {pickingCcas ? (
          <CcaChecklist
            initial={position.ccas.map((c) => c.ccaID)}
            saving={setCcas.isPending}
            onSave={(ccaIDs) =>
              setCcas.mutate(
                { id: position.id, ccaIDs },
                { onSuccess: () => setPickingCcas(false) },
              )
            }
          />
        ) : position.ccas.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">
            {position.overseesAll
              ? "Not needed: this position sees every CCA."
              : "No CCAs yet."}
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {position.ccas.map((c) => (
              <li
                key={c.ccaID}
                className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700"
              >
                {c.ccaName}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4">
        <h4 className="text-sm font-medium text-gray-900">Held by</h4>
        {position.holders.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">Vacant.</p>
        ) : (
          <ul className="mt-1 divide-y divide-gray-100 rounded-lg border border-gray-200">
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
                      steps out {dateLabel(new Date(h.endsAt))}
                    </span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || locked}
                  className="shrink-0 text-gray-400 hover:text-red-600"
                  onClick={() =>
                    removeHolder.mutate({ id: position.id, userID: h.userID })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="JCRC member to add"
            value={newHolder}
            disabled={locked}
            onChange={(e) => setNewHolder(e.target.value)}
            className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm"
          >
            <option value="">Add a JCRC member…</option>
            {candidates.map((m) => (
              <option key={m.userID} value={m.userID}>
                {m.name} ({m.userID})
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || locked || newHolder === ""}
            onClick={() =>
              addHolder.mutate(
                { id: position.id, userID: newHolder },
                { onSuccess: () => setNewHolder("") },
              )
            }
          >
            Add
          </Button>
        </div>
      </section>

      {directors?.canSetFlags && <DirectorFlags position={position} />}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </li>
  );
}
