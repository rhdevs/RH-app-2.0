import { describe, expect, it, vi } from "vitest";
import {
  WRITE_CONFLICT_ATTEMPTS,
  YEAR_WRITE_BUDGET_MS,
  YEAR_WRITE_MAX_ATTEMPTS,
  YEAR_WRITE_MIN_ATTEMPTS,
  isWriteConflict,
  retryWithinBudget,
  retryWriteConflicts,
  yearBackoff,
} from "../writeConflict";

const conflict = () =>
  Object.assign(new Error("Transaction failed due to a write conflict"), {
    code: "P2034",
  });
const noWait = () => Promise.resolve();

describe("isWriteConflict", () => {
  it("knows Prisma's P2034 and the driver's TransientTransactionError label", () => {
    expect(isWriteConflict(conflict())).toBe(true);
    expect(
      isWriteConflict({ errorLabels: ["TransientTransactionError"] }),
    ).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isWriteConflict({ code: "P2002" })).toBe(false);
    expect(isWriteConflict(new Error("boom"))).toBe(false);
    expect(isWriteConflict(null)).toBe(false);
    expect(isWriteConflict("P2034")).toBe(false);
  });
});

describe("retryWriteConflicts", () => {
  it("runs once when the write succeeds", async () => {
    const write = vi.fn().mockResolvedValue("done");
    await expect(retryWriteConflicts(write, noWait)).resolves.toBe("done");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("runs again after a write conflict, waiting a little in between", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue("done");
    const wait = vi.fn((_ms: number) => noWait());

    await expect(retryWriteConflicts(write, wait)).resolves.toBe("done");
    expect(write).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    for (const [ms] of wait.mock.calls) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(100);
    }
  });

  it("gives up after the bound and throws the last conflict", async () => {
    const write = vi.fn().mockRejectedValue(conflict());

    await expect(retryWriteConflicts(write, noWait)).rejects.toMatchObject({
      code: "P2034",
    });
    expect(write).toHaveBeenCalledTimes(WRITE_CONFLICT_ATTEMPTS);
    expect(WRITE_CONFLICT_ATTEMPTS).toBe(3);
  });

  it("never retries any other error", async () => {
    const duplicate = Object.assign(new Error("dup"), { code: "P2002" });
    const write = vi.fn().mockRejectedValue(duplicate);

    await expect(retryWriteConflicts(write, noWait)).rejects.toBe(duplicate);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("yearBackoff", () => {
  it("doubles from 20 ms up to 800 ms, with half of each wait random", () => {
    const low = (n: number) => yearBackoff(n, () => 0);
    const high = (n: number) => yearBackoff(n, () => 1);
    expect([1, 2, 3, 4, 5, 6, 7].map(high)).toEqual([
      20, 40, 80, 160, 320, 640, 800,
    ]);
    expect(high(30)).toBe(800);
    expect(low(1)).toBe(10);
    expect(low(7)).toBe(400);
  });
});

describe("retryWithinBudget (year-scoped writes)", () => {
  /** A clock that moves only when the retry waits. */
  const fakeTime = () => {
    let now = 0;
    const waits: number[] = [];
    return {
      clock: () => now,
      wait: (ms: number) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
      waits,
    };
  };

  it("keeps trying through a burst of conflicts and returns the result", async () => {
    const time = fakeTime();
    const write = vi.fn();
    for (let i = 0; i < 10; i += 1) write.mockRejectedValueOnce(conflict());
    write.mockResolvedValue("done");

    await expect(retryWithinBudget(write, time)).resolves.toBe("done");
    expect(write).toHaveBeenCalledTimes(11);
    // Exponential: each wait is at least half the one before it would double to.
    for (let i = 1; i < time.waits.length; i += 1) {
      expect(time.waits[i]).toBeGreaterThanOrEqual(
        Math.min(400, time.waits[i - 1]! / 2),
      );
    }
  });

  it("stops inside the time budget and throws the last conflict", async () => {
    const time = fakeTime();
    const write = vi.fn().mockRejectedValue(conflict());

    await expect(retryWithinBudget(write, time)).rejects.toMatchObject({
      code: "P2034",
    });
    const waited = time.waits.reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(YEAR_WRITE_BUDGET_MS);
    expect(waited).toBeGreaterThan(YEAR_WRITE_BUDGET_MS - 800);
    expect(write.mock.calls.length).toBeLessThanOrEqual(
      YEAR_WRITE_MAX_ATTEMPTS,
    );
  });

  it("tries a slow write at least the minimum number of times", async () => {
    let now = 0;
    // Every try takes 4 s, so the budget is gone after the first one.
    const write = vi.fn(() => {
      now += 4_000;
      return Promise.reject(conflict());
    });

    await expect(
      retryWithinBudget(write, { clock: () => now, wait: noWait }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(write).toHaveBeenCalledTimes(YEAR_WRITE_MIN_ATTEMPTS);
  });

  it("never runs more than the hard cap, even with no time passing", async () => {
    const write = vi.fn().mockRejectedValue(conflict());

    await expect(
      retryWithinBudget(write, { clock: () => 0, wait: noWait }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(write).toHaveBeenCalledTimes(YEAR_WRITE_MAX_ATTEMPTS);
  });

  it("never retries any other error", async () => {
    const duplicate = Object.assign(new Error("dup"), { code: "P2002" });
    const write = vi.fn().mockRejectedValue(duplicate);

    await expect(retryWithinBudget(write, { wait: noWait })).rejects.toBe(
      duplicate,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });
});
