"use client";

import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";

import { Textarea } from "~/components/ui/textarea";
import {
  PASTE_FILE_TYPES,
  pasteFileError,
  UNRESOLVED_COPY,
  type UnresolvedReason,
} from "./auxCopy";

export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-gray-500">{description}</p>
          )}
        </div>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="text-sm text-red-700" role="alert">
      {message}
    </p>
  );
}

export function StatusLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="text-sm text-emerald-700" role="status">
      {message}
    </p>
  );
}

/**
 * A box for pasted matrics, emails or NUSNET ids, one per line, or a CSV
 * whose first column holds them. A picked file is read in the browser into the
 * box, so what is sent is always what JCRC can see.
 */
export function PasteBox({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [fileError, setFileError] = useState<string | null>(null);

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const tooBig = pasteFileError(file);
    setFileError(tooBig);
    if (tooBig) return;
    try {
      onChange(await file.text());
    } catch {
      setFileError("Couldn’t read that file.");
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-gray-800">
          {label}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1 rounded text-xs font-medium text-gray-700 underline underline-offset-2 focus-within:ring-2 focus-within:ring-gray-400 hover:text-gray-900">
          <Upload className="h-3.5 w-3.5" aria-hidden />
          Use a CSV file
          <input
            type="file"
            accept={PASTE_FILE_TYPES}
            className="sr-only"
            disabled={disabled}
            onChange={(e) => void pick(e)}
          />
        </label>
      </div>
      <Textarea
        id={id}
        rows={5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"A0123456X\ne0123456@u.nus.edu"}
        className="font-mono text-xs"
      />
      <p className="text-xs text-gray-500">{hint}</p>
      <ErrorLine message={fileError} />
    </div>
  );
}

/** Lines that named nobody, listed back by line number so JCRC can fix them. */
export function UnresolvedList({
  lines,
}: {
  lines: readonly { line: number; raw: string; reason?: UnresolvedReason }[];
}) {
  if (lines.length === 0) return null;
  return (
    <div
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      role="alert"
    >
      <p className="font-medium">
        {lines.length === 1 ? "1 line was" : `${lines.length} lines were`} not
        added:
      </p>
      <ul className="mt-1 space-y-0.5">
        {lines.map((l) => (
          <li key={`${l.line}-${l.raw}`}>
            Line {l.line}: <span className="font-mono">{l.raw}</span>
            {l.reason
              ? ` (${UNRESOLVED_COPY[l.reason]})`
              : " (not a whole number from 1 to 20)"}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A matric or name cell: never more than the screen needs. */
export function PersonCell({
  name,
  matric,
}: {
  name: string | null;
  matric: string | null;
}) {
  return (
    <span>
      <span className="text-gray-900">{name ?? "Unknown resident"}</span>
      {matric && (
        <span className="ml-2 font-mono text-xs text-gray-500">{matric}</span>
      )}
    </span>
  );
}
