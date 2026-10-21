"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { parseCsv } from "~/app/admin/_lib/csv";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { Textarea } from "~/components/ui/textarea";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import {
  COLUMN_LABEL,
  IMPORT_CHUNK_SIZE,
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  STATUS_LABEL,
  TEMPLATE_CSV,
  TEMPLATE_FILE_NAME,
  TOO_MANY_ROWS_MESSAGE,
  canCreate,
  guessMapping,
  importButtonLabel,
  importSummaryLine,
  latestOnly,
  looksLikeHeader,
  mappingProblem,
  previewSummaryLine,
  rowsFromTable,
  undecided,
  unknownNames,
  type ClassifiedRow,
  type Decision,
  type ImportColumn,
  type ImportRow,
  type RowStatus,
  type UnknownName,
} from "~/lib/transcript/awardImport";
import {
  rosterLayoutFor,
  useContainerWidth,
  type RosterLayout,
} from "~/lib/transcript/useContainerWidth";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";

/* ---- shapes the views take ----------------------------------------------------- */

export interface ImportPreviewData {
  rows: ClassifiedRow[];
  counts: Record<RowStatus, number>;
  unknown: UnknownName[];
  types: Array<{ id: string; name: string; archived: boolean }>;
  archivedTypes: Array<{ id: string; name: string; archived: boolean }>;
}

export interface ImportResult {
  batchId: string;
  imported: number;
  skipped: Array<{
    row: number;
    identifier: string;
    award: string;
    reason: string;
  }>;
  created: string[];
}

const STATUS_CLASS: Record<RowStatus, string> = {
  ready: "border-emerald-600 bg-emerald-50 text-emerald-900",
  not_found: "border-amber-600 bg-amber-50 text-amber-900",
  duplicate: "border-gray-400 bg-gray-100 text-gray-800",
  invalid: "border-red-600 bg-red-50 text-red-900",
};

