import { TRPCError } from "@trpc/server";
import {
  isWriteConflict,
  retryWithinBudget,
  type BudgetOptions,
} from "~/lib/transcript/writeConflict";

/** The code a save gets when it lost to other saves for the whole budget. */
export const RECORDS_BUSY = "RECORDS_BUSY";

/**
 * A write to the year's period row (every year-scoped save, Open's claim, the
 * download-by date, the purge), run again when it loses a write conflict, with
 * the year-write bounds (see retryWithinBudget). When even that runs out, the
 * caller gets a coded CONFLICT the screens explain ("Someone else is saving
 * right now"), never a raw P2034 that would show as "Something went wrong".
 */
export async function retryYearConflicts<T>(
  write: () => Promise<T>,
  options?: BudgetOptions,
): Promise<T> {
  try {
    return await retryWithinBudget(write, options);
  } catch (error) {
    if (!isWriteConflict(error)) throw error;
    throw new TRPCError({
      code: "CONFLICT",
      message: RECORDS_BUSY,
      cause: error,
    });
  }
}
