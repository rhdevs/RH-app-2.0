/**
 * MongoDB aborts the loser of two overlapping transactions with a write
 * conflict: Prisma reports it as P2034 ("Transaction failed due to a write
 * conflict or a deadlock"), the driver labels it TransientTransactionError.
 * Nothing was written by the aborted transaction, so running it again is safe.
 */
export function isWriteConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; errorLabels?: unknown };
  if (e.code === "P2034") return true;
  return (
    Array.isArray(e.errorLabels) &&
    e.errorLabels.includes("TransientTransactionError")
  );
}

/** How many times a write is tried in all before the conflict is passed on. */
export const WRITE_CONFLICT_ATTEMPTS = 3;

/**
 * The bounds for a year-scoped write (see yearWrite). Every such write ends by
 * touching the year's period row, so two saves that overlap conflict there and
 * the loser runs again. It is tried at least YEAR_WRITE_MIN_ATTEMPTS times, then
 * again while the time since the first try stays inside YEAR_WRITE_BUDGET_MS, never more
 * than YEAR_WRITE_MAX_ATTEMPTS times in all.
 */
export const YEAR_WRITE_MIN_ATTEMPTS = 3;
export const YEAR_WRITE_MAX_ATTEMPTS = 40;
export const YEAR_WRITE_BUDGET_MS = 5_000;
const YEAR_BACKOFF_BASE_MS = 20;
const YEAR_BACKOFF_CAP_MS = 800;

/**
 * The wait before attempt `n + 1` of a year-scoped write: exponential (20, 40,
 * 80 ... ms, at most 800 ms), with half of it random so that writers that lost
 * to the same save do not all come back at the same moment.
 */
export function yearBackoff(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    YEAR_BACKOFF_CAP_MS,
    YEAR_BACKOFF_BASE_MS * 2 ** (attempt - 1),
  );
  return ceiling / 2 + random() * (ceiling / 2);
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** A short, jittered wait before attempt `n + 1`: about 10-30 ms, then 20-60 ms. */
const backoff = (attempt: number) => (10 + Math.random() * 20) * attempt;

/**
 * Run `write` again when it loses a write conflict, up to `attempts`
 * (WRITE_CONFLICT_ATTEMPTS by default) times in all, with a short jittered
 * wait between tries. Any other error, or the last conflict, is thrown as it
 * is. `write` must re-read what it depends on each time it runs: a retry
 * starts afresh.
 */
export async function retryWriteConflicts<T>(
  write: () => Promise<T>,
  wait: (ms: number) => Promise<void> = pause,
  attempts: number = WRITE_CONFLICT_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (!isWriteConflict(error) || attempt >= attempts) {
        throw error;
      }
      await wait(backoff(attempt));
    }
  }
}

export interface BudgetOptions {
  wait?: (ms: number) => Promise<void>;
  /** Milliseconds, for the budget; Date.now by default. */
  clock?: () => number;
  random?: () => number;
}

/**
 * Run `write` again when it loses a write conflict, with the year-write bounds
 * above: at least YEAR_WRITE_MIN_ATTEMPTS tries, more while the time since the
 * first try plus the next wait stays inside YEAR_WRITE_BUDGET_MS, at most
 * YEAR_WRITE_MAX_ATTEMPTS. Any other error, or the last conflict, is thrown as
 * it is. `write` must re-read what it depends on each time it runs.
 */
export async function retryWithinBudget<T>(
  write: () => Promise<T>,
  options: BudgetOptions = {},
): Promise<T> {
  const wait = options.wait ?? pause;
  const clock = options.clock ?? Date.now;
  const started = clock();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (!isWriteConflict(error) || attempt >= YEAR_WRITE_MAX_ATTEMPTS) {
        throw error;
      }
      const delay = yearBackoff(attempt, options.random);
      const outOfTime = clock() - started + delay > YEAR_WRITE_BUDGET_MS;
      if (attempt >= YEAR_WRITE_MIN_ATTEMPTS && outOfTime) throw error;
      await wait(delay);
    }
  }
}
