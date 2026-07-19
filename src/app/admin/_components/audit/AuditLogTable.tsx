"use client";

import { useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";

import { api, type RouterOutputs } from "~/trpc/react";
import { userIDSchema } from "~/server/api/services/roles";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import EmptyState from "../EmptyState";

type Row = RouterOutputs["admin"]["listAuditLog"]["items"][number];

const ACTION_STYLE: Record<string, string> = {
  grant: "border-emerald-300 bg-emerald-100 text-emerald-800",
  set: "border-emerald-300 bg-emerald-100 text-emerald-800",
  revoke: "border-amber-300 bg-amber-100 text-amber-800",
  denied: "border-red-300 bg-red-100 text-red-800",
  "booking.denied.shadow": "border-gray-300 bg-gray-100 text-gray-600",
};

function actionClass(action: string) {
  if (ACTION_STYLE[action]) return ACTION_STYLE[action]!;
  if (action.startsWith("pending."))
    return "border-blue-300 bg-blue-100 text-blue-800";
  return "border-gray-300 bg-gray-100 text-gray-600";
}

/** Under 7 days reads better as "3 hours ago"; beyond that an absolute date is
 *  what someone reconstructing an incident actually needs. */
function when(at: Date) {
  const d = new Date(at);
  return Date.now() - d.getTime() < 7 * 24 * 3600 * 1000
    ? formatDistanceToNow(d, { addSuffix: true })
    : format(d, "d MMM yyyy, HH:mm");
}

function RowLine({ r }: { r: Row }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs text-gray-500">
        {when(r.at)}
      </TableCell>
      <TableCell className="font-mono text-xs">{r.actorUserID}</TableCell>
      <TableCell>
        <Badge variant="outline" className={actionClass(r.action)}>
          {r.action}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {r.targetUserID ?? (r.targetFacilityID != null
          ? `facility ${r.targetFacilityID}`
          : "—")}
      </TableCell>
      <TableCell className="text-xs text-gray-500">
        {(r.rolesBefore ?? []).join(", ") || "—"} →{" "}
        {(r.rolesAfter ?? []).join(", ") || "—"}
      </TableCell>
      <TableCell className="text-xs text-gray-500">
        {r.ok === false ? (
          <span className="text-red-600">{r.denyReason}</span>
        ) : (
          (r.reason ?? "—")
        )}
      </TableCell>
    </TableRow>
  );
}

