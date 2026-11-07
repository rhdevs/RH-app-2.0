"use client";

import { useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { positionsErrorCopy } from "~/app/admin/positions/_components/errorCopy";
import DisabledNotice, { disabledCopy } from "./DisabledNotice";

type Listing = RouterOutputs["jcrcPositionsStaff"]["list"];
type Row = Listing["positions"][number];

const E_FORMAT = /^E\d{7}$/;

/**
 * The staff door to the positions that give director powers: change who holds
 * them and which CCAs they cover, rename them, delete them.
 *
 * It talks to `jcrcPositionsStaff` and nothing else, and every change runs the
 * same code as the admin Positions page (one transaction, one lock check, one
 * audit row). It cannot give or take away the powers themselves; that stays
 * with admins on the Positions page. It never shows for a position without
 * powers, and the server refuses those too, so hiding is only a courtesy.
 */
export default function FlaggedPositionsPanel() {
  const list = api.jcrcPositionsStaff.list.useQuery(undefined, {
    retry: false,
  });

  if (list.isPending) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (list.error) {
    if (disabledCopy(list.error.message)) {
      return <DisabledNotice message={list.error.message} />;
    }
    return (
      <p className="rounded-xl bg-white p-6 text-sm text-red-600 shadow-sm">
        {positionsErrorCopy(list.error.message)}
      </p>
    );
  }

  const { positions, ccas } = list.data;
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-gray-600">
        These positions give director powers, so their holders and CCAs are kept
        here and on the admin Positions page, not left open to every JCRC
        member. Setting or removing the powers is an admin&rsquo;s job.
      </p>
      {positions.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-sm text-gray-500 shadow-sm">
          No position gives director powers yet. An admin sets that on the
          Positions page.
        </p>
      ) : (
        positions.map((p) => <PositionRow key={p.id} row={p} ccas={ccas} />)
      )}
    </div>
  );
}

function PositionRow({ row, ccas }: { row: Row; ccas: Listing["ccas"] }) {
  const utils = api.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(row.name);
  const [userID, setUserID] = useState("");
  const [chosen, setChosen] = useState<readonly number[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => utils.jcrcPositionsStaff.list.invalidate();
  const options = {
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (e: { message: string }) =>
      setError(positionsErrorCopy(e.message)),
  };
  const addHolder = api.jcrcPositionsStaff.addHolder.useMutation({
    ...options,
    onSuccess: async () => {
      setUserID("");
      await options.onSuccess();
    },
  });
  const removeHolder = api.jcrcPositionsStaff.removeHolder.useMutation(options);
  const rename = api.jcrcPositionsStaff.rename.useMutation(options);
  const setCcas = api.jcrcPositionsStaff.setCcas.useMutation({
    ...options,
    onSuccess: async () => {
      setChosen(null);
      await options.onSuccess();
    },
  });
  const remove = api.jcrcPositionsStaff.delete.useMutation(options);

  const id = userID.trim().toUpperCase();
  const covered = chosen ?? row.ccas.map((c) => c.ccaID);
  const busy =
    addHolder.isPending ||
    removeHolder.isPending ||
    rename.isPending ||
    setCcas.isPending ||
    remove.isPending;

  return (
    <section className="rounded-xl bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">{row.name}</h2>
        {row.powers.map((power) => (
          <span
            key={power}
            className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800"
          >
            {power}
          </span>
        ))}
        {row.vacant === null && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            Vacancy unknown
          </span>
        )}
        {row.vacant === true && (
          <span
            role="status"
            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900"
          >
            No current holder with JCRC
          </span>
        )}
      </div>

      <div className="mt-3 space-y-1">
        <h3 className="text-sm font-medium text-gray-900">Holders</h3>
        {row.holders.length === 0 ? (
          <p className="text-sm text-gray-500">Nobody holds this position.</p>
        ) : (
          <ul className="space-y-1">
            {row.holders.map((h) => (
              <li key={h.userID} className="flex items-center gap-2 text-sm">
                <span className="text-gray-800">
                  {h.name} <span className="text-gray-400">{h.userID}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    removeHolder.mutate({ id: row.id, userID: h.userID })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Input
            aria-label={`NUSNET id to add to ${row.name}`}
            placeholder="E1234567"
            value={userID}
            onChange={(e) => setUserID(e.target.value)}
            className="h-9 w-40"
          />
          <Button
            size="sm"
            disabled={!E_FORMAT.test(id) || busy}
            onClick={() => addHolder.mutate({ id: row.id, userID: id })}
          >
            Add holder
          </Button>
        </div>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-gray-900">CCAs</legend>
        <ul className="mt-1 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
          {ccas.map((c) => (
            <li key={c.ccaID} className="flex items-center gap-2">
              <Checkbox
                id={`staff-${row.id}-${c.ccaID}`}
                checked={covered.includes(c.ccaID)}
                onCheckedChange={(v) =>
                  setChosen(
                    v === true
                      ? [...covered, c.ccaID]
                      : covered.filter((x) => x !== c.ccaID),
                  )
                }
              />
              <label
                htmlFor={`staff-${row.id}-${c.ccaID}`}
                className="text-sm text-gray-800"
              >
                {c.ccaName}
              </label>
            </li>
          ))}
        </ul>
        <Button
          className="mt-2"
          size="sm"
          disabled={chosen === null || busy}
          onClick={() => setCcas.mutate({ id: row.id, ccaIDs: [...covered] })}
        >
          Save CCAs
        </Button>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          aria-label={`New name for ${row.name}`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="h-9 w-64"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={name.trim() === "" || name.trim() === row.name || busy}
          onClick={() => rename.mutate({ id: row.id, name: name.trim() })}
        >
          Rename
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete position
        </Button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {row.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its holders and CCAs are removed with it, and the director powers
              it gives go away. This is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate({ id: row.id })}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
