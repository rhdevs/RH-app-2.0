/**
 * Parse the `[ccaID]` route segment.
 *
 * Shared by the dashboard layout and every section page so the four of them
 * cannot drift apart on what counts as a valid id — a section that parsed more
 * loosely than its layout would render inside a shell for a CCA the layout
 * would have 404'd.
 *
 * BOTH checks are load-bearing:
 *   - the regex rejects "12.0", " 12", "+12" and "1e3", all of which Number()
 *     and z.coerce happily accept;
 *   - the range check rejects 0, which is RESERVED (see cascade.ts) and is what
 *     Number("") evaluates to, so an empty segment would otherwise become a
 *     real-looking lookup.
 */
export function parseCcaID(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}
