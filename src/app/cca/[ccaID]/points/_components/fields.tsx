"use client";

import { Minus, Plus } from "lucide-react";
import type { KeyboardEvent } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { SCORE_MAX, SCORE_MIN } from "~/lib/points/constants";
import {
  isValidMatric,
  isValidScore,
  type PointsEntry,
  type PointsRole,
} from "~/lib/points/entries";

export type Variant = "table" | "card";

/** DOM hook for keyboard moves between score boxes in the same layout. */
export const scoreInputAttr = (variant: Variant, rowKey: string): string =>
  `${variant}:${rowKey}`;
export const rowDomId = (variant: Variant, rowKey: string): string =>
  `points-row-${variant}-${rowKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;

function focusScore(variant: Variant, rowKey: string | undefined): void {
  if (!rowKey) return;
  const el = document.querySelector<HTMLInputElement>(
    `[data-score-input="${CSS.escape(scoreInputAttr(variant, rowKey))}"]`,
  );
  el?.focus();
  el?.select();
}

export const scoreError = (
  text: string,
  score: number | null,
): string | null =>
  text.trim() === "" || (score !== null && isValidScore(score))
    ? null
    : `Whole number ${SCORE_MIN}–${SCORE_MAX}`;

/**
 * A score box with −/+ steppers. Typing replaces the value (the text is selected
 * on focus); Enter or ↓ moves to the next member, ↑ to the previous one, in the
 * order shown. An invalid value stays visible with an inline error and does not
 * count as scored.
 */
export function ScoreField({
  entry,
  text,
  variant,
  prevKey,
  nextKey,
  disabled,
  onText,
}: {
  entry: PointsEntry;
  text: string;
  variant: Variant;
  prevKey: string | undefined;
  nextKey: string | undefined;
  disabled: boolean;
  onText: (text: string) => void;
}) {
  const error = scoreError(text, entry.basePoints);
  const big = variant === "card";
  const current =
    entry.basePoints !== null && isValidScore(entry.basePoints)
      ? entry.basePoints
      : null;
  const step = (delta: number) => {
    const base = current ?? (delta > 0 ? SCORE_MIN - 1 : SCORE_MAX + 1);
    const next = Math.min(SCORE_MAX, Math.max(SCORE_MIN, base + delta));
    onText(String(next));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      focusScore(variant, nextKey);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusScore(variant, prevKey);
    }
  };
  const btn = `inline-flex shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 ${
    big ? "h-12 w-12" : "h-8 w-8"
  }`;
  const name = entry.name ?? "this member";
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={btn}
          disabled={disabled || current === SCORE_MIN}
          onClick={() => step(-1)}
          aria-label={`Lower ${name}'s score`}
        >
          <Minus className={big ? "h-5 w-5" : "h-4 w-4"} />
        </button>
        <input
          data-score-input={scoreInputAttr(variant, entry.rowKey)}
          inputMode="numeric"
          enterKeyHint="next"
          autoComplete="off"
          aria-label={`Score for ${name}`}
          aria-invalid={error ? true : undefined}
          value={text}
          disabled={disabled}
          placeholder="–"
          onFocus={(e) => e.target.select()}
          onKeyDown={onKeyDown}
          onChange={(e) => onText(e.target.value)}
          className={`rounded-md border text-center tabular-nums shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:bg-gray-50 disabled:text-gray-500 ${
            error ? "border-red-400 bg-red-50" : "border-gray-300"
          } ${big ? "h-12 w-20 text-xl font-semibold" : "h-8 w-14 text-sm"}`}
        />
        <button
          type="button"
          className={btn}
          disabled={disabled || current === SCORE_MAX}
          onClick={() => step(1)}
          aria-label={`Raise ${name}'s score`}
        >
          <Plus className={big ? "h-5 w-5" : "h-4 w-4"} />
        </button>
      </div>
      {error && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const FIX_NO_MATRIC =
  "They need to add their matric number in their RHApp profile, or JCRC can fix it. You can't export until it's there.";
const FIX_BAD_MATRIC =
  "This matric isn't in the A1234567X format. Ask JCRC to fix the roster before you export.";
const FIX_NOT_LINKED =
  "This roster entry doesn't match any account, so it can't be scored for export. Ask JCRC to fix the roster.";

function Chip({ label, help }: { label: string; help: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{help}</TooltipContent>
    </Tooltip>
  );
}

/** The matric, or a red chip explaining why this member blocks the export. */
export function MatricStatus({ entry }: { entry: PointsEntry }) {
  if (!entry.resolved) return <Chip label="Not linked" help={FIX_NOT_LINKED} />;
  if (entry.matric === null)
    return <Chip label="No matric" help={FIX_NO_MATRIC} />;
  if (!isValidMatric(entry.matric))
    return <Chip label="Bad matric" help={FIX_BAD_MATRIC} />;
  return (
    <span className="font-mono text-xs text-gray-600">
      {entry.matric.toUpperCase()}
    </span>
  );
}

const ROLE_LABELS: Record<PointsRole, string> = {
  none: "None",
  head: "Head",
  vice_head: "Vice head",
};

/** A native select: fastest on a phone and fully keyboard-operable. */
export function RoleSelect({
  label,
  value,
  disabled,
  onChange,
  big = false,
}: {
  label: string;
  value: PointsRole;
  disabled: boolean;
  onChange: (role: PointsRole) => void;
  big?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as PointsRole)}
      className={`rounded-md border border-gray-300 bg-white px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:bg-gray-50 disabled:text-gray-500 ${
        big ? "h-11 w-full" : "h-8"
      }`}
    >
      {(Object.keys(ROLE_LABELS) as PointsRole[]).map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </select>
  );
}
