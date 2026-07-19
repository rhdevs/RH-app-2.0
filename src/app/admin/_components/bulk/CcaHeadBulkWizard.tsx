"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api, type RouterOutputs } from "~/trpc/react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import Toast from "~/app/_components/Toast";

import { CHUNK } from "../../_lib/planClient";
import BulkCommitProgress, { type CommitResult } from "./BulkCommitProgress";
import CcaHeadInputStep, { type CcaHeadRow } from "./CcaHeadInputStep";
import CcaHeadPreviewTable, {
  type CommittableCcaHeadItem,
} from "./CcaHeadPreviewTable";
import type { CcaOption } from "./CcaPicker";

type Preview = RouterOutputs["admin"]["previewBulkCcaHeads"];

/**
 * The same three-step shape as BulkImportWizard — input, review, commit — over
 * the CCA-head procedures instead of the generic role ones.
 *
 * It is a SEPARATE wizard on purpose, and not a mode of the existing one.
 * `cca_head` is in no ASSIGNABLE_BY entry (I-14), so the generic path would
 * refuse every row it was given; more importantly, only the CCA endpoints write
 * the `cca_head` string and the scoped CcaHead record in one transaction, which
 * is what keeps the two from drifting apart (CH-1). This wizard drives those
 * endpoints and adds no writer of its own.
 */
export default function CcaHeadBulkWizard() {
  const router = useRouter();
  const utils = api.useUtils();

  const [cca, setCca] = useState<CcaOption | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [step, setStep] = useState<"input" | "review" | "commit">("input");
  const [results, setResults] = useState<CommitResult[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const previewMutation = api.admin.previewBulkCcaHeads.useMutation({
    onSuccess: (data) => {
      setPreview(data);
      setStep("review");
    },
    onError: (e) =>
      setError(
        e.message.startsWith("RATE_LIMITED")
          ? "Too many previews in the last hour. The preview is rate-limited because it accepts up to 1000 identifiers and returns the matching people."
          : e.message === "CCA_NOT_FOUND"
            ? "That CCA no longer exists. Reload the page and pick again."
            : e.message,
      ),
  });

  const commitChunk = api.admin.commitBulkCcaHeadChunk.useMutation();

  const runCommit = async (rows: CommittableCcaHeadItem[]) => {
    if (!preview) return;
    setStep("commit");
    setResults([]);
    setDone(0);
    setTotal(rows.length);
    setFinished(false);
    setError(null);

    try {
      // A work QUEUE, not a fixed chunk list, for the reason BulkImportWizard
      // documents: a chunk cut short by the platform timeout resumes from
      // lastLineNo instead of being retried blind.
      let queue = [...rows].sort((a, b) => a.lineNo - b.lineNo);
      const collected: CommitResult[] = [];

      while (queue.length > 0) {
        const slice = queue.slice(0, CHUNK);
        const res = await commitChunk.mutateAsync({
          batchId: preview.batchId,
          ccaID: preview.ccaID,
          expiresAt: preview.expiresAt,
          rows: slice.map((r) => ({
            lineNo: r.lineNo,
            userID: r.userID,
            // Echoed back verbatim. The server signed the rowToken over these
            // exact values, so any edit here fails the signature rather than
            // committing something the preview never showed.
            expectedBefore: r.expectedBefore as (
              | "admin"
              | "jcrc"
              | "cca_head"
            )[],
            via: r.via,
            confidence: r.confidence,
            rowToken: r.rowToken,
          })),
        });

        collected.push(...res.results);
        setResults([...collected]);
        setDone(collected.length);

        queue = queue.filter(
          (r) =>
            r.lineNo > res.lastLineNo &&
            !res.results.some((x) => x.lineNo === r.lineNo),
        );
        if (res.results.length === 0 && res.lastLineNo < 0) break; // no progress
      }

      setFinished(true);
      const refused = collected.filter((r) => r.status === "denied").length;
      // Do NOT claim success when rows failed.
      setToast(
        refused > 0
          ? `${refused} people were refused — see the list below`
          : `CCA heads assigned for ${preview.ccaName}`,
      );
      await utils.admin.listCcaHeads.invalidate();
      await utils.admin.listUsers.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assignment failed");
      setFinished(true);
    }
  };

  const startAnother = () => {
    setPreview(null);
    setResults([]);
    setDone(0);
    setTotal(0);
    setFinished(false);
    setError(null);
    setStep("input");
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">
          Assign CCA heads in bulk
        </h2>
        <p className="text-sm text-gray-500">
          Pick one CCA, paste the NUSNET ids or NUS email addresses of its
          heads, check the preview, then confirm. Each person gets a head record
          for that CCA and the CCA head role, written together so they cannot
          come apart. Repeat for the next CCA.
        </p>
      </div>

      <Toast
        content={toast}
        type={results.some((r) => r.status === "denied") ? "danger" : "success"}
        show={toast !== ""}
        onClose={() => setToast("")}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {step === "input" && (
        <CcaHeadInputStep
          cca={cca}
          onCcaChange={setCca}
          isPending={previewMutation.isPending}
          onPreview={(rows: CcaHeadRow[]) => {
            if (!cca) return;
            setError(null);
            previewMutation.mutate({ ccaID: cca.ccaID, rows });
          }}
        />
      )}

      {step === "review" && preview && (
        <CcaHeadPreviewTable
          preview={preview}
          onBack={() => setStep("input")}
          onCommit={(rows) => void runCommit(rows)}
        />
      )}

      {step === "commit" && preview && (
        <>
          <BulkCommitProgress
            done={done}
            total={total}
            results={results}
            finished={finished}
            onViewAudit={() =>
              router.push(`/admin/audit?batchId=${preview.batchId}`)
            }
            failureNote={
              <>
                Refused people are already recorded in the audit log with{" "}
                <code>ok: false</code>, under this run&apos;s batch id. Nobody
                was half-assigned: a refused row wrote neither the head record
                nor the role. Fix the identifier or the permission and run those
                people again.
              </>
            }
          />
          {finished && (
            <Button variant="outline" onClick={startAnother}>
              Assign heads for another CCA
            </Button>
          )}
        </>
      )}
    </div>
  );
}
