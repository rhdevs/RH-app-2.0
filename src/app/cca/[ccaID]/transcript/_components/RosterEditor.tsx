"use client";

import { Check, Loader2 } from "lucide-react";
import { useRef, useState } from "react";

import { ErrorLine } from "~/app/admin/transcripts/_components/Bits";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import type { Duration } from "~/lib/transcript/duration";
import {
  EXTRA_MAX,
  ROLE_MAX,
  counterText,
  draftOf,
  durationOptions,
  isDirty,
  reconcileAfterSave,
  rowProblem,
  upsertFields,
  type DurationChoice,
  type RowDraft,
} from "~/lib/transcript/headView";
import { api } from "~/trpc/react";

export interface RosterRowData {
  userID: string;
  displayName: string | null;
  isHead: boolean;
  defaultDuration: Duration | null;
  duration: string | null;
  defaultRoleLabel: string | null;
  roleLabel: string | null;
  defaultRoleDuration: Duration | null;
  roleDuration: string | null;
  extraContribution: string | null;
}

export interface RosterRowViewProps {
  row: RosterRowData;
  draft: RowDraft;
  onDraft: (patch: Partial<RowDraft>) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  error: string | null;
  readOnly: boolean;
}

/** A real table header cell: not `block`, so the header row lines up with the columns. */
const TH_CELL = "px-3 py-2 text-left text-xs font-medium text-gray-700";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

function DurationSelect({
  id,
  label,
  value,
  computedDefault,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: DurationChoice;
  computedDefault: Duration | null;
  disabled: boolean;
  onChange: (v: DurationChoice) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as DurationChoice)}
        className={SELECT}
      >
        {durationOptions(computedDefault).map((o) => (
          <option key={o.value || "default"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** One member's row. Presentational: the container owns the draft and the save. */
export function RosterRowView(p: RosterRowViewProps) {
  const { row, draft } = p;
  const key = row.userID;
  const name = row.displayName ?? row.userID;
  const saved = draftOf(row);
  const dirty = isDirty(draft, saved);
  const problem = rowProblem(draft);
  const hasRole =
    draft.roleLabel.trim() !== "" || row.defaultRoleLabel !== null;

  return (
    <tr className="align-top">
      <td className="px-3 py-3 text-sm font-medium text-gray-900">
        {name}
        {row.isHead && (
          <span className="ml-2 text-xs font-normal text-gray-500">Head</span>
        )}
      </td>
      <td className="min-w-[10rem] px-3 py-3">
        <DurationSelect
          id={`duration-${key}`}
          label={`Duration for ${name}`}
          value={draft.duration}
          computedDefault={row.defaultDuration}
          disabled={p.readOnly}
          onChange={(v) => p.onDraft({ duration: v })}
        />
      </td>
      <td className="min-w-[11rem] px-3 py-3">
        <label htmlFor={`role-${key}`} className="sr-only">
          {`Role for ${name}`}
        </label>
        <Input
          id={`role-${key}`}
          value={draft.roleLabel}
          maxLength={ROLE_MAX}
          disabled={p.readOnly}
          placeholder={
            row.defaultRoleLabel
              ? `Default: ${row.defaultRoleLabel}`
              : "Leave blank for member"
          }
          onChange={(e) => p.onDraft({ roleLabel: e.target.value })}
        />
      </td>
      <td className="min-w-[10rem] px-3 py-3">
        {hasRole && (
          <DurationSelect
            id={`roleDuration-${key}`}
            label={`Role period for ${name}`}
            value={draft.roleDuration}
            computedDefault={row.defaultRoleDuration}
            disabled={p.readOnly}
            onChange={(v) => p.onDraft({ roleDuration: v })}
          />
        )}
      </td>
      <td className="min-w-[16rem] px-3 py-3">
        <label htmlFor={`extra-${key}`} className="sr-only">
          {`Additional contribution for ${name}`}
        </label>
        <Textarea
          id={`extra-${key}`}
          rows={2}
          value={draft.extra}
          maxLength={EXTRA_MAX}
          disabled={p.readOnly}
          onChange={(e) => p.onDraft({ extra: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(draft.extra, EXTRA_MAX)}
        </p>
        <ErrorLine message={problem ?? p.error} />
      </td>
      <td className="px-3 py-3">
        {!p.readOnly && (
          <div className="flex flex-col items-start gap-1">
            <Button
              type="button"
              size="sm"
              disabled={!dirty || p.saving || problem !== null}
              onClick={p.onSave}
            >
              {p.saving ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
            {p.saved && !dirty && (
              <span
                className="inline-flex items-center gap-1 text-xs text-emerald-700"
                role="status"
              >
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

export interface RosterTableViewProps {
  rows: React.ReactNode;
  count: number;
}

export function RosterTableView({ rows, count }: RosterTableViewProps) {
  if (count === 0) {
    return (
      <p className="text-sm text-gray-500">
        This CCA has no members to list yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] divide-y divide-gray-200 text-left">
        <thead>
          <tr>
            {[
              "Name",
              "Duration",
              "Role",
              "Role period",
              "Additional contribution",
              "",
            ].map((h, i) => (
              <th key={h || `action-${i}`} scope="col" className={TH_CELL}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{rows}</tbody>
      </table>
    </div>
  );
}

/** Wires one row to roster.upsert. The parent keys it by year and member. */
export function RosterRow({
  ccaID,
  academicYear,
  row,
  readOnly,
}: {
  ccaID: number;
  academicYear: string;
  row: RosterRowData;
  readOnly: boolean;
}) {
  const utils = api.useUtils();
  const [draft, setDraft] = useState<RowDraft>(() => draftOf(row));
  const [saved, setSaved] = useState(false);
  // What was sent, to tell whether more was typed while it was saving.
  const submitted = useRef<RowDraft>(draft);

  const upsert = api.transcriptManage.roster.upsert.useMutation({
    onSuccess: async (stored) => {
      // Keep showing what was saved, as the server stored it.
      setDraft((current) =>
        reconcileAfterSave(
          current,
          submitted.current,
          draftOf(stored),
          (a, b) => !isDirty(a, b),
        ),
      );
      setSaved(true);
      await utils.transcriptManage.roster.list.invalidate();
    },
  });

  const zod = upsert.error?.data?.zodError ?? null;
  const error = upsert.error
    ? (fieldError(zod, "roleLabel") ??
      fieldError(zod, "extraContribution") ??
      errorText(upsert.error.message))
    : null;

  return (
    <RosterRowView
      row={row}
      draft={draft}
      onDraft={(patch) => {
        setDraft((d) => ({ ...d, ...patch }));
        setSaved(false);
        upsert.reset();
      }}
      onSave={() => {
        submitted.current = draft;
        upsert.mutate({
          ccaID,
          academicYear,
          userID: row.userID,
          ...upsertFields(draft),
        });
      }}
      saving={upsert.isPending}
      saved={saved}
      error={error}
      readOnly={readOnly}
    />
  );
}
