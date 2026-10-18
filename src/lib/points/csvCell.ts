/**
 * One RFC 4180 cell. With `guard`, a leading = + - @ tab or carriage return gets an apostrophe
 * first (neutralise, THEN quote — the order matters, see serializeCsv's csvField
 * in src/app/events/_lib/format.ts), so a name that starts with a formula
 * character cannot execute when the file is opened in Excel.
 */
export function csvCell(value: string, guard: boolean): string {
  const safe = guard && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
