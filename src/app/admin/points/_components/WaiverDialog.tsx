"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import CcaPicker, {
  type CcaOption,
} from "~/app/admin/_components/bulk/CcaPicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import type { Range } from "~/lib/points/constants";
import { pointsErrorCopy } from "./errorCopy";
import RangeInputs from "./RangeInputs";
import { parseRangeForm, toFormValues, type FormValues } from "./rangeForm";

export type Waiver =
  RouterOutputs["ccaPoints"]["getConfig"]["overrides"][number];

const NOTE_MAX = 500;
const EMPTY: FormValues = { meanMin: "", meanMax: "", sdMin: "", sdMax: "" };

/**
 * Add or edit one CCA's waiver. A blank box means "keep following the default"
 * for that field, and the placeholder shows what that default is today. The
 * note is required: a waiver with no reason is a number nobody can defend later.
 */
export default function WaiverDialog({
  open,
  onOpenChange,
  editing,
  effectiveDefault,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The waiver being edited, or null to add a new one. */
  editing: Waiver | null;
  effectiveDefault: Range;
  onSaved: () => Promise<void>;
}) {
  const [cca, setCca] = useState<CcaOption | null>(null);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Fresh state each time the dialog opens, seeded from the waiver being edited.
  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setCca(null);
    setValues(editing ? toFormValues(editing) : EMPTY);
    setNote(editing?.note ?? "");
  }, [open, editing]);

  const save = api.ccaPoints.setOverride.useMutation({
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
  });

  const ccaID = editing?.ccaID ?? cca?.ccaID ?? null;
  const parsed = parseRangeForm(values, {
    allowBlank: true,
    fallback: effectiveDefault,
  });
  const noteProblem = note.trim() === "" ? "A note is required" : null;
  const problem =
    ccaID === null ? "Choose a CCA" : (parsed.formError ?? noteProblem);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!save.isPending) onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit waiver — ${editing.ccaName}` : "Add a waiver"}
          </DialogTitle>
          <DialogDescription>
            Change the allowed ranges for one CCA. Leave a box blank to keep
            following the default for that field.
          </DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (!parsed.ok || ccaID === null || noteProblem) return;
            save.mutate({ ccaID, ...parsed.values, note: note.trim() });
          }}
        >
          {!editing && (
            <div className="space-y-1.5">
              <Label>CCA</Label>
              <CcaPicker value={cca?.ccaID ?? null} onChange={setCca} />
              {submitted && ccaID === null && (
                <p className="text-xs text-red-700" role="alert">
                  Choose a CCA
                </p>
              )}
            </div>
          )}

          <RangeInputs
            values={values}
            errors={submitted ? parsed.fieldErrors : {}}
            placeholders={effectiveDefault}
            disabled={save.isPending}
            onChange={(next) => {
              setValues(next);
              save.reset();
            }}
          />

          <div className="space-y-1.5">
            <Label htmlFor="waiver-note">Why this CCA is waived</Label>
            <Textarea
              id="waiver-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={save.isPending}
              maxLength={NOTE_MAX}
              rows={3}
              placeholder="e.g. Performing group; scores are naturally closer together"
            />
            <p
              className={`text-xs ${submitted && noteProblem ? "text-red-700" : "text-gray-500"}`}
              role={submitted && noteProblem ? "alert" : undefined}
            >
              {submitted && noteProblem
                ? noteProblem
                : `Required. Saved to the audit log. ${note.length}/${NOTE_MAX}`}
            </p>
          </div>

          {submitted && parsed.formError && (
            <p className="text-sm text-red-700" role="alert">
              {parsed.formError}
            </p>
          )}
          {save.error && (
            <p className="text-sm text-red-700" role="alert">
              {pointsErrorCopy(save.error.message, save.error.data?.code)}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || (submitted && problem !== null)}
            >
              {save.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save waiver"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
