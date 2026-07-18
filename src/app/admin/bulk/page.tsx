"use client";

import { useState } from "react";

import BulkImportWizard from "../_components/bulk/BulkImportWizard";
import BulkImportHistory from "../_components/bulk/BulkImportHistory";
import PendingGrantsPanel from "../_components/bulk/PendingGrantsPanel";

export default function AdminBulkPage() {
  // Bumped on a completed import so the history table refetches without
  // reaching into its internals.
  const [, setNonce] = useState(0);

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
      <BulkImportHistory />
      <PendingGrantsPanel />
    </div>
  );
}
