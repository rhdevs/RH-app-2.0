import {
  currentAcademicYear,
  isValidAcademicYear,
} from "~/lib/transcript/academicYear";

/**
 * AUX: hall participation counted for points. PURE: no clock, no database.
 *
 * Every AUX event is worth exactly 1 per check-in, a record-only event is
 * worth 1 per listed resident, and JCRC's manual awards add their amount. The
 * cap and the conversion to points live in the sandbox, never here.
 */

/** A manual award's amount: a whole number in this range. */
export const AUX_AWARD_MIN = 1;
export const AUX_AWARD_MAX = 20;

export const AUX_TEXT_MAX = 120;

/** The most lines one paste may resolve. */
export const AUX_PASTE_MAX_LINES = 500;

/** Reason chips on the award form. Free text is allowed too. */
export const AUX_REASON_PRESETS = [
  "Fire warden (Sem 1)",
  "Fire warden (Sem 2)",
] as const;

export function isValidAuxAmount(n: number): boolean {
  return Number.isInteger(n) && n >= AUX_AWARD_MIN && n <= AUX_AWARD_MAX;
}

/** Presses from this month on (0-based: May) start the coming academic year. */
const NEW_YEAR_LEAD_MONTH = 4;
const AY_START_MONTH = 7;
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * The points year a "Start new points year" press begins. Points bidding
 * ends in April, so a press from May to July is preparing the coming academic
 * year; any other press starts the one it falls in. A second press in the
 * same year keeps the year, so AUX carries on rather than starting again.
 */
export function pointsYearStartedAt(pressedAt: Date): string {
  const month = new Date(pressedAt.getTime() + SGT_OFFSET_MS).getUTCMonth();
  const early = month >= NEW_YEAR_LEAD_MONTH && month < AY_START_MONTH;
  if (!early) return currentAcademicYear(pressedAt);
  const ahead = new Date(pressedAt);
  ahead.setUTCMonth(AY_START_MONTH);
  return currentAcademicYear(ahead);
}

/**
 * The points year AUX counts towards: the year JCRC last started with "Start
 * new points year", or the calendar's academic year before that was ever
 * pressed.
 */
export function auxYearOf(
  pointsYear: string | null | undefined,
  now: Date,
): string {
  return pointsYear && isValidAcademicYear(pointsYear)
    ? pointsYear
    : currentAcademicYear(now);
}

export type AuxTotal = {
  userID: string;
  /** Check-ins at AUX events plus record-only events. */
  fromEvents: number;
  fromAwards: number;
  total: number;
};

/** One resident per row, in userID order; only residents with a source appear. */
export function tallyAux(input: {
  eventCheckIns: readonly { userID: string }[];
  recordAttendees: readonly { userID: string }[];
  awards: readonly { userID: string; amount: number }[];
}): AuxTotal[] {
  const events = new Map<string, number>();
  const awards = new Map<string, number>();
  for (const r of [...input.eventCheckIns, ...input.recordAttendees]) {
    events.set(r.userID, (events.get(r.userID) ?? 0) + 1);
  }
  for (const a of input.awards) {
    awards.set(a.userID, (awards.get(a.userID) ?? 0) + a.amount);
  }
  const ids = [...new Set([...events.keys(), ...awards.keys()])].sort();
  return ids.map((userID) => {
    const fromEvents = events.get(userID) ?? 0;
    const fromAwards = awards.get(userID) ?? 0;
    return { userID, fromEvents, fromAwards, total: fromEvents + fromAwards };
  });
}

export type IdentifierLine = { line: number; raw: string };

const HEADER_WORDS = new Set([
  "matric",
  "email",
  "nusnet",
  "id",
  "name",
  "amount",
  "aux",
]);

const unquote = (cell: string | undefined): string =>
  (cell ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();

const LINE_BREAK = /\r?\n/;
const CELL_BREAK = /[,\t;]/;

/** Non-blank, non-header lines as cells, repeats of the first cell dropped. */
function pastedRows(text: string): { line: number; cells: string[] }[] {
  const seen = new Set<string>();
  const out: { line: number; cells: string[] }[] = [];
  text.split(LINE_BREAK).forEach((lineText, i) => {
    const cells = lineText.split(CELL_BREAK).map(unquote);
    const first = cells[0] ?? "";
    if (!first || HEADER_WORDS.has(first.toLowerCase())) return;
    const key = first.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line: i + 1, cells });
  });
  return out;
}

/**
 * A pasted list (or an uploaded CSV) as one identifier per line, keeping the
 * 1-based line number so unknown entries can be listed back. Takes the first
 * cell of each line, so "matric,name" rows work. Skips blank lines, a header
 * line and repeats (case-insensitive, first line kept).
 */
export function parseIdentifierLines(text: string): IdentifierLine[] {
  return pastedRows(text).map((r) => ({ line: r.line, raw: r.cells[0]! }));
}

export type AmountLine = IdentifierLine & { amount: number | null };

/**
 * "identifier, amount" per line, for carrying over totals as awards. The
 * amount is null when the second cell is missing or not a valid amount, so the
 * line can be listed back rather than guessed.
 */
export function parseAmountLines(text: string): AmountLine[] {
  return pastedRows(text).map((r) => {
    const cell = r.cells[1] ?? "";
    const n = /^\d+$/.test(cell) ? Number(cell) : Number.NaN;
    return {
      line: r.line,
      raw: r.cells[0]!,
      amount: isValidAuxAmount(n) ? n : null,
    };
  });
}
