"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import AuditLogTable from "../_components/audit/AuditLogTable";

/**
 * §12.1. Several distinct failures present identically to a user ("I can't
 * book"). This table is rendered on the page whoever is on support already has
 * open, rather than living in a document they will not find at 2am.
 */
const TRIAGE = [
  {
    code: "MATRIC_REQUIRED",
    cause: "No UserMatric row; MatricGate bounced them.",
    fix: "They complete /onboarding/matric. NOT a role problem.",
  },
  {
    code: "NOT_RESIDENT (ineligible)",
    cause: "Canonical userID retains an @, i.e. not a verified NUS address.",
    fix: "Check the health panel. The account needs its email corrected or merged. The baseline is correctly absent — this is not a bug.",
  },
  {
    code: "NOT_RESIDENT (eligible, missing baseline)",
    cause:
      "NUS-eligible account whose UserRole row lacks resident — a failed grant write, a missed backfill, or a manual DB edit.",
    fix: "It should have self-healed at sign-in; have them reload. If it persists the UserRole write is failing — check baseline_repair_failed in the logs and re-run the backfill. Appears in the health panel's red MISSING tile.",
  },
  {
    code: "ROLE_REQUIRED",
    cause: "Genuine gated-room attempt.",
    fix: "Grant the role, or tell them no.",
  },
  {
    code: "CONFLICT_ROLES_CHANGED",
    cause: "Bulk row skipped; target changed between preview and commit.",
    fix: "Re-run the preview.",
  },
  {
    code: "DIVERGED_SINCE_IMPORT",
    cause:
      "Undo skipped this row because the user's roles changed after the import.",
    fix: "Intentional. Reverting a later deliberate change is worse than a partial undo — set their roles by hand if the revert was wanted.",
  },
];

function AuditPageInner() {
  const params = useSearchParams();
  return <AuditLogTable initialBatchId={params.get("batchId") ?? undefined} />;
}

export default function AdminAuditPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Audit log</h1>
        <p className="text-sm text-gray-500">
          Append-only. Bulk operations collapse into one entry per batch.
        </p>
      </div>

      <Suspense
        fallback={<div className="text-sm text-gray-500">Loading…</div>}
      >
        <AuditPageInner />
      </Suspense>

      <Accordion
        type="single"
        collapsible
        className="rounded-xl bg-white px-4 shadow-lg"
      >
        <AccordionItem value="triage">
          <AccordionTrigger className="text-sm">
            Denial triage — why someone says &quot;I can&apos;t book&quot;
          </AccordionTrigger>
          <AccordionContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Error code</TableHead>
                    <TableHead>Cause</TableHead>
                    <TableHead>Fix</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {TRIAGE.map((t) => (
                    <TableRow key={t.code}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {t.code}
                      </TableCell>
                      <TableCell className="text-xs text-gray-600">
                        {t.cause}
                      </TableCell>
                      <TableCell className="text-xs text-gray-600">
                        {t.fix}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
