"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useDebounceValue } from "usehooks-ts";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  epochToLocalInput,
  formatDateRange,
  localInputToEpoch,
} from "~/app/events/_lib/format";
import { equipmentErrorMessage } from "~/lib/equipment/errors";
import { equipmentLoanHref, EQUIPMENT_HREF } from "~/lib/equipment/links";
import {
  ITEM_QUANTITY_MAX,
  LOAN_LINES_MAX,
  loanCreateInput,
} from "~/lib/schemas/equipment";
import ShortNotice from "./ShortNotice";

const fieldClass =
  "rounded-md border border-gray-300 dark:border-border bg-white dark:bg-card px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

type Line = { itemID: string; quantity: string };

/** How long the form waits after the last change before it asks for the preview. */
export const CHECK_DEBOUNCE_MS = 400;

/**
 * "Borrow equipment" for one event. The event and its CCA come from the event
 * itself (the page link carries only the event id); the times start as the
 * event's own and can be moved. While the form is open the server says which
 * items look short for the chosen times: that is a warning only, filing is still
 * allowed, and the stock check that counts is the Social director's approval.
 * NOT a guard: the draft and the filing check who may file for this event.
 */
export default function LoanForm({ eventID }: { eventID: number | undefined }) {
  const router = useRouter();
  const enabled = api.equipment.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true && eventID !== undefined;
  const draft = api.equipment.draft.useQuery(
    { eventID: eventID ?? 1 },
    { retry: false, enabled: on },
  );
  const items = api.equipment.items.useQuery(undefined, {
    retry: false,
    enabled: on,
  });
  const [collect, setCollect] = useState("");
  const [back, setBack] = useState("");
  const [lines, setLines] = useState<Line[]>([{ itemID: "", quantity: "1" }]);
  const [error, setError] = useState<string | null>(null);

  // The event's own times, once, when the draft arrives.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !draft.data) return;
    setCollect(epochToLocalInput(draft.data.startTime));
    setBack(epochToLocalInput(draft.data.endTime));
    setSeeded(true);
  }, [draft.data, seeded]);

  const candidate = {
    eventID: eventID ?? 0,
    lines: lines.map((l) => ({
      itemID: l.itemID,
      quantity: Number(l.quantity),
    })),
    collectAt: localInputToEpoch(collect) ?? 0,
    returnAt: localInputToEpoch(back) ?? 0,
  };
  const parsed = loanCreateInput.safeParse(candidate);
  // The preview is asked for only once typing has paused, so a person editing
  // the times or quantities does not spend the hourly budget one key at a time.
  const candidateKey = parsed.success ? JSON.stringify(parsed.data) : "";
  const [settledKey] = useDebounceValue(candidateKey, CHECK_DEBOUNCE_MS);
  const settled = useMemo(() => {
    if (settledKey === "") return null;
    const again = loanCreateInput.safeParse(JSON.parse(settledKey));
    return again.success ? again.data : null;
  }, [settledKey]);
  const check = api.equipment.check.useQuery(settled ?? candidate, {
    retry: false,
    enabled: on && settled !== null,
  });
  const create = api.equipment.create.useMutation({
    onSuccess: (res) => router.push(equipmentLoanHref(res.id)),
    onError: (e) => setError(equipmentErrorMessage(e.message)),
  });

  const muted = "text-sm text-gray-500 dark:text-muted-foreground";
  if (enabled.isLoading) return <p className={muted}>Loading…</p>;
  if (enabled.data?.enabled !== true) {
    return <p className={muted}>Equipment loans are not switched on yet.</p>;
  }
  if (eventID === undefined) {
    return (
      <p className={muted}>
        Open this from an event&apos;s page to borrow equipment for it.
      </p>
    );
  }
  if (draft.isLoading || items.isLoading)
    return <p className={muted}>Loading…</p>;
  if (draft.isError || !draft.data) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        You cannot borrow equipment for that event.
      </p>
    );
  }
  if (items.isError || !items.data) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        Could not load the equipment list. Try again shortly.
      </p>
    );
  }
  const d = draft.data;
  const choices = items.data.items.filter((i) => !i.retired);
  const taken = new Set(lines.map((l) => l.itemID));
  const set = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, at) => (at === i ? { ...l, ...patch } : l)));

  return (
    <form
      className="space-y-4"
      aria-label="Borrow equipment"
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed.success) return;
        setError(null);
        create.mutate(parsed.data);
      }}
    >
      <Link
        href={EQUIPMENT_HREF}
        className="text-sm text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
      >
        All loans
      </Link>
      <header>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground">
          Borrow equipment
        </h2>
        <p className="text-sm text-gray-600 dark:text-muted-foreground">
          {d.title ?? "An event"} ·{" "}
          {d.hallWide ? "Hall-wide" : (d.ccaName ?? "A CCA")}
          {d.startTime !== null &&
            ` · ${formatDateRange(d.startTime, d.endTime)}`}
        </p>
      </header>
      {d.problem && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {equipmentErrorMessage(d.problem)} You cannot borrow equipment for it.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-gray-600 dark:text-muted-foreground">
          Collect from the store
          <input
            type="datetime-local"
            className={`${fieldClass} mt-1 block`}
            value={collect}
            onChange={(e) => setCollect(e.target.value)}
          />
        </label>
        <label className="text-xs text-gray-600 dark:text-muted-foreground">
          Bring back by
          <input
            type="datetime-local"
            className={`${fieldClass} mt-1 block`}
            value={back}
            onChange={(e) => setBack(e.target.value)}
          />
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-900 dark:text-foreground">
          Items
        </legend>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-gray-600 dark:text-muted-foreground">
              Item
              <select
                className={`${fieldClass} mt-1 block`}
                value={l.itemID}
                onChange={(e) => set(i, { itemID: e.target.value })}
              >
                <option value="">Choose an item</option>
                {choices
                  .filter((c) => c.id === l.itemID || !taken.has(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.quantity} owned)
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-xs text-gray-600 dark:text-muted-foreground">
              How many
              <input
                type="number"
                min={1}
                max={ITEM_QUANTITY_MAX}
                className={`${fieldClass} mt-1 block w-24`}
                value={l.quantity}
                onChange={(e) => set(i, { quantity: e.target.value })}
              />
            </label>
            {lines.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLines((ls) => ls.filter((_, at) => at !== i))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {lines.length < LOAN_LINES_MAX && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setLines((ls) => [...ls, { itemID: "", quantity: "1" }])
            }
          >
            Add another item
          </Button>
        )}
      </fieldset>

      {check.isError && settled !== null && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {equipmentErrorMessage(check.error.message)}
        </p>
      )}
      {check.data?.warnings.map((w) => (
        <ShortNotice key={w.itemID} detail={w} />
      ))}
      {check.data && check.data.warnings.length > 0 && (
        <p className="text-xs text-gray-500 dark:text-muted-foreground">
          You can still ask. The Social director checks the stock when deciding.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <Button
        type="submit"
        disabled={!parsed.success || d.problem !== null || create.isPending}
      >
        Ask to borrow
      </Button>
    </form>
  );
}
