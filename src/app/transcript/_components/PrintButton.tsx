"use client";

import { Printer } from "lucide-react";

/** "Save as PDF" is the browser's own print-to-PDF: no PDF library to ship. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
    >
      <Printer className="h-4 w-4" />
      Save as PDF
    </button>
  );
}
