/**
 * Singapore calendar keys for server-side bucketing. Stats grouped by the UTC
 * date put anything after midnight but before 08:00 SGT on the previous day;
 * the hall runs on Singapore time, so its days and weeks do too.
 *
 * Singapore has no daylight saving, so a fixed +8h offset is exact.
 */
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** "YYYY-MM-DD" of the Singapore calendar day containing `at`. */
export function sgtDayKey(at: Date): string {
  return new Date(at.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" of the Monday starting the Singapore week containing `at`. */
export function sgtWeekStartKey(at: Date): string {
  const shifted = new Date(at.getTime() + SGT_OFFSET_MS);
  const sinceMonday = (shifted.getUTCDay() + 6) % 7;
  const monday = new Date(shifted.getTime() - sinceMonday * 86_400_000);
  return monday.toISOString().slice(0, 10);
}
