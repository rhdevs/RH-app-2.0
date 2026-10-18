"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import type { Range } from "~/lib/points/constants";
import { pointsErrorCopy } from "./errorCopy";
import RangeInputs from "./RangeInputs";
import { parseRangeForm, toFormValues, type FormValues } from "./rangeForm";
import {
  saveStatus,
  statusClass,
  statusVisible,
  type SaveStatus,
} from "./saveStatus";

/**
 * The hall-wide default allowed ranges. All four fields are required here; a
 * CCA with a waiver overrides individual fields of THIS (see WaiversPanel).
 * Shows "Built-in default" until JCRC has saved a row of their own.
 */
export default function DefaultRangesForm({
  effective,
  hasRow,
  builtIn,
  onChanged,
}: {
  /** What applies today: the stored row with blanks filled from the built-in. */
  effective: Range;
  /** False until JCRC has saved a default row of their own. */
  hasRow: boolean;
  builtIn: Range;
  onChanged: () => Promise<boolean>;
}) {
  const current = effective;
  const [values, setValues] = useState<FormValues>(() => toFormValues(current));
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState<SaveStatus | null>(null);

  // Re-sync when the server value changes (after a save, or a refetch).
  const key = JSON.stringify(current);
  useEffect(() => {
    setValues(toFormValues(JSON.parse(key) as Range));
  }, [key]);

  const parsed = parseRangeForm(values, {
    allowBlank: false,
    fallback: builtIn,
  });
  const dirty =
    JSON.stringify(values) !== JSON.stringify(toFormValues(current));

  const save = api.ccaPoints.setDefault.useMutation({
    onSuccess: async () => {
      setSubmitted(false);
      const reloaded = await onChanged();
      setSaved(
        saveStatus(
          "Saved. Heads see the new ranges the next time they open their page.",
          reloaded,
        ),
      );
    },
  });

  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900">Default ranges</h3>
        {!hasRow && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
            Built-in default
          </span>
        )}
      </div>
      <p className="mb-5 max-w-3xl text-xs text-gray-500">
        What every CCA&rsquo;s scores are judged against: the average and the
        spread (population standard deviation) of everyone&rsquo;s full scores.
        Edges are inclusive. A waiver below can change these for one CCA.
      </p>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setSaved(null);
          if (!parsed.ok) return;
          save.mutate({
            meanMin: parsed.values.meanMin ?? builtIn.meanMin,
            meanMax: parsed.values.meanMax ?? builtIn.meanMax,
            sdMin: parsed.values.sdMin ?? builtIn.sdMin,
            sdMax: parsed.values.sdMax ?? builtIn.sdMax,
          });
        }}
        className="space-y-4"
      >
        <RangeInputs
          values={values}
          errors={submitted || dirty ? parsed.fieldErrors : {}}
          disabled={save.isPending}
          onChange={(next) => {
            setValues(next);
            setSaved(null);
            save.reset();
          }}
        />
        {(submitted || dirty) && parsed.formError && (
          <p className="text-sm text-red-700" role="alert">
            {parsed.formError}
          </p>
        )}
        {save.error && (
          <p className="text-sm text-red-700" role="alert">
            {pointsErrorCopy(save.error.message, save.error.data?.code)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={save.isPending || (!dirty && hasRow)}>
            {save.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save default ranges"
            )}
          </Button>
          {saved && statusVisible(saved, dirty) && (
            <p className={`text-sm ${statusClass(saved)}`} role="status">
              {saved.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
