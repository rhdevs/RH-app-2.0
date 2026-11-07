"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import type { PositionRow } from "./PositionCard";
import { positionsErrorCopy } from "./errorCopy";

type FlagKey = "vetsProposals" | "handlesDisposables";

const FLAGS: { key: FlagKey; title: string; effect: string }[] = [
  {
    key: "vetsProposals",
    title: "Vets proposals",
    effect:
      "its current holders become the directors of the CCAs it lists and can approve, return and finish their proposals",
  },
  {
    key: "handlesDisposables",
    title: "Social director",
    effect:
      "its current holder decides disposable requests for every CCA (only if exactly one position has this)",
  },
];

/**
 * The admin-only controls that set or clear a position's director flags. The
 * admin sees the holders and CCAs first and confirms them; the server checks
 * that they are still what was shown before it writes, and records them in
 * the audit row.
 */
export default function DirectorFlags({ position }: { position: PositionRow }) {
  const utils = api.useUtils();
  const [pending, setPending] = useState<{
    flag: FlagKey;
    value: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setFlag = api.jcrcPositions.setFlag.useMutation({
    onSuccess: async () => {
      setPending(null);
      setError(null);
      await utils.jcrcPositions.list.invalidate();
    },
    onError: (e) => {
      setError(positionsErrorCopy(e.message));
      if (e.message === "CONFIRMATION_STALE") {
        setPending(null);
        void utils.jcrcPositions.list.invalidate();
      }
    },
  });

  const holders = position.holders;
  const ccas = position.ccas;

  return (
    <section className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <h4 className="text-sm font-medium text-gray-900">Director powers</h4>
      <p className="mt-0.5 text-xs text-gray-500">
        Only admins set these. While a position has one, only an admin, an RF or
        the Hall Office can change its holders, CCAs or name, and each change is
        recorded.
      </p>
      <ul className="mt-2 space-y-2">
        {FLAGS.map((f) => {
          const on = position[f.key];
          const confirming = pending?.flag === f.key;
          return (
            <li key={f.key} className="text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-gray-800">
                  {f.title}{" "}
                  <span
                    className={
                      on
                        ? "rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800"
                        : "text-xs text-gray-400"
                    }
                  >
                    {on ? "On" : "Off"}
                  </span>
                </span>
                {!confirming && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setFlag.isPending}
                    onClick={() => {
                      setError(null);
                      setPending({ flag: f.key, value: !on });
                    }}
                  >
                    {on ? "Clear…" : "Set…"}
                  </Button>
                )}
              </div>
              {confirming && pending && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm text-amber-900">
                    {pending.value
                      ? `Setting this means ${f.effect}.`
                      : `Clearing this removes that power from the position.`}{" "}
                    Check who and what is affected right now:
                  </p>
                  <dl className="mt-2 space-y-1 text-sm text-gray-800">
                    <div>
                      <dt className="inline font-medium">Holders: </dt>
                      <dd className="inline">
                        {holders.length === 0
                          ? "none (vacant)"
                          : holders
                              .map((h) => `${h.name} (${h.userID})`)
                              .join(", ")}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">CCAs: </dt>
                      <dd className="inline">
                        {ccas.length === 0
                          ? "none"
                          : ccas.map((c) => c.ccaName).join(", ")}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      disabled={setFlag.isPending}
                      onClick={() =>
                        setFlag.mutate({
                          id: position.id,
                          flag: f.key,
                          value: pending.value,
                          seen: {
                            holderIDs: holders.map((h) => h.userID),
                            ccaIDs: ccas.map((c) => c.ccaID),
                          },
                        })
                      }
                    >
                      {pending.value ? "Confirm and set" : "Confirm and clear"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPending(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
