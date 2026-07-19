"use client";

import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { splitPasted } from "../../_lib/planClient";
import CcaPicker, { type CcaOption } from "./CcaPicker";

export type CcaHeadRow = { lineNo: number; identifier: string };

const MAX_ROWS = 1000;

/**
 * Mirrors BulkInputStep, minus the role picker: on this surface the role is not
 * a choice. There is exactly one thing this screen grants — CCA headship of the
 * chosen CCA — and there is no replace mode, because the write is additive.
 */
export default function CcaHeadInputStep({
  cca,
  onCcaChange,
  onPreview,
  isPending,
}: {
  cca: CcaOption | null;
  onCcaChange: (cca: CcaOption | null) => void;
  onPreview: (rows: CcaHeadRow[]) => void;
  isPending: boolean;
}) {
  const [paste, setPaste] = useState("");

  const rows: CcaHeadRow[] = splitPasted(paste).map((identifier, i) => ({
    lineNo: i + 1,
    identifier,
  }));

  const tooMany = rows.length > MAX_ROWS;
  const canPreview = cca !== null && rows.length > 0 && !tooMany && !isPending;

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-sm font-medium text-gray-700">CCA</p>
        <CcaPicker value={cca?.ccaID ?? null} onChange={onCcaChange} />
        <p className="mt-2 text-xs text-gray-500">
          One CCA per run. Everyone in the list below becomes a head of this CCA
          and of no other. To onboard a second CCA, finish this run and start
          another.
        </p>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-700">People</p>
        <Textarea
          rows={8}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={"E1234567\nE7654321\nalice@u.nus.edu"}
          className="font-mono text-sm"
        />
        <p className="mt-2 text-xs text-gray-500">
          One identifier per line, or separated by spaces, commas or semicolons.
          NUSNET ids and @u.nus.edu addresses resolve; names and matric numbers
          do not.
        </p>
      </div>

      <Alert>
        <AlertTitle>What the next step does</AlertTitle>
        <AlertDescription>
          The preview is a dry run. It resolves each identifier, tells you who
          is already a head of this CCA, and writes nothing at all — no records,
          no audit entries. Nothing changes until you confirm on the screen
          after it.
        </AlertDescription>
      </Alert>

      {tooMany && (
        <Alert variant="destructive">
          <AlertDescription>
            {rows.length} rows — the limit is {MAX_ROWS} per run. Split the
            list.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button
          className="bg-emerald-700 text-white hover:bg-emerald-800"
          disabled={!canPreview}
          onClick={() => onPreview(rows)}
        >
          {isPending ? "Checking…" : `Preview ${rows.length} people`}
        </Button>
        {cca === null && rows.length > 0 && (
          <span className="text-xs text-gray-500">Choose a CCA first.</span>
        )}
      </div>
    </div>
  );
}
