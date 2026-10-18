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
 * The bound for a year-scoped write (see yearWrite): every such write touches
 * the year's period row, so saves at the same moment conflict for as long as
 * a transaction runs, and the loser needs more, longer waits to get through.
 */
export const YEAR_WRITE_ATTEMPTS = 8;

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