/** A status in words as well as colour. */
export function StatusChip({ status }: { status: RowStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ---- step 1: the file ----------------------------------------------------------- */

export interface ImportInputViewProps {
  text: string;
  onText: (text: string) => void;
  fileName: string | null;
  onFile: (file: File) => void;
  onDownloadTemplate: () => void;
  onContinue: () => void;
  readOnly: boolean;
  error: string | null;
}

export function ImportInputView(p: ImportInputViewProps) {
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-gray-600">
        Upload a CSV with one award per row: the person&rsquo;s NUS email or
        NUSNET id, the award, and optionally a citation. You check every row
        before anything is saved.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={p.onDownloadTemplate}
        >
          Download template
        </Button>
        <div>
          <label htmlFor="award-csv-file" className={FIELD_LABEL}>
            Upload a .csv file
          </label>
          <input
            id="award-csv-file"
            type="file"
            accept=".csv,text/csv"
            disabled={p.readOnly}
            className="block text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onFile(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <div>
        <label htmlFor="award-csv-text" className={FIELD_LABEL}>
          Or paste the rows
          {p.fileName ? ` (from ${p.fileName})` : ""}
        </label>
        <Textarea
          id="award-csv-text"
          rows={6}
          value={p.text}
          disabled={p.readOnly}
          placeholder="identifier,award,citation"
          onChange={(e) => p.onText(e.target.value)}
        />
      </div>
      <ErrorLine message={p.error} />
      <Button
        type="button"
        disabled={p.readOnly || p.text.trim() === ""}
        onClick={p.onContinue}
      >
        Continue
      </Button>
    </div>
  );
}

/* ---- step 2: map the columns ----------------------------------------------------- */

export interface ImportMapViewProps {
  table: string[][];
  hasHeader: boolean;
  onHasHeader: (value: boolean) => void;
  mapping: ImportColumn[];
  onMapping: (next: ImportColumn[]) => void;
  rowCount: number;
  onBack: () => void;
  onPreview: () => void;
  previewing: boolean;
  error: string | null;
}

export function ImportMapView(p: ImportMapViewProps) {
  const headers = p.hasHeader
    ? (p.table[0] ?? [])
    : (p.table[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const sample = p.table.slice(p.hasHeader ? 1 : 0, (p.hasHeader ? 1 : 0) + 5);
  const problem = mappingProblem(p.mapping);
  const tooMany = p.rowCount > MAX_IMPORT_ROWS;
  return (
    <div className="space-y-4">
      <label className="inline-flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={p.hasHeader}
          onChange={(e) => p.onHasHeader(e.target.checked)}
        />
        The first row is a heading
      </label>
      <div className="relative overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              {headers.map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  className="min-w-[10rem] px-3 py-2 align-top"
                >
                  <p className="mb-1 truncate text-xs font-medium text-gray-500">
                    {h || `Column ${i + 1}`}
                  </p>
                  <label htmlFor={`map-${i}`} className="sr-only">
                    {`What column ${i + 1} holds`}
                  </label>
                  <select
                    id={`map-${i}`}
                    value={p.mapping[i] ?? "ignore"}
                    onChange={(e) => {
                      const next = [...p.mapping];
                      next[i] = e.target.value as ImportColumn;
                      p.onMapping(next);
                    }}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {IMPORT_COLUMNS.map((c) => (
                      <option key={c} value={c}>
                        {COLUMN_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sample.map((r, ri) => (
              <tr key={ri}>
                {headers.map((_, ci) => (
                  <td
                    key={ci}
                    className="max-w-[16rem] truncate px-3 py-1.5 text-xs text-gray-600"
                  >
                    {r[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-gray-700" role="status">
        {p.rowCount} {p.rowCount === 1 ? "row" : "rows"} found.
      </p>
      <ErrorLine
        message={tooMany ? TOO_MANY_ROWS_MESSAGE : (problem ?? p.error)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={p.onBack}
          disabled={p.previewing}
        >
          Back
        </Button>
        <Button
          type="button"
          disabled={
            problem !== null || tooMany || p.rowCount === 0 || p.previewing
          }
          onClick={p.onPreview}
        >
          {p.previewing ? (
            <>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              Checking
            </>
          ) : (
            "Preview"
          )}
        </Button>
      </div>
    </div>
  );
}

/* ---- step 3: the preview and the decisions ------------------------------------------- */

/** The width the preview table needs (its min-w-[44rem]). */
export const PREVIEW_TABLE_MIN_WIDTH = 704;

/** A long citation is cut for the preview; the whole text is imported. */
export const shortCitation = (c: string) =>
  c.length > 120 ? `${c.slice(0, 120)}…` : c;

export interface ImportPreviewViewProps {
  /** Table or one card per row; the container picks it from its own width. */
  layout?: RosterLayout;
  preview: ImportPreviewData;
  skipped: ReadonlySet<number>;
  onSkip: (row: number, skip: boolean) => void;
  decisions: Decision[];
  onDecision: (decision: Decision | null, nameKey: string) => void;
  onBack: () => void;
  onImport: () => void;
  importing: boolean;
  /** A re-preview is waiting or running: the rows below may be stale. */
  rechecking?: boolean;
  error: string | null;
}

/** The rows that will be written: Ready and not skipped. */
export const importableCount = (
  rows: readonly ClassifiedRow[],
  skipped: ReadonlySet<number>,
) => rows.filter((r) => r.status === "ready" && !skipped.has(r.row)).length;

export function ImportPreviewView(p: ImportPreviewViewProps) {
  const { rows, counts } = p.preview;
  const unknown = unknownNames(rows, p.skipped);
  const open = undecided(unknown, p.decisions);
  const n = importableCount(rows, p.skipped);
  const choices = [...p.preview.types, ...p.preview.archivedTypes];

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm font-medium text-gray-900" role="status">
          {previewSummaryLine(counts)}
        </p>
        {p.rechecking && (
          <p className="mb-2 text-sm text-gray-700" role="status">
            Re-checking...
          </p>
        )}
        <ul className="flex flex-wrap gap-2">
          {(Object.keys(counts) as RowStatus[]).map((s) => (
            <li
              key={s}
              className="flex items-center gap-1.5 text-sm text-gray-700"
            >
              <StatusChip status={s} />
              {counts[s]}
            </li>
          ))}
        </ul>
      </div>

      {unknown.length > 0 && (
        <section
          aria-labelledby="decide-heading"
          className="rounded-md border border-amber-300 bg-amber-50 p-3"
        >
          <h4
            id="decide-heading"
            className="text-sm font-semibold text-gray-900"
          >
            Decide unknown awards
          </h4>
          <p className="mb-3 text-xs text-gray-700">
            These award names are not in the catalogue. Choose what to do with
            each one before importing.
          </p>
          <ul className="space-y-3">
            {unknown.map((u) => {
              const d = p.decisions.find((x) => x.nameKey === u.nameKey);
              const value = !d
                ? ""
                : d.action === "create"
                  ? "create"
                  : d.awardTypeID;
              return (
                <li
                  key={u.nameKey}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span className="min-w-[10rem] flex-1 break-words text-sm font-medium text-gray-900">
                    {u.name}
                    <span className="ml-2 text-xs font-normal text-gray-600">
                      {u.rows} {u.rows === 1 ? "row" : "rows"}
                    </span>
                  </span>
                  <label htmlFor={`decide-${u.nameKey}`} className="sr-only">
                    {`What to do with ${u.name}`}
                  </label>
                  <select
                    id={`decide-${u.nameKey}`}
                    value={value}
                    className="h-9 min-w-[14rem] rounded-md border border-input bg-background px-2 text-sm"
                    onChange={(e) => {
                      const v = e.target.value;
                      p.onDecision(
                        v === ""
                          ? null
                          : v === "create"
                            ? { nameKey: u.nameKey, action: "create" }
                            : {
                                nameKey: u.nameKey,
                                action: "existing",
                                awardTypeID: v,
                              },
                        u.nameKey,
                      );
                    }}
                  >
                    <option value="">Choose</option>
                    {canCreate(u) && (
                      <option value="create">Create new award</option>
                    )}
                    <optgroup label="Use existing award">
                      {choices.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.archived ? `${t.name} (archived)` : t.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  {u.archivedTypeID && (
                    <span className="basis-full text-xs text-gray-700">
                      An archived award has this name. Using it does not
                      unarchive it.
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {p.layout === "cards" ? (
        <ul className="space-y-3">
          {rows.map((r) => {
            const skip = p.skipped.has(r.row);
            return (
              <li
                key={r.row}
                className={`rounded-md border border-gray-200 p-3 ${skip ? "text-gray-600 line-through" : ""}`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-600">
                    Row {r.row}
                  </span>
                  <StatusChip status={r.status} />
                </div>
                <p className="break-words text-sm font-medium">
                  {r.displayName ?? r.identifier}
                </p>
                {r.displayName && (
                  <p className="break-all text-xs text-gray-500">
                    {r.identifier}
                  </p>
                )}
                <p className="mt-1 break-words text-sm">
                  {r.award}
                  {r.status === "ready" && r.isNew && (
                    <span className="ml-1 text-xs text-amber-800">
                      New award
                    </span>
                  )}
                </p>
                {r.citation && (
                  <p className="break-all text-xs italic text-gray-600">
                    {shortCitation(r.citation)}
                  </p>
                )}
                {r.reason && (
                  <p className="mt-1 text-xs text-gray-700">{r.reason}</p>
                )}
                {r.status === "ready" && (
                  <label className="mt-2 inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      aria-label={`Skip row ${r.row}`}
                      checked={skip}
                      onChange={(e) => p.onSkip(r.row, e.target.checked)}
                    />
                    Skip
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="relative overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs font-medium text-gray-700">
                <th scope="col" className="px-3 py-2">
                  Row
                </th>
                <th scope="col" className="px-3 py-2">
                  Person
                </th>
                <th scope="col" className="px-3 py-2">
                  Award
                </th>
                <th scope="col" className="px-3 py-2">
                  Status
                </th>
                <th scope="col" className="px-3 py-2">
                  Reason
                </th>
                <th scope="col" className="px-3 py-2">
                  Skip
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const skip = p.skipped.has(r.row);
                return (
                  <tr
                    key={r.row}
                    className={`align-top ${skip ? "text-gray-600 line-through" : ""}`}
                  >
                    <td className="px-3 py-2">{r.row}</td>
                    <td className="max-w-[14rem] break-words px-3 py-2">
                      {r.displayName ?? r.identifier}
                      {r.displayName && (
                        <span className="block text-xs text-gray-500">
                          {r.identifier}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[14rem] break-words px-3 py-2">
                      {r.award}
                      {r.status === "ready" && r.isNew && (
                        <span className="ml-1 text-xs text-amber-800">
                          New award
                        </span>
                      )}
                      {r.citation && (
                        <span className="block text-xs italic text-gray-600">
                          {shortCitation(r.citation)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {r.reason ?? ""}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "ready" && (
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          aria-label={`Skip row ${r.row}`}
                          checked={skip}
                          onChange={(e) => p.onSkip(r.row, e.target.checked)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ErrorLine message={p.error} />
      {open.length > 0 && (
        <p className="text-sm text-amber-900" role="status">
          {open.length} unknown{" "}
          {open.length === 1 ? "award needs" : "awards need"} a decision.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={p.onBack}
          disabled={p.importing}
        >
          Back
        </Button>
        <Button
          type="button"
          disabled={n === 0 || open.length > 0 || p.importing || p.rechecking}
          onClick={p.onImport}
        >
          {p.importing ? (
            <>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              Importing
            </>
          ) : (
            importButtonLabel(n)
          )}
        </Button>
      </div>
    </div>
  );
}

/* ---- committing and the summary ----------------------------------------------------------- */

export function ImportProgressView({ rows }: { rows: number }) {
  return (
    <div className="space-y-2" role="status">
      <p className="text-sm text-gray-800">
        Importing {rows} {rows === 1 ? "row" : "rows"}, {IMPORT_CHUNK_SIZE} at a
        time.
      </p>
      <Progress value={100} className="animate-pulse" aria-label="Importing" />
    </div>
  );
}

export interface ImportDoneViewProps {
  result: ImportResult;
  onHistory: () => void;
  onAnother: () => void;
}

export function ImportDoneView(p: ImportDoneViewProps) {
  const { result } = p;
  return (
    <div className="space-y-4">
      <p className="text-base font-medium text-emerald-900" role="status">
        {importSummaryLine(result.imported, result.skipped.length)}
      </p>
      {result.created.length > 0 && (
        <p className="text-sm text-gray-700">
          Added to the catalogue: {result.created.join(", ")}.
        </p>
      )}
      {result.skipped.length > 0 && (
        <div className="relative overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs font-medium text-gray-700">
                <th scope="col" className="px-3 py-2">
                  Row
                </th>
                <th scope="col" className="px-3 py-2">
                  Person
                </th>
                <th scope="col" className="px-3 py-2">
                  Award
                </th>
                <th scope="col" className="hidden px-3 py-2 md:table-cell">
                  Why it was skipped
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {result.skipped.map((s) => (
                <tr key={s.row}>
                  <td className="px-3 py-2">{s.row}</td>
                  <td className="max-w-[14rem] break-words px-3 py-2">
                    {s.identifier}
                  </td>
                  <td className="max-w-[12rem] break-words px-3 py-2">
                    {s.award}
                    <span className="block text-xs text-gray-700 md:hidden">
                      {s.reason}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2 text-xs text-gray-700 md:table-cell">
                    {s.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm">
        <button
          type="button"
          onClick={p.onHistory}
          className="font-medium text-emerald-800 underline underline-offset-2"
        >
          See it in History
        </button>
        <span className="text-gray-500"> to undo the upload.</span>
      </p>
      <Button type="button" variant="outline" onClick={p.onAnother}>
        Upload another file
      </Button>
    </div>
  );
}

/* ---- the container ------------------------------------------------------------------------------ */

type Step = "input" | "map" | "preview" | "importing" | "done";

/** Columns for a table: guessed from the headings, or identifier, award, citation in order. */
function mappingFor(table: string[][], header: boolean): ImportColumn[] {
  const first = table[0] ?? [];
  if (header) return guessMapping(first);
  return first.map(
    (_, i) => (["identifier", "award", "citation"] as const)[i] ?? "ignore",
  );
}

/** A skipped row that is no longer Ready after a re-preview is not skipped. */
export const stillSkipped = (
  skipped: ReadonlySet<number>,
  rows: readonly ClassifiedRow[],
) =>
  new Set(
    rows
      .filter((r) => r.status === "ready" && skipped.has(r.row))
      .map((r) => r.row),
  );

export const REPREVIEW_DELAY_MS = 300;

/**
 * The Skip toggles of the preview. Each toggle shows at once; the re-preview
 * is sent once, REPREVIEW_DELAY_MS after the last toggle, with the final skip
 * set. If it fails the skip set goes back to what it was before the toggles.
 */
export function createSkipRepreview(o: {
  send: (skipRows: number[]) => Promise<{ rows: ClassifiedRow[] }>;
  onSkipped: (skipped: Set<number>) => void;
  onPreview: (data: { rows: ClassifiedRow[] }) => void;
  onPending: (pending: boolean) => void;
  onError: (error: unknown) => void;
  delayMs?: number;
}) {
  let current = new Set<number>();
  let before: Set<number> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;

  const cancel = (skipped: Set<number>) => {
    clearTimeout(timer);
    latest += 1;
    current = skipped;
    before = null;
    o.onPending(false);
  };

  return {
    reset: cancel,
    toggle(row: number, skip: boolean) {
      o.onError(null);
      before ??= current;
      current = new Set(current);
      if (skip) current.add(row);
      else current.delete(row);
      o.onSkipped(current);
      o.onPending(true);
      clearTimeout(timer);
      const token = (latest += 1);
      timer = setTimeout(() => {
        o.send([...current]).then(
          (data) => {
            if (token !== latest) return;
            current = stillSkipped(current, data.rows);
            before = null;
            o.onSkipped(current);
            o.onPreview(data);
            o.onError(null);
            o.onPending(false);
          },
          (e: unknown) => {
            if (token !== latest) return;
            current = before ?? current;
            before = null;
            o.onSkipped(current);
            o.onError(e);
            o.onPending(false);
          },
        );
      }, o.delayMs ?? REPREVIEW_DELAY_MS);
    },
  };
}

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = TEMPLATE_FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The Import tab: file, columns, preview and decisions, import, summary. */
export default function AwardImport({
  academicYear,
  readOnly,
  onDirty,
  onOpenHistory,
}: {
  academicYear: string;
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
  onOpenHistory: () => void;
}) {
  const utils = api.useUtils();
  const [boxRef, width] = useContainerWidth<HTMLDivElement>();
  const [step, setStep] = useState<Step>("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<ImportColumn[]>([]);
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [sentRows, setSentRows] = useState<ImportRow[]>([]);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewMutation =
    api.transcriptManage.awardImport.preview.useMutation();
  const commitMutation = api.transcriptManage.awardImport.commit.useMutation();

  // A parsed file that has not been imported is work to lose.
  const dirty = step === "map" || step === "preview" || step === "importing";
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const picks = useRef(latestOnly());
  const [rechecking, setRechecking] = useState(false);
  const sendRef = useRef<(skipRows: number[]) => Promise<ImportPreviewData>>();
  sendRef.current = (skipRows) =>
    previewMutation.mutateAsync({
      academicYear,
      rows: sentRows,
      skipRows,
    }) as Promise<ImportPreviewData>;
  const repreview = useRef<ReturnType<typeof createSkipRepreview>>();
  repreview.current ??= createSkipRepreview({
    send: (skipRows) => sendRef.current!(skipRows),
    onSkipped: setSkipped,
    onPreview: (data) => setPreview(data as ImportPreviewData),
    onPending: setRechecking,
    onError: (e) =>
      setError(e ? errorText((e as { message?: string }).message) : null),
  });
  useEffect(() => () => repreview.current?.reset(new Set()), []);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => () => onDirtyRef.current(false), []);

  const reset = () => {
    setStep("input");
    setText("");
    setFileName(null);
    setTable([]);
    setPreview(null);
    setSkipped(new Set());
    repreview.current?.reset(new Set());
    setDecisions([]);
    setResult(null);
    setError(null);
  };

  const rowsNow = () => rowsFromTable(table, mapping, hasHeader);

  const runPreview = async () => {
    setError(null);
    const rows = rowsNow();
    setSentRows(rows);
    try {
      const data = await previewMutation.mutateAsync({ academicYear, rows });
      setPreview(data as ImportPreviewData);
      setSkipped(new Set());
      repreview.current?.reset(new Set());
      setDecisions([]);
      setStep("preview");
    } catch (e) {
      const err = e as {
        message?: string;
        data?: {
          zodError?: {
            fieldErrors?: Record<string, string[] | undefined>;
          } | null;
        };
      };
      setError(
        fieldError(err.data?.zodError ?? null, "rows") ??
          errorText(err.message),
      );
    }
  };

  const runImport = async () => {
    setError(null);
    setStep("importing");
    try {
      const done = await commitMutation.mutateAsync({
        academicYear,
        fileName: fileName ?? undefined,
        rows: sentRows,
        decisions,
        skipRows: [...skipped],
      });
      setResult(done as ImportResult);
      setStep("done");
      await Promise.all([
        utils.transcriptManage.awards.list.invalidate(),
        utils.transcriptManage.awardTypes.list.invalidate(),
        utils.transcriptManage.awardBatches.list.invalidate(),
      ]);
    } catch (e) {
      setError(errorText((e as { message?: string }).message));
      setStep("preview");
    }
  };

  if (step === "done" && result) {
    return (
      <ImportDoneView
        result={result}
        onHistory={onOpenHistory}
        onAnother={reset}
      />
    );
  }
  if (step === "importing") {
    return (
      <ImportProgressView
        rows={importableCount(preview?.rows ?? [], skipped)}
      />
    );
  }
  if (step === "preview" && preview) {
    return (
      <div ref={boxRef}>
        <ImportPreviewView
          layout={rosterLayoutFor(width, PREVIEW_TABLE_MIN_WIDTH)}
          preview={preview}
          skipped={skipped}
          onSkip={(row, skip) => repreview.current?.toggle(row, skip)}
          rechecking={rechecking}
          decisions={decisions}
          onDecision={(d, nameKey) =>
            setDecisions((cur) => [
              ...cur.filter((x) => x.nameKey !== nameKey),
              ...(d ? [d] : []),
            ])
          }
          onBack={() => {
            repreview.current?.reset(new Set(skipped));
            setStep("map");
          }}
          onImport={() => void runImport()}
          importing={false}
          error={error}
        />
      </div>
    );
  }
  if (step === "map") {
    return (
      <ImportMapView
        table={table}
        hasHeader={hasHeader}
        onHasHeader={(v) => {
          setHasHeader(v);
          setMapping(mappingFor(table, v));
        }}
        mapping={mapping}
        onMapping={setMapping}
        rowCount={rowsNow().length}
        onBack={() => setStep("input")}
        onPreview={() => void runPreview()}
        previewing={previewMutation.isPending}
        error={error}
      />
    );
  }
  return (
    <ImportInputView
      text={text}
      onText={(t) => {
        setText(t);
        setError(null);
      }}
      fileName={fileName}
      onFile={(file) => {
        setError(null);
        const token = picks.current.start();
        void (async () => {
          try {
            const content = await file.text();
            // A newer pick (or none) wins over a slow earlier read.
            if (!picks.current.isCurrent(token)) return;
            setText(content);
            setFileName(file.name);
          } catch {
            if (picks.current.isCurrent(token)) {
              setError("This file could not be read.");
            }
          }
        })();
      }}
      onDownloadTemplate={downloadTemplate}
      onContinue={() => {
        const parsed = parseCsv(text);
        if (parsed.length === 0) {
          setError("There are no rows in that text.");
          return;
        }
        const header = looksLikeHeader(parsed[0]!);
        setHasHeader(header);
        setMapping(mappingFor(parsed, header));
        setTable(parsed);
        setStep("map");
      }}
      readOnly={readOnly}
      error={error}
    />
  );
}
