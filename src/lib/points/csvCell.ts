/**
 * One RFC 4180 cell. With `guard`, a leading = + - @ (after any spaces or tabs),
 * a full-width ＝ ＋ － ＠, a pipe, a tab or a carriage return gets an apostrophe
 * first (neutralise, THEN quote — the order matters, see serializeCsv's csvField
 * in src/app/events/_lib/format.ts), so a name that starts with a formula
 * character cannot execute when the file is opened in Excel.
 */
const FORMULA_START = /^(?:[ \t]*[=+\-@]|[\t\r]|[＝＋－＠|])/;

export function csvCell(value: string, guard: boolean): string {
  const safe = guard && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