export default function AuditLogTable({
  initialBatchId,
}: {
  initialBatchId?: string;
}) {
  const [actorUserID, setActor] = useState("");
  const [targetUserID, setTarget] = useState("");
  const [action, setAction] = useState("");
  const [batchId, setBatchId] = useState(initialBatchId ?? "");

  /**
   * ONE identity predicate, shared with the server (I-12). The old
   * `/^E\d{7}$/.test(...)` here was STRICTER than `userIDSchema` and failed
   * open on the difference: a value pasted with a trailing space failed the
   * test, the ternary substituted `undefined`, tRPC omitted the key, and the
   * server ran `findMany` with an empty `where` — the 50 most recent rows for
   * EVERY user, presented as one person's role history (09 §2.6). Parsing with
   * the server's own schema means the trailing space is normalised away and the
   * filter applies, which is what the operator meant.
   *
   * And when a filter is present but genuinely unparseable we FAIL CLOSED: the
   * query does not run at all. Showing everything is the one outcome an audit
   * surface must never produce silently.
   */
  const actorParsed = userIDSchema.safeParse(actorUserID);
  const targetParsed = userIDSchema.safeParse(targetUserID);
  const actorInvalid = actorUserID.trim() !== "" && !actorParsed.success;
  const targetInvalid = targetUserID.trim() !== "" && !targetParsed.success;
  const filterInvalid = actorInvalid || targetInvalid;

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = api.admin.listAuditLog.useInfiniteQuery(
    {
      limit: 50,
      actorUserID: actorParsed.success ? actorParsed.data : undefined,
      targetUserID: targetParsed.success ? targetParsed.data : undefined,
      // Blank means "do not filter on this" for these two, deliberately —
      // unlike the identity boxes above, where blank and unparseable differ.
      action: action || undefined,
      batchId: batchId || undefined,
    },
    {
      getNextPageParam: (l) => l.nextCursor ?? undefined,
      enabled: !filterInvalid,
    },
  );

  const rows = useMemo(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data],
  );

  /**
   * Batch grouping is the headline feature of this page. A 500-person import is
   * ONE entry, not 500 rows burying every other change that day — without it
   * the log becomes unusable the day bulk import ships.
   */
  const { batches, singles } = useMemo(() => {
    const byBatch = new Map<string, Row[]>();
    const loose: Row[] = [];
    for (const r of rows) {
      if (r.batchId) {
        const list = byBatch.get(r.batchId) ?? [];
        list.push(r);
        byBatch.set(r.batchId, list);
      } else loose.push(r);
    }
    // A batch of one is not worth an accordion; fold it back in.
    const grouped: { batchId: string; rows: Row[] }[] = [];
    for (const [id, list] of byBatch) {
      if (list.length > 1) grouped.push({ batchId: id, rows: list });
      else loose.push(...list);
    }
    loose.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { batches: grouped, singles: loose };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Input
          value={actorUserID}
          onChange={(e) => setActor(e.target.value.toUpperCase())}
          placeholder="Actor (E1234567)"
          className="bg-white font-mono text-sm"
        />
        <Input
          value={targetUserID}
          onChange={(e) => setTarget(e.target.value.toUpperCase())}
          placeholder="Target (E1234567)"
          className="bg-white font-mono text-sm"
        />
        <Input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Action (set, denied…)"
          className="bg-white text-sm"
        />
        <Input
          value={batchId}
          onChange={(e) => setBatchId(e.target.value)}
          placeholder="Batch id"
          className="bg-white font-mono text-sm"
        />
      </div>

      {filterInvalid && (
        <p className="text-sm text-amber-700">
          {actorInvalid && targetInvalid
            ? "The Actor and Target boxes do not contain NUSNET ids."
            : actorInvalid
              ? "The Actor box does not contain a NUSNET id."
              : "The Target box does not contain a NUSNET id."}{" "}
          A NUSNET id looks like E1234567. Nothing is shown while it is
          unreadable, because showing the whole log here would look like that
          person&apos;s history. Correct it or clear the box.
        </p>
      )}

      {batches.length > 0 && (
        <Accordion type="multiple" className="rounded-xl bg-white px-4 shadow-lg">
          {batches.map((b) => (
            <AccordionItem key={b.batchId} value={b.batchId}>
              <AccordionTrigger className="text-sm">
                Bulk operation · {b.rows.length} rows · by{" "}
                {b.rows[0]?.actorUserID} ·{" "}
                {b.rows[0] ? when(b.rows[0].at) : ""}
              </AccordionTrigger>
              <AccordionContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableBody>
                      {b.rows.map((r) => (
                        <RowLine key={r.id} r={r} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}

      {/* READ-ONLY. There is no delete and no edit affordance anywhere in this
          DOM, deliberately: an editable audit log is not an audit log. */}
      <div className="overflow-x-auto rounded-xl bg-white shadow-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Before → After</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Order matters. "Could not load" is checked BEFORE "there is
                nothing", so a failed read can never render an all-clear about
                the history of the system (09 §2.8). `isError && !data` and not
                `isError` alone: react-query keeps the previous pages on a later
                failure, and a background blip must not wipe a working page. */}
            {filterInvalid ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <EmptyState
                    title="Not showing any entries"
                    hint="The id you filtered on could not be read, so this table is paused. Fix the id above or clear it to see the log again."
                  />
                </TableCell>
              </TableRow>
            ) : isError && !data ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <EmptyState
                    title="Could not load the audit log"
                    hint={`This is not an empty log — the entries could not be fetched, so none can be shown. ${
                      error?.message ?? "Something went wrong."
                    }`}
                    action={
                      <Button variant="outline" onClick={() => void refetch()}>
                        Try again
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              !isLoading &&
              rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyState title="No role changes recorded yet." />
                  </TableCell>
                </TableRow>
              )
            )}
            {singles.map((r) => (
              <RowLine key={r.id} r={r} />
            ))}
          </TableBody>
        </Table>
      </div>

      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
