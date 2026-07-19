// PREVIEW RENDERING AND CHUNKING ONLY.
//
// Nothing in this file is an enforcement mechanism. Role stickiness is
// applyRoleChange's `$pull(removed) + $addToSet(added)` where
// `removed ⊆ GRANTABLE_ROLES` and `resident ∉ GRANTABLE_ROLES` (I-8c).
// Editing this file makes the PREVIEW wrong, never the write.

import { STICKY } from "~/server/api/services/roles";
// ^ imported, NEVER redeclared. A local copy of the sticky list is precisely how
//   the preview and the server drift, and the drift is invisible: the After
//   column would simply stop matching the committed rolesAfter.

/**
 * Mirrors what the server will actually do, so the preview's `After` column is
 * truthful.
 *
 * An `After` column that omits a role the server cannot remove is a PREVIEW
 * BUG, and it shows up as a mismatch between the previewed After and the
 * committed `rolesAfter` in the audit log. Treat any such mismatch as a defect
 * here — never as a reason to make the server honour the payload verbatim.
 */
export function computeAfter(
  before: readonly string[],
  requested: readonly string[],
  mode: "add" | "set",
): string[] {
  if (mode === "add") return [...new Set([...before, ...requested])];
  return [
    ...new Set([...requested, ...STICKY.filter((r) => before.includes(r))]),
  ];
}

/**
 * 10, sized against MEASURED cost rather than an estimate.
 *
 * The previous value was 25, derived from "5 Atlas round-trips at ~60ms ≈
 * 300ms per row". Production says otherwise: audit timestamps from a real
 * import are ~2s apart, so a row costs roughly 2s, not 0.3s — about 7x the
 * assumption. At 25 rows that is ~50s.
 *
 * The damage was not theoretical. An 11-row JCRC import ran twice and landed
 * exactly 7 rows both times: the function hit Vercel's DEFAULT ceiling
 * (maxDuration was never exported from the tRPC route, which planClient itself
 * flagged as out of scope) and was killed mid-loop at ~14s. The 7 committed
 * rows were audited correctly; the last 4 left no trace anywhere, because the
 * request that would have written them never returned. BulkRoleImport.finishedAt
 * stayed null — the one signal that the run had been cut short.
 *
 * 10 rows x ~2s ≈ 20s, comfortably inside the 60s the route now declares, and
 * still inside the 25-row cap `commitBulkChunk` enforces at the zod boundary.
 * Re-measure both this and maxDuration against a real 500-row import before
 * the full JCRC onboarding (03 §10.5) — and re-measure from audit timestamps,
 * not from a per-query estimate.
 */
export const CHUNK = 10;

export function chunk<T>(rows: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Split a pasted blob into identifiers. Whitespace, commas and semicolons. */
export function splitPasted(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
