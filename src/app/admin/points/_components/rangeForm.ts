import { MEAN_LIMITS, SD_LIMITS, type Range } from "~/lib/points/constants";
import {
  fillRange,
  rangeProblem,
  type RangeOverride,
} from "~/lib/points/meanSd";

export type RangeField = keyof Range;

export const RANGE_FIELDS: readonly RangeField[] = [
  "meanMin",
  "meanMax",
  "sdMin",
  "sdMax",
];

export type FormValues = Record<RangeField, string>;

export type ParsedForm = {
  values: Record<RangeField, number | null>;
  fieldErrors: Partial<Record<RangeField, string>>;
  /** A problem with the form as a whole (e.g. a minimum above its maximum). */
  formError: string | null;
  ok: boolean;
};

const NUMBER = /^\d+(\.\d+)?$/;

const limitsOf = (field: RangeField): readonly [number, number] =>
  field.startsWith("mean") ? MEAN_LIMITS : SD_LIMITS;

export function toFormValues(range: RangeOverride): FormValues {
  const text = (n: number | null | undefined): string =>
    n === null || n === undefined ? "" : String(n);
  return {
    meanMin: text(range.meanMin),
    meanMax: text(range.meanMax),
    sdMin: text(range.sdMin),
    sdMax: text(range.sdMax),
  };
}

function parseField(
  raw: string,
  field: RangeField,
  allowBlank: boolean,
): { value: number | null; error?: string } {
  const text = raw.trim();
  if (text === "") {
    return allowBlank ? { value: null } : { value: null, error: "Required" };
  }
  if (!NUMBER.test(text)) return { value: null, error: "Enter a number" };
  const value = Number(text);
  const [min, max] = limitsOf(field);
  if (value < min || value > max) {
    return { value: null, error: `Between ${min} and ${max}` };
  }
  return { value };
}

/**
 * Turns the text boxes into numbers, with plain-English problems per field and
 * for the form as a whole. For a waiver (`allowBlank`) a blank field means "use
 * the default", and min ≤ max is judged AFTER that fallback, matching the server.
 */
export function parseRangeForm(
  raw: FormValues,
  opts: { allowBlank: boolean; fallback: Readonly<Range> },
): ParsedForm {
  const values = {
    meanMin: null,
    meanMax: null,
    sdMin: null,
    sdMax: null,
  } as Record<RangeField, number | null>;
  const fieldErrors: Partial<Record<RangeField, string>> = {};
  for (const field of RANGE_FIELDS) {
    const parsed = parseField(raw[field], field, opts.allowBlank);
    values[field] = parsed.value;
    if (parsed.error) fieldErrors[field] = parsed.error;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { values, fieldErrors, formError: null, ok: false };
  }
  if (opts.allowBlank && RANGE_FIELDS.every((f) => values[f] === null)) {
    return {
      values,
      fieldErrors,
      formError: "Fill in at least one field, or the waiver changes nothing.",
      ok: false,
    };
  }
  const formError = rangeProblem(fillRange(values, opts.fallback));
  return { values, fieldErrors, formError, ok: formError === null };
}
