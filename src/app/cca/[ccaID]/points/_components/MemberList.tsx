"use client";

import { ChevronDown } from "lucide-react";

import { Checkbox } from "~/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Switch } from "~/components/ui/switch";
import type { PointsEntry } from "~/lib/points/entries";
import {
  MatricStatus,
  RoleSelect,
  ScoreField,
  rowDomId,
  type Variant,
} from "./fields";
import type { PointsState } from "./usePointsEntries";

type ListProps = {
  rows: PointsEntry[];
  state: PointsState;
  disabled: boolean;
  highlightKey: string | null;
};

const ring = (on: boolean): string =>
  on ? "bg-amber-50 ring-2 ring-inset ring-amber-400" : "";

function neighbours(rows: PointsEntry[], i: number) {
  return { prevKey: rows[i - 1]?.rowKey, nextKey: rows[i + 1]?.rowKey };
}

function Score({
  rows,
  i,
  variant,
  state,
  disabled,
}: ListProps & { i: number; variant: Variant }) {
  const entry = rows[i]!;
  return (
    <ScoreField
      entry={entry}
      text={state.texts[entry.rowKey] ?? ""}
      variant={variant}
      disabled={disabled}
      onText={(t) => state.setScoreText(entry.rowKey, t)}
      {...neighbours(rows, i)}
    />
  );
}

/** Desktop: one table row per member. */
export function MemberTable(props: ListProps) {
  const { rows, state, disabled, highlightKey } = props;
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
          <tr>
            <th scope="col" className="px-3 py-2">
              Name
            </th>
            <th scope="col" className="px-3 py-2">
              Matric
            </th>
            <th scope="col" className="px-3 py-2">
              Score (0–20)
            </th>
            <th scope="col" className="px-3 py-2">
              Sem-only
            </th>
            <th scope="col" className="px-3 py-2">
              Outgoing
            </th>
            <th scope="col" className="px-3 py-2">
              Incoming
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((e, i) => (
            <tr
              key={e.rowKey}
              id={rowDomId("table", e.rowKey)}
              className={`align-top transition-colors ${ring(highlightKey === e.rowKey)}`}
            >
              <td className="px-3 py-2 font-medium text-gray-900">
                {e.name ?? "Unknown member"}
              </td>
              <td className="px-3 py-2">
                <MatricStatus entry={e} />
              </td>
              <td className="px-3 py-2">
                <Score {...props} i={i} variant="table" />
              </td>
              <td className="px-3 py-2">
                <Checkbox
                  aria-label={`${e.name ?? "Member"} is semester-only`}
                  checked={e.semesterOnly}
                  disabled={disabled}
                  onCheckedChange={(v) =>
                    state.update(e.rowKey, { semesterOnly: v === true })
                  }
                />
              </td>
              <td className="px-3 py-2">
                <RoleSelect
                  label={`${e.name ?? "Member"}'s outgoing role`}
                  value={e.outgoingRole}
                  disabled={disabled}
                  onChange={(r) => state.update(e.rowKey, { outgoingRole: r })}
                />
              </td>
              <td className="px-3 py-2">
                <RoleSelect
                  label={`${e.name ?? "Member"}'s incoming role`}
                  value={e.incomingRole}
                  disabled={disabled}
                  onChange={(r) => state.update(e.rowKey, { incomingRole: r })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mobile: one card per member, big targets, roles tucked away. */
export function MemberCards(props: ListProps) {
  const { rows, state, disabled, highlightKey } = props;
  return (
    <ul className="space-y-3">
      {rows.map((e, i) => (
        <li
          key={e.rowKey}
          id={rowDomId("card", e.rowKey)}
          className={`rounded-lg border border-gray-200 bg-white p-3 transition-colors ${ring(highlightKey === e.rowKey)}`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-words font-medium text-gray-900">
              {e.name ?? "Unknown member"}
            </p>
            <MatricStatus entry={e} />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Score {...props} i={i} variant="card" />
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <Switch
                checked={e.semesterOnly}
                disabled={disabled}
                onCheckedChange={(v) =>
                  state.update(e.rowKey, { semesterOnly: v })
                }
                aria-label={`${e.name ?? "Member"} is semester-only`}
              />
              Semester-only
            </label>
          </div>
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md py-2 text-sm text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
              <span>
                Roles: out{" "}
                {e.outgoingRole === "none"
                  ? "—"
                  : e.outgoingRole.replace("_", " ")}{" "}
                · in{" "}
                {e.incomingRole === "none"
                  ? "—"
                  : e.incomingRole.replace("_", " ")}
              </span>
              <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="grid grid-cols-2 gap-2 pt-1">
              <RoleSelect
                big
                label={`${e.name ?? "Member"}'s outgoing role`}
                value={e.outgoingRole}
                disabled={disabled}
                onChange={(r) => state.update(e.rowKey, { outgoingRole: r })}
              />
              <RoleSelect
                big
                label={`${e.name ?? "Member"}'s incoming role`}
                value={e.incomingRole}
                disabled={disabled}
                onChange={(r) => state.update(e.rowKey, { incomingRole: r })}
              />
            </CollapsibleContent>
          </Collapsible>
        </li>
      ))}
    </ul>
  );
}
