"use client";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

export type CommitResult = {
  lineNo: number;
  userID: string;
  /**
   * `noop` is emitted only by the CCA-head surface, where a row can succeed
   * without changing anything (the person already headed that CCA). It is
   * counted apart from `ok` so "12 applied" never quietly includes rows that
   * did nothing, and it is NOT a failure.
   */
  status: "ok" | "noop" | "denied";
  denyReason?: string;
};

/**
 * An in-page <Progress> + failure table rather than a toast sequence: a commit
 * needs persistent, non-dismissing feedback and the shared Toast auto-dismisses
 * after 5s. The toast fires once, at the end.
 *
 * PER-ROW FAILURE IS THE EXPECTED OUTCOME, not an error condition — a jcrc's
 * import containing an admin returns CANNOT_MODIFY_AN_ADMIN on that row and
 * succeeds on the other 24. So successes collapse to a count and only failures
 * are enumerated.
 */
export default function BulkCommitProgress({
  done,
  total,
  results,
  finished,
  onViewAudit,
  onUndo,
  undoPending,
  failureNote,
}: {
  done: number;
  total: number;
  results: CommitResult[];
  finished: boolean;
  onViewAudit: () => void;
  /**
   * Optional. The CCA-head surface passes neither: its batches have no
   * BulkRoleImport header, precisely so `undoBulkImport` — which reverses rows
   * through the GENERIC role path — can never reach a `cca_head` grant and
   * split the role string from its CcaHead record (CH-1). Offering a button
   * that cannot work would be worse than not offering one.
   */
  onUndo?: () => void;
  undoPending?: boolean;
  /** Surface-specific explanation of the refusal codes above. */
  failureNote?: React.ReactNode;
}) {
  const failures = results.filter((r) => r.status === "denied");
  const unchanged = results.filter((r) => r.status === "noop").length;
  const ok = results.length - failures.length - unchanged;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex justify-between text-sm text-gray-600">
          <span>
            {/* Never "complete" when something failed — a refused row is not a
                finished one, and the operator has to go and fix it. */}
            {finished
              ? failures.length > 0
                ? `Finished with ${failures.length} refused`
                : "Complete"
              : `Applying ${done} of ${total}…`}
          </span>
          <span>
            {ok} applied
            {unchanged > 0 ? ` · ${unchanged} unchanged` : ""} ·{" "}
            {failures.length} refused
          </span>
        </div>
        <Progress value={total === 0 ? 0 : (done / total) * 100} />
      </div>

      {failures.length > 0 && (
        <div className="overflow-hidden rounded-xl bg-white shadow-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Line</TableHead>
                <TableHead>User ID</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.map((f) => (
                <TableRow key={f.lineNo}>
                  <TableCell className="text-xs text-gray-400">
                    {f.lineNo}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {f.userID}
                  </TableCell>
                  <TableCell className="text-xs text-red-600">
                    {f.denyReason}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {finished && (
        <>
          {failures.length > 0 && (
            <Alert>
              <AlertDescription className="text-xs">
                {failureNote ?? (
                  <>
                    Refused rows are already recorded in the audit log with{" "}
                    <code>ok: false</code>. <code>CONFLICT_ROLES_CHANGED</code>{" "}
                    means the target&apos;s roles changed between preview and
                    commit — re-run the preview for those.
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex gap-3">
            <Button variant="outline" onClick={onViewAudit}>
              View in audit log
            </Button>
            {onUndo && (
              <Button
                variant="outline"
                onClick={onUndo}
                disabled={undoPending}
                className="border-amber-300 text-amber-800 hover:bg-amber-50"
              >
                {undoPending ? "Undoing…" : "Undo this import"}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
