"use client";

import { useState } from "react";

import { useCapabilities } from "../_components/AdminCapabilityContext";
import BulkImportWizard from "../_components/bulk/BulkImportWizard";
import BulkImportHistory from "../_components/bulk/BulkImportHistory";
import CcaHeadBulkWizard from "../_components/bulk/CcaHeadBulkWizard";
import PendingGrantsPanel from "../_components/bulk/PendingGrantsPanel";

export default function AdminBulkPage() {
  // Bumped on a completed import so the history table refetches without
  // reaching into its internals.
  const [, setNonce] = useState(0);
  const cap = useCapabilities();

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Bulk roles</h1>
        <p className="text-sm text-gray-500">
          Preview is always a dry run — it writes no audit rows and changes
          nothing. Every row is guarded individually at commit, so partial
          success is normal.
        </p>
      </div>

      <BulkImportWizard onImported={() => setNonce((n) => n + 1)} />

      {/* Rendering only (03 §1.2) — the real gate is
          requireCapability(c, "manageCcaHeads") on both CCA-head procedures.
          Kept a separate section from the wizard above rather than a mode of
          it: CCA headship is not granted through the generic role path, and a
          shared control would suggest it is. */}
      {cap.manageCcaHeads && (
        <div className="border-t border-gray-200 pt-10">
          <CcaHeadBulkWizard />
        </div>
      )}

      <BulkImportHistory />
      <PendingGrantsPanel />
    </div>
  );
}
