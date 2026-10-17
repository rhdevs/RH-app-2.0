"use client";

import { useId } from "react";

import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { MEAN_LIMITS, SD_LIMITS, type Range } from "~/lib/points/constants";
import { RANGE_FIELDS, type FormValues, type RangeField } from "./rangeForm";

const LABELS: Record<RangeField, string> = {
  meanMin: "Average, lowest",
  meanMax: "Average, highest",
  sdMin: "Spread (SD), lowest",
  sdMax: "Spread (SD), highest",
};

/**
 * The four range boxes with inline validation. In waiver mode a blank box shows
 * the value it will fall back to as its placeholder, so "blank = use the
 * default" is visible rather than a thing to remember.
 */
export default function RangeInputs({
  values,
  errors,
  onChange,
  disabled,
  placeholders,
}: {
  values: FormValues;
  errors: Partial<Record<RangeField, string>>;
  onChange: (next: FormValues) => void;
  disabled?: boolean;
  /** Shown when a box is blank (waiver mode). */
  placeholders?: Readonly<Range>;
}) {
  const baseId = useId();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {RANGE_FIELDS.map((field) => {
        const id = `${baseId}-${field}`;
        const [min, max] = field.startsWith("mean") ? MEAN_LIMITS : SD_LIMITS;
        const error = errors[field];
        return (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={id}>{LABELS[field]}</Label>
            <Input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              value={values[field]}
              disabled={disabled}
              placeholder={
                placeholders ? `Default: ${placeholders[field]}` : undefined
              }
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-help`}
              onChange={(e) => onChange({ ...values, [field]: e.target.value })}
            />
            <p
              id={`${id}-help`}
              className={`text-xs ${error ? "text-red-700" : "text-gray-500"}`}
              role={error ? "alert" : undefined}
            >
              {error ?? `From ${min} to ${max}`}
            </p>
          </div>
        );
      })}
    </div>
  );
}
