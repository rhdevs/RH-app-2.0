"use client";

import { useMemo, useState } from "react";

import type { RouterOutputs } from "~/trpc/react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

type Preview = RouterOutputs["admin"]["previewBulkCcaHeads"];
export type CcaHeadPreviewItem = Preview["items"][number];
/** The committable subset — carries the server-signed rowToken. */
export type CommittableCcaHeadItem = Extract<
  CcaHeadPreviewItem,
  { status: "ok" }
>;

type Bucket = "grant" | "already" | "duplicate" | "denied" | "unresolved";

const BUCKET_META: Record<
  Bucket,
  { label: string; committable: boolean; note?: string }
> = {
  grant: {
    label: "Will become a CCA head",
    committable: true,
    note: "Each of these gains a head record for this CCA and the CCA head role. Neither is written without the other.",
  },
  already: {
    label: "Already a head of this CCA",
    committable: true,
    note: "Nothing changes for these. They are kept selected so a re-run of a partly finished list is safe; untick any you would rather leave alone.",
  },
  duplicate: {
    label: "Listed more than once",
    committable: false,
    note: "An earlier line resolved to the same person. Only the first line is used.",
  },
  denied: {
    label: "Will be refused",
    committable: false,
    note: "A permission check would refuse these. They are shown so the refusal is visible, not hidden.",
  },
  unresolved: {
    label: "Not recognised",
    committable: false,
    note: "Listed exactly as pasted so typos are fixable. Only NUSNET ids and @u.nus.edu addresses resolve — matric numbers and names deliberately do not.",
  },
};

function bucketOf(item: CcaHeadPreviewItem, seen: Set<string>): Bucket {
  if (item.status === "denied") {
    return item.denyReason === "UNRESOLVED_IDENTIFIER"
      ? "unresolved"
      : "denied";
  }
  if (seen.has(item.userID)) return "duplicate";
  return item.alreadyHead ? "already" : "grant";
}

export default function CcaHeadPreviewTable({
  preview,
  onBack,
  onCommit,
}: {
  preview: Preview;
  onBack: () => void;
  onCommit: (rows: CommittableCcaHeadItem[]) => void;
}) {
  const buckets = useMemo(() => {
    const seen = new Set<string>();
    const out: Record<Bucket, CcaHeadPreviewItem[]> = {
      grant: [],
      already: [],
      duplicate: [],
      denied: [],
      unresolved: [],
    };
    for (const item of [...preview.items].sort((a, b) => a.lineNo - b.lineNo)) {
      out[bucketOf(item, seen)].push(item);
      if (item.status === "ok") seen.add(item.userID);
    }
    return out;
  }, [preview]);

  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  const committable = (["grant", "already"] as const).flatMap(
    (b) => buckets[b] as CommittableCcaHeadItem[],
  );
  const selected = committable.filter((i) => !excluded.has(i.lineNo));
  const newHeads = selected.filter((i) => !i.alreadyHead).length;
  const unchanged = selected.length - newHeads;
  const skipped = preview.items.length - selected.length;

  const summary = (Object.keys(BUCKET_META) as Bucket[])
    .filter((b) => buckets[b].length > 0)
    .map((b) => `${buckets[b].length} ${BUCKET_META[b].label.toLowerCase()}`)
    .join(" · ");

  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription className="font-medium">
          {preview.ccaName} ({preview.ccaID}) — {summary}
        </AlertDescription>
      </Alert>

      <Accordion
        type="multiple"
        // Actionable buckets open by default; informational ones collapsed.
        defaultValue={["grant", "denied", "unresolved"]}
        className="rounded-xl bg-white px-4 shadow-lg"
      >
        {(Object.keys(BUCKET_META) as Bucket[])
          .filter((b) => buckets[b].length > 0)
          .map((b) => {
            const meta = BUCKET_META[b];
            const items = buckets[b];
            return (
              <AccordionItem key={b} value={b}>
                <AccordionTrigger className="text-sm">
                  {meta.label}
                  <span className="ml-2 text-gray-400">({items.length})</span>
                </AccordionTrigger>
                <AccordionContent>
                  {meta.note && (
                    <p className="mb-3 text-xs text-gray-500">{meta.note}</p>
                  )}
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10" />
                          <TableHead className="w-14">Line</TableHead>
                          <TableHead>Person</TableHead>
                          <TableHead>Identifier</TableHead>
                          <TableHead>Heads this CCA now</TableHead>
                          <TableHead>What will happen</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((item) => {
                          const ok = item.status === "ok";
                          const excludedRow = excluded.has(item.lineNo);
                          return (
                            <TableRow key={item.lineNo}>
                              <TableCell>
                                <Checkbox
                                  disabled={!meta.committable}
                                  checked={meta.committable && !excludedRow}
                                  onCheckedChange={(v) =>
                                    setExcluded((prev) => {
                                      const next = new Set(prev);
                                      if (v) next.delete(item.lineNo);
                                      else next.add(item.lineNo);
                                      return next;
                                    })
                                  }
                                />
                              </TableCell>
                              <TableCell className="text-xs text-gray-400">
                                {item.lineNo}
                              </TableCell>
                              <TableCell className="text-sm">
                                {ok ? (
                                  <div>
                                    <p className="text-gray-900">
                                      {item.displayName ?? item.userID}
                                    </p>
                                    <p className="text-xs text-gray-400">
                                      {/* Masked server-side on rows where the
                                          operator did not themselves supply the
                                          address — resolving an id must not
                                          become an email harvest. */}
                                      {item.email ?? item.userID}
                                      {item.block
                                        ? ` · Block ${item.block}`
                                        : ""}
                                    </p>
                                  </div>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {item.identifier}
                              </TableCell>
                              <TableCell className="text-xs text-gray-600">
                                {ok ? (item.alreadyHead ? "Yes" : "No") : "—"}
                              </TableCell>
                              <TableCell className="text-xs">
                                {!ok ? (
                                  <span
                                    className="text-red-600"
                                    title={item.denyReason}
                                  >
                                    {item.denyReason === "UNRESOLVED_IDENTIFIER"
                                      ? "No account matches this — nothing will be written"
                                      : `Refused: ${item.denyReason}`}
                                  </span>
                                ) : !meta.committable ? (
                                  <span className="text-gray-500">
                                    Skipped as a duplicate
                                  </span>
                                ) : excludedRow ? (
                                  <span className="text-gray-500">
                                    Left out of this run
                                  </span>
                                ) : item.alreadyHead ? (
                                  <span className="text-gray-600">
                                    Nothing — already a head of this CCA
                                  </span>
                                ) : (
                                  <span className="text-emerald-700">
                                    Becomes a head of this CCA
                                  </span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
      </Accordion>

      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              className="bg-emerald-700 text-white hover:bg-emerald-800"
              disabled={selected.length === 0}
            >
              Make {newHeads} people heads of {preview.ccaName}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Make {newHeads} people heads of {preview.ccaName}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {newHeads} people gain CCA headship of {preview.ccaName} (
                {preview.ccaID}). {unchanged} are already heads and will be left
                as they are. {skipped} rows are being skipped. Each person is
                checked individually on the server, so some may still be refused
                — those are listed afterwards and do not stop the rest.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onCommit(selected)}>
                Assign {newHeads}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
