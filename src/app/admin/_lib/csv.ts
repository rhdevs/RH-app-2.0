/**
 * RFC4180 subset parser. ~40 lines, no dependency — 03 §15 / ground truth 9 are
 * explicit that no CSV dep is to be added for this.
 *
 * Handles: quoted fields, embedded commas, embedded newlines, and the ""
 * escape. Does NOT handle: alternate delimiters, or a BOM beyond the one
 * stripped below. Anything it cannot resolve becomes an ordinary field value
 * and surfaces as an unresolvable row in the preview, which is the visible,
 * fixable failure mode rather than a silent mis-parse.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Drop a trailing blank line rather than emitting a phantom 1-empty-field
    // row, which would otherwise preview as an unresolvable identifier.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Column roles the mapper can assign. `ignore` is explicit, not the absence of
 *  a choice, so an unmapped column is always a deliberate decision. */
export const CSV_COLUMN_KINDS = [
  "identifier",
  "email",
  "nusnet",
  "matric",
  "name",
  "block",
  "roles",
  "ignore",
] as const;
export type CsvColumnKind = (typeof CSV_COLUMN_KINDS)[number];

/**
 * Header auto-guess. Always operator-overridable in <CsvColumnMapper> — a wrong
 * guess that cannot be corrected is worse than no guess.
 */
export function guessColumnKind(header: string): CsvColumnKind {
  const h = header.trim().toLowerCase();
  if (h.includes("mail")) return "email";
  if (/nusnet|nus_?net|\bid\b|userid/.test(h)) return "nusnet";
  if (/matric|student.*(no|num)/.test(h)) return "matric";
  if (/role|position/.test(h)) return "roles";
  if (/block|hostel|wing/.test(h)) return "block";
  if (h.includes("name")) return "name";
  return "ignore";
}
