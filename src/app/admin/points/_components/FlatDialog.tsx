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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  FLAT_POINTS_MAX,
  formatFlatPoints,
  parseFlatPointsText,
} from "~/lib/points/flat";
import { pointsErrorCopy } from "./errorCopy";

export type FlatCca =
  RouterOutputs["ccaPoints"]["getConfig"]["flatCcas"][number];

/**
 * Mark a CCA as flat, or change its value. The CCA is fixed when editing. The
 * number is checked here for a plain-English message and again on the server.
 */
export default function FlatDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The flat CCA being edited, or null to add one. */
  editing: FlatCca | null;
  onSaved: () => Promise<void>;
}) {
  const [cca, setCca] = useState<CcaOption | null>(null);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setCca(null);
    setText(editing ? formatFlatPoints(editing.flatPoints) : "");
  }, [open, editing]);

  const save = api.ccaPoints.setFlat.useMutation({
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
  });

  const ccaID = editing?.ccaID ?? cca?.ccaID ?? null;
  const parsed = parseFlatPointsText(text);
  const problem =
    ccaID === null ? "Choose a CCA" : !parsed.ok ? parsed.message : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!save.isPending) onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit flat points — ${editing.ccaName}`
              : "Add a flat CCA"}
          </DialogTitle>
          <DialogDescription>
            Every member of the CCA gets the same number of points for it. Its
            leaders have nothing to enter.
          </DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (ccaID === null || !parsed.ok) return;
            save.mutate({ ccaID, flatPoints: parsed.value });
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

          <div className="space-y-1.5">
            <Label htmlFor="flat-points">Points each</Label>
            <Input
              id="flat-points"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              disabled={save.isPending}
              aria-invalid={submitted && !parsed.ok ? true : undefined}
              onChange={(e) => {
                setText(e.target.value);
                save.reset();
              }}
            />
            <p
              className={`text-xs ${submitted && !parsed.ok ? "text-red-700" : "text-gray-500"}`}
              role={submitted && !parsed.ok ? "alert" : undefined}
            >
              {submitted && !parsed.ok
                ? parsed.message
                : `From 0 to ${FLAT_POINTS_MAX}, up to 2 decimals.`}
            </p>
          </div>

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
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
