"use client";

import type { RosterDrift } from "~/server/api/services/ccaRoster";

/**
 * A summary of what the roster could NOT cleanly resolve, shown above the table
 * so the counts are visible without scanning every row.
 *
 * Renders NOTHING when everything resolved — a permanently-present "0 problems"
 * banner trains people to ignore the space it occupies, which is exactly where
 * the real warning will later appear.
 *
 * Written for the reader, not the schema: no key formats, no collection names.
 * A CCA head does not know what UserCCA is and should not have to.
 */
export default function RosterDriftNote({ drift }: { drift: RosterDrift }) {
  const notes: string[] = [];

  if (drift.unresolvedCount > 0) {
    notes.push(
      `${drift.unresolvedCount} membership ${
        drift.unresolvedCount === 1 ? "record" : "records"
      } could not be matched to an account`,
    );
  }
  if (drift.ambiguousCount > 0) {
    notes.push(
      `${drift.ambiguousCount} of those match more than one account, so they have not been guessed`,
    );
  }
  if (drift.duplicateUserCcaRows > 0) {
    notes.push(
      `${drift.duplicateUserCcaRows} duplicate membership ${
        drift.duplicateUserCcaRows === 1 ? "record" : "records"
      }`,
    );
  }
  if (drift.headsUnresolved > 0) {
    notes.push(
      `${drift.headsUnresolved} head ${
        drift.headsUnresolved === 1 ? "record has" : "records have"
      } no matching account`,
    );
  }

  if (notes.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-sm font-medium text-amber-900">
        Some records need attention
      </p>
      <ul className="mt-1 list-inside list-disc text-sm text-amber-800">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-amber-700">
        Everyone below is still a member — these records just can&rsquo;t be
        linked to an account. Contact the JCRC if a name looks wrong.
      </p>
    </div>
  );
}
