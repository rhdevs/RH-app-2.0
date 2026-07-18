"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api, type RouterOutputs } from "~/trpc/react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import Toast from "~/app/_components/Toast";
import { CHUNK } from "../../_lib/planClient";
import BulkInputStep, { type BulkRow } from "./BulkInputStep";
import BulkPreviewTable, { type CommittableItem } from "./BulkPreviewTable";
import BulkCommitProgress, { type CommitResult } from "./BulkCommitProgress";

type Preview = RouterOutputs["admin"]["previewBulkImport"];

export default function BulkImportWizard({
  onImported,
}: {
  onImported: () => void;
}) {
  const router = useRouter();
  const utils = api.useUtils();

  const [preview, setPreview] = useState<Preview | null>(null);
  /**
   * The preview response deliberately does not echo back the REQUESTED roles —
   * but the server signed each rowToken over them, so the commit must resend
   * the identical array or every row fails PLAN_TOKEN_INVALID.
   *
   * Note this must be the requested roles and NOT `rolesAfter`: rolesAfter is
   * redacted for a viewer without seeAdminIdentities, so echoing it back would
   * change the signed tuple and self-inflict a token mismatch on exactly the
   * viewers the redaction is protecting others from.
   */
  const [requestedByLine, setRequestedByLine] = useState<
    Map<number, string[]>
  >(new Map());
  const [step, setStep] = useState<"input" | "review" | "commit">("input");
  const [results, setResults] = useState<CommitResult[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string>("");

  const previewMutation = api.admin.previewBulkImport.useMutation({
    onSuccess: (data) => {
      setPreview(data);
      setStep("review");
    },
    onError: (e) =>
      setError(
        e.message.startsWith("RATE_LIMITED")
          ? "Too many previews in the last hour. Preview is rate-limited because it accepts up to 1000 identifiers and returns their identities."
          : e.message,
      ),
  });

  const begin = api.admin.beginBulkImport.useMutation();
  const commitChunk = api.admin.commitBulkChunk.useMutation();
  const finish = api.admin.finishBulkImport.useMutation();
  const undo = api.admin.undoBulkImport.useMutation({
    onSuccess: async () => {
      setToast("Import reversed");
      await utils.admin.listUsers.invalidate();
      onImported();
    },
    onError: (e) => setError(e.message),
  });

  const runCommit = async (rows: CommittableItem[]) => {
    if (!preview) return;
    setStep("commit");
    setResults([]);
    setDone(0);
    setTotal(rows.length);
    setFinished(false);
    setError(null);

    try {
      await begin.mutateAsync({
        batchId: preview.batchId,
        mode: preview.mode,
      });

      // A work QUEUE rather than a fixed chunk list, so a truncated chunk
      // resumes from lastLineNo instead of being retried blind. A blind retry
      // re-submits rows that already applied, which come back as
      // CONFLICT_ROLES_CHANGED and get reported as failures that never happened.
      let queue = [...rows].sort((a, b) => a.lineNo - b.lineNo);
      const collected: CommitResult[] = [];

      while (queue.length > 0) {
        const slice = queue.slice(0, CHUNK);
        const res = await commitChunk.mutateAsync({
          batchId: preview.batchId,
          expiresAt: preview.expiresAt,
          rows: slice.map((r) => ({
            lineNo: r.lineNo,
            userID: r.userID,
            roles: (requestedByLine.get(r.lineNo) ?? []) as (
              | "admin"
              | "jcrc"
              | "cca_head"
            )[],
            expectedBefore: r.expectedBefore as (
              | "admin"
              | "jcrc"
              | "cca_head"
            )[],
            via: r.via,
            confidence: r.confidence,
            // The server re-derives this HMAC and compares. A row not present
            // in the signed plan is refused, so a hand-crafted payload cannot
            // commit a resolution the preview never produced.
            rowToken: r.rowToken,
          })),
        });

        collected.push(...res.results);
        setResults([...collected]);
        setDone(collected.length);

        // Drop everything the server confirmed it processed. If it stopped
        // early, the remainder stays queued and goes out in the next call.
        queue = queue.filter(
          (r) =>
            r.lineNo > res.lastLineNo &&
            !res.results.some((x) => x.lineNo === r.lineNo),
        );
        if (res.results.length === 0 && res.lastLineNo < 0) break; // no progress
      }

      // Tallies are recomputed server-side from RoleAuditLog; the client does
      // not supply counts, because the reviewable header exists precisely to be
      // trusted over the client's own account of what it did.
      await finish.mutateAsync({ batchId: preview.batchId });
      setFinished(true);
      setToast("Import complete");
      await utils.admin.listUsers.invalidate();
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      setFinished(true);
    }
  };

  return (
    <>
      <Toast
        content={toast}
        type="success"
        show={toast !== ""}
        onClose={() => setToast("")}
      />

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {step === "input" && (
        <BulkInputStep
          isPending={previewMutation.isPending}
          onPreview={(rows: BulkRow[], mode) => {
            setError(null);
            setRequestedByLine(new Map(rows.map((r) => [r.lineNo, r.roles])));
            previewMutation.mutate({
              mode,
              rows: rows.map((r) => ({
                lineNo: r.lineNo,
                identifier: r.identifier,
                roles: r.roles as ("admin" | "jcrc" | "cca_head")[],
              })),
            });
          }}
        />
      )}

      {step === "review" && preview && (
        <BulkPreviewTable
          preview={preview}
          onBack={() => setStep("input")}
          onCommit={(rows) => void runCommit(rows)}
        />
      )}

      {step === "commit" && preview && (
        <BulkCommitProgress
          done={done}
          total={total}
          results={results}
          finished={finished}
          onViewAudit={() =>
            router.push(`/admin/audit?batchId=${preview.batchId}`)
          }
          onUndo={() => undo.mutate({ batchId: preview.batchId })}
          undoPending={undo.isPending}
        />
      )}
    </>
  );
}
