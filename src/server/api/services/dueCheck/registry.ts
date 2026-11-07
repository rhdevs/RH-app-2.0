import { ccaNoDirectorKind } from "./ccaNoDirector";
import type { DueKind } from "./types";

/**
 * Every timed notice the due check knows. TO ADD ONE, add its entry here and
 * nothing else: the runner reads this list and is not touched. A kind that
 * needs a new index must have its script run before its flag goes on.
 *
 * Phase 4 (disposable digest and nudges) and phase 5 (milestone reminders)
 * register here.
 */
export const DUE_KINDS: readonly DueKind[] = [ccaNoDirectorKind];
