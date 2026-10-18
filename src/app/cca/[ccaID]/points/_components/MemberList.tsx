"use client";

import { ChevronDown } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import type { IhgContext } from "~/lib/points/constants";
import type { PointsEntry } from "~/lib/points/entries";
import { ActiveForInfo, ActiveForToggle } from "./ActiveForToggle";
import {
  IhgTick,
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
  /** Null for a non-sport: no IHG column or row at all. */
  ihg: IhgContext | null;
};

const ihgTickHelp = (ihg: IhgContext): string =>
  `Tick the members who get this sport's IHG points.${
    ihg.cap === null ? "" : ` At most ${ihg.cap}.`
  }`;

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
  const { rows, state, disabled, highlightKey, ihg } = props;
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
          <tr>
            <th scope="col" className="px-2 py-2 first:pl-3">
              Member
            </th>
            <th scope="col" className="px-2 py-2 first:pl-3">
              Score (0–20)
            </th>
            <th scope="col" className="px-2 py-2 first:pl-3">
              <span className="inline-flex items-center gap-1">
                Active for
                <ActiveForInfo />
              </span>
            </th>
            {ihg && (
              <th scope="col" className="px-2 py-2 first:pl-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help underline decoration-dotted underline-offset-2">
                      IHG
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs normal-case tracking-normal">
                    {ihgTickHelp(ihg)}
                  </TooltipContent>
                </Tooltip>
              </th>
            )}
            <th scope="col" className="px-2 py-2 pr-3">
              Roles
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((e, i) => (
            <tr
              key={e.rowKey}
              id={rowDomId("table", e.rowKey)}
              data-row-key={e.rowKey}
              className={`align-middle transition-colors ${ring(highlightKey === e.rowKey)}`}
            >
              <td className="px-2 py-2 first:pl-3">
                <p className="font-medium text-gray-900">
                  {e.name ?? "Unknown member"}
                </p>
                <MatricStatus entry={e} />
              </td>
              <td className="px-2 py-2 first:pl-3">
                <Score {...props} i={i} variant="table" />
              </td>
              <td className="px-2 py-2 first:pl-3">
                <ActiveForToggle
                  name={e.name ?? "Member"}
                  semesterOnly={e.semesterOnly}
                  disabled={disabled}
                  onChange={(v) => state.update(e.rowKey, { semesterOnly: v })}
                />
              </td>
              {ihg && (
                <td className="px-2 py-2 first:pl-3">
                  <IhgTick
                    name={e.name ?? "Member"}
                    checked={e.ihg}
                    disabled={disabled}
                    onChange={(on) => state.setIhg(e.rowKey, on)}
                  />
                </td>
              )}
              <td className="px-2 py-2 pr-3">
                {/* Outgoing over incoming, so the table fits beside the summary. */}
                <div className="grid grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-1 text-xs text-gray-500">
                  <span aria-hidden>Out</span>
                  <RoleSelect
                    label={`${e.name ?? "Member"}'s outgoing role`}
                    value={e.outgoingRole}
                    disabled={disabled}
                    onChange={(r) =>
                      state.update(e.rowKey, { outgoingRole: r })
                    }
                  />
                  <span aria-hidden>In</span>
                  <RoleSelect
                    label={`${e.name ?? "Member"}'s incoming role`}
                    value={e.incomingRole}
                    disabled={disabled}
                    onChange={(r) =>
                      state.update(e.rowKey, { incomingRole: r })
                    }
                  />
                </div>
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
  const { rows, state, disabled, highlightKey, ihg } = props;
  return (
    <ul className="space-y-3">
      {rows.map((e, i) => (
        <li
          key={e.rowKey}
          id={rowDomId("card", e.rowKey)}
          data-row-key={e.rowKey}
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
            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
              <span className="inline-flex items-center gap-1">
                Active for
                <ActiveForInfo />
              </span>
              <ActiveForToggle
                big
                name={e.name ?? "Member"}
                semesterOnly={e.semesterOnly}
                disabled={disabled}
                onChange={(v) => state.update(e.rowKey, { semesterOnly: v })}
              />
            </div>
          </div>
          {ihg && (
            <label className="mt-3 flex items-center justify-between gap-3 text-sm text-gray-700">
              IHG points
              <IhgTick
                big
                name={e.name ?? "Member"}
                checked={e.ihg}
                disabled={disabled}
                onChange={(on) => state.setIhg(e.rowKey, on)}
              />
            </label>
          )}
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
