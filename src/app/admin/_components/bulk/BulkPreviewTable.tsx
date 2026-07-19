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

import RoleBadge from "../RoleBadge";

type Preview = RouterOutputs["admin"]["previewBulkImport"];
export type PreviewItem = Preview["items"][number];
/** The committable subset — carries the server-signed rowToken. */
export type CommittableItem = Extract<PreviewItem, { status: "ok" }>;

type Bucket =
  | "grant"
  | "revoke"
  | "noop"
  | "pending"
  | "duplicate"
  | "denied"
  | "unresolved";

const BUCKET_META: Record<
  Bucket,
  { label: string; committable: boolean; note?: string }
> = {
  grant: { label: "Grant", committable: true },
  revoke: { label: "Revoke", committable: true },
  noop: { label: "No change", committable: true },
  pending: {
    label: "Pending (no account yet)",
    committable: false,
    note: "These identifiers have no account. Create deferred grants for them from the Pending grants panel below — they cannot be committed as role changes.",
  },
  duplicate: {
    label: "Duplicate",
    committable: false,
    note: "An earlier line already resolved to the same user.",
  },
  denied: {
    label: "Denied",
    committable: false,
    note: "An escalation guard would refuse these. They are shown so the refusal is visible, not hidden.",
  },
  unresolved: {
    label: "Unresolved",
    committable: false,
    note: "Listed verbatim so typos are fixable. Only NUSNET ids and @u.nus.edu addresses resolve — matric numbers and names deliberately do not.",
  },
};

function bucketOf(
  item: PreviewItem,
  mode: "add" | "set",
  seen: Set<string>,
): Bucket {
  if (item.status === "denied") {
    return item.denyReason === "UNRESOLVED_IDENTIFIER"
      ? "unresolved"
      : "denied";
  }
  if (seen.has(item.userID)) return "duplicate";
  if (!item.hasAccount) return "pending";
  const before = new Set(item.rolesBefore);
  const after = new Set(item.rolesAfter);
  const removes = item.rolesBefore.some((r) => !after.has(r));
  const adds = item.rolesAfter.some((r) => !before.has(r));
  if (!adds && !removes) return "noop";
  if (mode === "set" && removes) return "revoke";
  return "grant";
}

export default function BulkPreviewTable({
  preview,
  onBack,
  onCommit,
}: {
  preview: Preview;
  onBack: () => void;
  onCommit: (rows: CommittableItem[]) => void;
}) {
  const mode = preview.mode;

  const buckets = useMemo(() => {
    const seen = new Set<string>();
    const out: Record<Bucket, PreviewItem[]> = {
      grant: [],
      revoke: [],
      noop: [],
      pending: [],
      duplicate: [],
      denied: [],
      unresolved: [],
    };
    for (const item of [...preview.items].sort((a, b) => a.lineNo - b.lineNo)) {
      const b = bucketOf(item, mode, seen);
      out[b].push(item);
      if (item.status === "ok") seen.add(item.userID);
    }
    return out;
  }, [preview, mode]);

  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  const committable = (["grant", "revoke", "noop"] as const).flatMap(
    (b) => buckets[b] as CommittableItem[],
  );
  const selected = committable.filter((i) => !excluded.has(i.lineNo));
  const skipped = preview.items.length - selected.length;

  const summary = (Object.keys(BUCKET_META) as Bucket[])
    .filter((b) => buckets[b].length > 0)
    .map((b) => `${buckets[b].length} ${BUCKET_META[b].label.toLowerCase()}`)
    .join(" · ");

  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription className="font-medium">{summary}</AlertDescription>
      </Alert>

      <Accordion
        type="multiple"
        // Actionable buckets open by default; informational ones collapsed.
        defaultValue={["grant", "revoke", "denied", "unresolved"]}
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
                          <TableHead>Current</TableHead>
                          <TableHead>After</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((item) => {
                          const ok = item.status === "ok";
                          return (
                            <TableRow key={item.lineNo}>
                              <TableCell>
                                <Checkbox
                                  disabled={!meta.committable}
                                  checked={
                                    meta.committable &&
                                    !excluded.has(item.lineNo)
                                  }
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
                                          address — resolving an E-id must not
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
                              <TableCell>
                                {ok ? (
                                  <div className="flex flex-wrap gap-1">
                                    {item.rolesBefore.map((r) => (
                                      <RoleBadge key={r} role={r} />
                                    ))}
                                  </div>
                                ) : (
                                  <span
                                    className="text-xs text-red-600"
                                    title={item.denyReason}
                                  >
                                    {item.denyReason}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {ok && (
                                  <div className="flex flex-wrap gap-1">
                                    {item.rolesAfter.map((r) => (
                                      <RoleBadge key={r} role={r} />
                                    ))}
                                  </div>
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
              Apply to {selected.length} users
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Apply to {selected.length} users?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {skipped} rows will be skipped. Each row is guarded individually
                on the server, so some may still be refused — those are reported
                per row and do not stop the rest.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onCommit(selected)}>
                Apply {selected.length}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
