import { describe, expect, it, vi } from "vitest";
import { retryWithinBudget } from "~/lib/transcript/writeConflict";
import {
  LOCK_MAX_MS,
  LOCK_RETRY_CAP_MS,
  LOCK_TX_MAX_WAIT_MS,
  LOCK_TX_TIMEOUT_MS,
} from "../freeze";
import { CLAIM_MAX_MS, OPEN_STEP_BUDGET_MS } from "../periods";

/** The route allows 60 s (maxDuration); one Open request must end before 50 s. */
const REQUEST_BOUND_MS = 50_000;

describe("one Open request fits the function limit", () => {
  it("step budget plus one lock stays within 50 s", () => {
    expect(OPEN_STEP_BUDGET_MS + LOCK_MAX_MS).toBeLessThanOrEqual(
      REQUEST_BOUND_MS,
    );
  });

  it("step budget plus the claim stays within 50 s", () => {
    expect(OPEN_STEP_BUDGET_MS + CLAIM_MAX_MS).toBeLessThanOrEqual(
      REQUEST_BOUND_MS,
    );
  });

  it("the lock's transaction and retries each fit inside LOCK_MAX_MS", () => {
    expect(LOCK_TX_MAX_WAIT_MS + LOCK_TX_TIMEOUT_MS).toBeLessThanOrEqual(
      LOCK_MAX_MS,
    );
    expect(LOCK_TX_TIMEOUT_MS).toBeLessThanOrEqual(LOCK_MAX_MS);
    expect(LOCK_RETRY_CAP_MS).toBeLessThanOrEqual(LOCK_MAX_MS);
  });

  it("retries with the lock's cap stop before LOCK_RETRY_CAP_MS", async () => {
    let now = 0;
    const conflict = () => Object.assign(new Error("c"), { code: "P2034" });
    // Every try takes 12 s: a third would end past 35 s, so it is not started.
    const write = vi.fn(() => {
      now += 12_000;
      return Promise.reject(conflict());
    });
    await expect(
      retryWithinBudget(write, {
        clock: () => now,
        wait: async () => undefined,
        hardCapMs: LOCK_RETRY_CAP_MS,
      }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(now).toBeLessThanOrEqual(LOCK_RETRY_CAP_MS);
  });
});
