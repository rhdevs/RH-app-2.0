/**
 * The matric as the resident search shows it: the first character and the last
 * three, everything between them hidden, length preserved
 * ("A0225829W" -> "A*****29W"). Enough for a head to tell two residents apart,
 * not enough to use as an identifier. A value of four characters or fewer is
 * hidden entirely. PURE.
 *
 * (The public verify page hides more: only the first and last character. See
 * maskMatric in services/transcript/issue.ts.)
 */
export function maskMatricForSearch(matric: string): string {
  if (matric.length <= 4) return "*".repeat(matric.length);
  return `${matric[0]}${"*".repeat(matric.length - 4)}${matric.slice(-3)}`;
}
