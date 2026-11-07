"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";

/**
 * Tick the CCAs a position looks after. Many-to-many: the same CCA may sit
 * under several positions. Saves the whole list in one call.
 */
export default function CcaChecklist({
  initial,
  saving,
  onSave,
}: {
  initial: readonly number[];
  saving: boolean;
  onSave: (ccaIDs: number[]) => void;
}) {
  const { data: ccas, isPending, error } = api.admin.listCcas.useQuery();
  const [picked, setPicked] = useState<readonly number[]>(initial);
  const [filter, setFilter] = useState("");

  if (error) {
    return (
      <p className="mt-2 text-sm text-red-600">
        The CCA list could not be loaded. Reload the page.
      </p>
    );
  }
  if (isPending) {
    return <div className="mt-2 h-40 animate-pulse rounded-lg bg-gray-100" />;
  }

  const needle = filter.trim().toLowerCase();
  const shown = ccas.filter(
    (c) =>
      needle === "" ||
      c.ccaName.toLowerCase().includes(needle) ||
      c.category.toLowerCase().includes(needle),
  );
  const toggle = (ccaID: number, on: boolean) =>
    setPicked((prev) =>
      on ? [...prev, ccaID] : prev.filter((id) => id !== ccaID),
    );

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-gray-200 p-3">
      <Input
        aria-label="Filter CCAs"
        placeholder="Filter by name or category"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="h-9"
      />
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {shown.map((c) => {
          const id = `cca-pick-${c.ccaID}`;
          return (
            <li key={c.ccaID} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={picked.includes(c.ccaID)}
                onCheckedChange={(v) => toggle(c.ccaID, v === true)}
              />
              <label htmlFor={id} className="flex-1 text-sm text-gray-800">
                {c.ccaName}
                <span className="ml-2 text-xs text-gray-400">{c.category}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">{picked.length} chosen</span>
        <Button size="sm" disabled={saving} onClick={() => onSave([...picked])}>
          Save CCAs
        </Button>
      </div>
    </div>
  );
}
