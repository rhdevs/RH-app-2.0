/** The longest CCA description printed in the CCA table, in characters. */
export const CCA_DESCRIPTION_MAX = 180;

/**
 * A CCA's description as the transcript prints it, inline in the CCA's row:
 * whitespace collapsed; when longer than 180 characters, cut at the last word
 * boundary at or before 180 and ended with "…" (a single word longer than that
 * is cut at 180). Empty when there is none: the cell is left blank.
 */
export function ccaDescriptionText(raw: string | null | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= CCA_DESCRIPTION_MAX) return text;
  const boundary = text.lastIndexOf(" ", CCA_DESCRIPTION_MAX);
  const cut = boundary > 0 ? boundary : CCA_DESCRIPTION_MAX;
  return `${text.slice(0, cut).trimEnd()}…`;
}
