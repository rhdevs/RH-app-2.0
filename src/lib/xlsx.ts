/**
 * Minimal, dependency-free .xlsx writer — enough to export a single sheet of
 * text cells that Excel (and Numbers / Google Sheets) opens as a real
 * spreadsheet, with no "format/extension mismatch" warning and no npm
 * dependency added to a repo we're keeping lean.
 *
 * An .xlsx is a ZIP of a few XML parts (OOXML / SpreadsheetML). We emit the
 * minimal valid set and store the entries UNCOMPRESSED (ZIP method 0), so the
 * only binary machinery needed is a CRC-32 and the ZIP record layout — no
 * DEFLATE. Member exports are at most a couple of hundred rows, so the size
 * cost of not compressing is negligible.
 *
 * Every cell is written as an inline string (`t="inlineStr"`). That is
 * deliberate: values like a matric number ("A0234567X") or a block ("12") must
 * stay text, never be coerced to a number or a date by Excel's type guessing.
 *
 * Client-only (uses TextEncoder / Blob / document) — import from client
 * components. It never touches the server.
 */

/* --------------------------------- CRC-32 -------------------------------- */

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = (CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------ XML building ----------------------------- */

/** Escape text for an XML text node, dropping characters XML cannot carry. */
function xmlEsc(s: string): string {
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA" … */
function colRef(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${colRef(c)}${r + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(
            value ?? "",
          )}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

function workbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    "</workbook>"
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  "</Types>";

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  "</Relationships>";

/* -------------------------------- ZIP (stored) --------------------------- */

const te = new TextEncoder();

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export function buildXlsx(sheetName: string, rows: string[][]): Uint8Array {
  const parts: { name: string; text: string }[] = [
    { name: "[Content_Types].xml", text: CONTENT_TYPES },
    { name: "_rels/.rels", text: ROOT_RELS },
    { name: "xl/workbook.xml", text: workbookXml(sheetName) },
    { name: "xl/_rels/workbook.xml.rels", text: WORKBOOK_RELS },
    { name: "xl/worksheets/sheet1.xml", text: sheetXml(rows) },
  ];

  const entries = parts.map((p) => {
    const data = te.encode(p.text);
    return { nameBytes: te.encode(p.name), data, crc: crc32(data) };
  });

  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  for (const e of entries) {
    offsets.push(local.length);
    local.push(
      ...u32(0x04034b50), // local file header signature
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // method 0 = stored
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(e.crc),
      ...u32(e.data.length), // compressed size
      ...u32(e.data.length), // uncompressed size
      ...u16(e.nameBytes.length),
      ...u16(0), // extra length
      ...e.nameBytes,
      ...e.data,
    );
  }

  entries.forEach((e, i) => {
    central.push(
      ...u32(0x02014b50), // central directory header signature
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // method
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(e.crc),
      ...u32(e.data.length),
      ...u32(e.data.length),
      ...u16(e.nameBytes.length),
      ...u16(0), // extra length
      ...u16(0), // comment length
      ...u16(0), // disk number start
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(offsets[i]!),
      ...e.nameBytes,
    );
  });

  const eocd: number[] = [
    ...u32(0x06054b50), // end of central directory signature
    ...u16(0), // disk number
    ...u16(0), // disk with central dir
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(local.length), // offset of central directory
    ...u16(0), // comment length
  ];

  return Uint8Array.from([...local, ...central, ...eocd]);
}

/* --------------------------------- Public -------------------------------- */

/** Excel sheet names cap at 31 chars and forbid a handful of characters. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31);
  return cleaned.length > 0 ? cleaned : "Sheet1";
}

/**
 * Build a single-sheet .xlsx from `rows` (first row is treated as headers by
 * the reader, but we do not style it) and trigger a browser download.
 */
export function downloadXlsx(
  filename: string,
  sheetName: string,
  rows: string[][],
): void {
  const bytes = buildXlsx(safeSheetName(sheetName), rows);
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
