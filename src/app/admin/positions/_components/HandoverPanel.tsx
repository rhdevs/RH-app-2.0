"use client";

import { useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { positionsErrorCopy } from "./errorCopy";

type Mine = RouterOutputs["jcrcPositions"]["mine"];

const E_FORMAT = /^E\d{7}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STEP_OUT_DAYS = 14;

/** yyyy-mm-dd in local time, for <input type="date">. */
const toDateInput = (d: Date) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/** The end of the chosen local day, so "step out on the 30th" means all of it. */
const endOfDay = (value: string) => new Date(`${value}T23:59:59`);

const parseIDs = (raw: string) =>
  [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ] as string[];

/**
 * JCRC self-handover. Successors get `jcrc` and the positions at once; the
 * caller keeps theirs until the step-out date, then loses the positions and,
 * if those were their last, `jcrc` too. Successors must have signed in to the
 * app at least once, and each position can be handed over once per holder.
 */
export default function HandoverPanel({ mine }: { mine: Mine }) {
  const utils = api.useUtils();
  const handable = mine.positions.filter((p) => p.endsAt === null);
  const stepping = mine.positions.filter((p) => p.endsAt !== null);

  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [successors, setSuccessors] = useState("");
  const [stepOut, setStepOut] = useState(
    toDateInput(new Date(Date.now() + DEFAULT_STEP_OUT_DAYS * DAY_MS)),
  );
  const [reason, setReason] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      utils.jcrcPositions.list.invalidate(),
      utils.jcrcPositions.mine.invalidate(),
    ]);
  };
  const onError = (e: { message: string }) => {
    setNotice(null);
    setError(positionsErrorCopy(e.message));
  };

  const handOver = api.jcrcPositions.handOver.useMutation({
    onSuccess: async (r) => {
      setError(null);
      setChosen([]);
      setSuccessors("");
      setReason("");
      setNotice(
        `${r.granted.length} ${r.granted.length === 1 ? "person is" : "people are"} now on the JCRC.`,
      );
      await refresh();
    },
    onError,
  });
  const setStepOutDate = api.jcrcPositions.setStepOut.useMutation({
    onSuccess: async () => {
      setError(null);
      setMoveTo("");
      await refresh();
    },
    onError,
  });

  const ids = parseIDs(successors);
  const badIDs = ids.filter((id) => !E_FORMAT.test(id));
  const canSubmit =
    chosen.length > 0 &&
    ids.length > 0 &&
    badIDs.length === 0 &&
    stepOut !== "" &&
    !handOver.isPending;

  return (
    <section className="rounded-xl border border-blue-100 bg-blue-50/40 p-5">
      <h2 className="text-base font-semibold text-gray-900">Hand over</h2>
      <p className="mt-1 max-w-2xl text-sm text-gray-600">
        Pass positions you hold to the people taking over. They join the JCRC
        straight away. You keep your positions until your step-out date, then
        lose them, and your JCRC role too if they were your last.
      </p>

      {stepping.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            You step out of {stepping.map((p) => p.name).join(", ")} on{" "}
            <strong>
              {new Date(stepping[0]!.endsAt!).toLocaleDateString()}
            </strong>
            {mine.termEndsAt && ", and your JCRC role ends then"}.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              type="date"
              aria-label="New step-out date"
              value={moveTo}
              min={toDateInput(new Date())}
              onChange={(e) => setMoveTo(e.target.value)}
              className="h-9 w-44 bg-white"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={moveTo === "" || setStepOutDate.isPending}
              onClick={() =>
                setStepOutDate.mutate({ stepOutAt: endOfDay(moveTo) })
              }
            >
              Move date
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={setStepOutDate.isPending}
              onClick={() => setStepOutDate.mutate({ stepOutAt: null })}
            >
              Cancel step-out
            </Button>
          </div>
        </div>
      )}

      {handable.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          {stepping.length > 0
            ? "Every position you hold is already handed over."
            : "You don't hold any positions."}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <fieldset>
            <legend className="text-sm font-medium text-gray-900">
              Positions to hand over
            </legend>
            <ul className="mt-1 space-y-1">
              {handable.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`handover-${p.id}`}
                    checked={chosen.includes(p.id)}
                    onCheckedChange={(v) =>
                      setChosen((prev) =>
                        v === true
                          ? [...prev, p.id]
                          : prev.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <label
                    htmlFor={`handover-${p.id}`}
                    className="text-sm text-gray-800"
                  >
                    {p.name}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <div className="space-y-1">
            <label
              htmlFor="handover-successors"
              className="block text-sm font-medium text-gray-900"
            >
              Successors&rsquo; NUSNET ids
            </label>
            <Input
              id="handover-successors"
              placeholder="E1234567, E7654321"
              value={successors}
              onChange={(e) => setSuccessors(e.target.value)}
              className="h-9 max-w-md bg-white"
            />
            {badIDs.length > 0 && (
              <p className="text-xs text-red-600">
                Not a NUSNET id: {badIDs.join(", ")}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label
              htmlFor="handover-stepout"
              className="block text-sm font-medium text-gray-900"
            >
              Your step-out date
            </label>
            <Input
              id="handover-stepout"
              type="date"
              value={stepOut}
              min={toDateInput(new Date())}
              onChange={(e) => setStepOut(e.target.value)}
              className="h-9 w-44 bg-white"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="handover-reason"
              className="block text-sm font-medium text-gray-900"
            >
              Note <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <Textarea
              id="handover-reason"
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="max-w-md bg-white"
            />
          </div>

          <Button
            disabled={!canSubmit}
            onClick={() =>
              handOver.mutate({
                positionIDs: [...chosen],
                successorIDs: ids,
                stepOutAt: endOfDay(stepOut),
                reason: reason.trim() || undefined,
              })
            }
          >
            Hand over
          </Button>
        </div>
      )}

      {notice && <p className="mt-3 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}
