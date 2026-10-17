"use client";

import { useRef, type KeyboardEvent } from "react";
import { Check, Info } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  ACTIVE_FOR_HELP,
  ACTIVE_FOR_OPTIONS,
  activeForAfterKey,
  activeForOf,
  semesterOnlyOf,
  type ActiveFor,
} from "./activeFor";

/** The ⓘ next to "Active for", in the table header and on each card. */
export function ActiveForInfo() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="What does Active for mean?"
          className="rounded-full align-middle text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs normal-case tracking-normal">
        {ACTIVE_FOR_HELP}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Two-option segmented control, built as a radiogroup: only the selected
 * option is in the Tab order, every arrow key switches to (and focuses) the
 * other option, Space or a click selects. Hand-rolled rather than Radix
 * RadioGroup because Radix selects on arrow-key FOCUS, which loses the
 * selection when focus lands after the key is released. The selected option
 * carries a tick and bold text as well as colour.
 */
export function ActiveForToggle({
  name,
  semesterOnly,
  disabled,
  big,
  onChange,
}: {
  /** Member's name, for the group's accessible label. */
  name: string;
  semesterOnly: boolean;
  disabled?: boolean;
  /** Larger touch targets on phone cards. */
  big?: boolean;
  onChange: (semesterOnly: boolean) => void;
}) {
  const value = activeForOf(semesterOnly);
  const refs = useRef<Partial<Record<ActiveFor, HTMLButtonElement | null>>>({});
  const size = big ? "h-10 px-3 text-sm" : "h-8 px-2 text-xs";

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = activeForAfterKey(value, e.key);
    if (!next) return;
    e.preventDefault(); // no page scroll on ↑/↓
    onChange(semesterOnlyOf(next));
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={`${name} active for`}
      aria-disabled={disabled ? true : undefined}
      onKeyDown={onKeyDown}
      className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 shadow-sm"
    >
      {ACTIVE_FOR_OPTIONS.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[o.value] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(semesterOnlyOf(o.value))}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded ${size} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${
              checked
                ? "bg-emerald-600 font-semibold text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            {checked && <Check className="h-3.5 w-3.5" aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
