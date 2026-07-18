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
    ...new Set([
      ...requested,
      ...STICKY.filter((r) => before.includes(r)),
    ]),
  ];
}

/**
 * 25, and the sizing is stated so it can be re-derived rather than cargo-culted:
 * each row costs roughly 5 Atlas round-trips (role read, guard read, the
 * transaction, the audit write) at ~60ms ≈ 300ms, so 25 rows ≈ 7.5s against
 * Vercel's default ceiling. v1's 100-row chunk is ~30s and times out.
 *
 * The server caps commitBulkChunk's `rows` at 25 independently; this constant
 * must not exceed that or every chunk 400s at the zod boundary.
 *
 * `src/app/api/trpc/[trpc]/route.ts` should also export `maxDuration = 60` and
 * the figure re-measured against a real 500-row import before the JCRC
 * onboarding (03 §10.5). That file was out of scope for this change.
 */
export const CHUNK = 25;

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
