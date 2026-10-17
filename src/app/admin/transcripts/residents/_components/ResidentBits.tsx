"use client";

import { Loader2 } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { counterText } from "~/lib/transcript/headView";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

/** What every section of the resident panel is given. */
export interface SectionProps {
  userID: string;
  academicYear: string;
  /** False for a published year until the resident is unlocked. */
  editable: boolean;
  /** Reports unsaved typing, by name, so leaving can be confirmed. */
  onDirty: (name: string, dirty: boolean) => void;
}

/** Tell the panel while this part holds unsaved typing; clear it on unmount. */
export function useReportDirty(
  name: string,
  dirty: boolean,
  onDirty: (name: string, dirty: boolean) => void,
) {
  useEffect(() => {
    onDirty(name, dirty);
  }, [name, dirty, onDirty]);
  useEffect(() => () => onDirty(name, false), [name, onDirty]);
}

export const REASON_MAX = 500;
export const REASON_MIN = 3;

export interface ReasonDialogCopy {
  title: string;
  description: string;
  reasonLabel: string;
  confirm: string;
}

/**
 * A confirmation that asks for a reason (required) or a note (optional). The
 * words are passed in, so the same dialog serves unlock, relock, withhold and
 * release.
 */
export function ReasonDialogView({
  copy,
  open,
  required,
  reason,
  onReason,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  copy: ReasonDialogCopy;
  open: boolean;
  required: boolean;
  reason: string;
  onReason: (reason: string) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const returnFocus = useReturnFocus();
  const ok = !required || reason.trim().length >= REASON_MIN;
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div>
          <label htmlFor="resident-reason" className={FIELD_LABEL}>
            {copy.reasonLabel}
          </label>
          <Textarea
            id="resident-reason"
            rows={3}
            value={reason}
            maxLength={REASON_MAX}
            disabled={pending}
            onChange={(e) => onReason(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(reason, REASON_MAX)}
          </p>
        </div>
        <ErrorLine message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button type="button" onClick={onConfirm} disabled={pending || !ok}>
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Working
              </>
            ) : (
              copy.confirm
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A small heading inside a section. */
export function SubHeading({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <h3 id={id} className="mb-3 text-sm font-semibold text-gray-900">
      {children}
    </h3>
  );
}

/** A small word tag ("Manual", "Removed"): the state is in the words. */
export function Tag({
  children,
  tone = "gray",
}: {
  children: ReactNode;
  tone?: "gray" | "amber" | "emerald";
}) {
  const colours = {
    gray: "border-gray-300 bg-gray-50 text-gray-700",
    amber: "border-amber-300 bg-amber-50 text-amber-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${colours}`}
    >
      {children}
    </span>
  );
}

/** A save button with its busy state. */
export function SaveButton({
  pending,
  disabled,
  label = "Save",
  onClick,
}: {
  pending: boolean;
  disabled?: boolean;
  label?: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      disabled={(disabled ?? false) || pending}
      onClick={onClick}
    >
      {pending ? (
        <>
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          Saving
        </>
      ) : (
        label
      )}
    </Button>
  );
}

/** A loading placeholder. */
export function Loading({ rows = 1 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-200" />
      ))}
    </div>
  );
}

/** The class for a card holding one record. */
export const RECORD_CARD = "rounded-lg border border-gray-200 p-4";

/** A plain select, like the neighbouring inputs. */
export const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

/** Fields of a record wrap by the card's own width, not the window's. */
export const FIELD_GRID =
  "grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]";
