"use client";

import { useId } from "react";

import { Input } from "~/components/ui/input";
import {
  AUX_AWARD_MAX,
  AUX_AWARD_MIN,
  AUX_REASON_PRESETS,
  AUX_TEXT_MAX,
  isValidAuxAmount,
} from "~/lib/auxPoints";

export type AwardDraft = { amount: string; reason: string; awardedOn: string };

/** The draft as the server wants it, or null while something is missing. */
export function awardInput(
  d: AwardDraft,
): { amount: number; reason: string; awardedOn: string } | null {
  const amount = Number(d.amount);
  const reason = d.reason.trim();
  if (!/^\d+$/.test(d.amount.trim()) || !isValidAuxAmount(amount)) return null;
  if (reason.length === 0 || reason.length > AUX_TEXT_MAX) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.awardedOn)) return null;
  return { amount, reason, awardedOn: d.awardedOn };
}

/** Amount, reason (with one-tap presets such as fire warden) and date. */
export function AwardFields({
  draft,
  onChange,
  disabled,
  showAmount = true,
}: {
  draft: AwardDraft;
  onChange: (next: AwardDraft) => void;
  disabled?: boolean;
  showAmount?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<AwardDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-[6rem_1fr_10rem]">
      {showAmount && (
        <div className="space-y-1">
          <label
            htmlFor={`${id}-amount`}
            className="text-sm font-medium text-gray-800"
          >
            AUX
          </label>
          <Input
            id={`${id}-amount`}
            inputMode="numeric"
            value={draft.amount}
            disabled={disabled}
            onChange={(e) => set({ amount: e.target.value })}
            aria-describedby={`${id}-amount-hint`}
          />
          <p id={`${id}-amount-hint`} className="text-xs text-gray-500">
            {AUX_AWARD_MIN}–{AUX_AWARD_MAX}
          </p>
        </div>
      )}
      <div className={`space-y-1 ${showAmount ? "" : "sm:col-span-2"}`}>
        <label
          htmlFor={`${id}-reason`}
          className="text-sm font-medium text-gray-800"
        >
          Reason
        </label>
        <Input
          id={`${id}-reason`}
          value={draft.reason}
          maxLength={AUX_TEXT_MAX}
          disabled={disabled}
          onChange={(e) => set({ reason: e.target.value })}
        />
        <div className="flex flex-wrap gap-1.5">
          {AUX_REASON_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={disabled}
              onClick={() => set({ reason: preset })}
              aria-pressed={draft.reason === preset}
              className="rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 aria-pressed:border-gray-900 aria-pressed:bg-gray-900 aria-pressed:text-white"
            >
              {preset}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <label
          htmlFor={`${id}-date`}
          className="text-sm font-medium text-gray-800"
        >
          Date
        </label>
        <Input
          id={`${id}-date`}
          type="date"
          value={draft.awardedOn}
          disabled={disabled}
          onChange={(e) => set({ awardedOn: e.target.value })}
        />
      </div>
    </div>
  );
}
