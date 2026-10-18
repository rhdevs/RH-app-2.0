import { describe, expect, it, vi } from "vitest";
import {
  WRITE_CONFLICT_ATTEMPTS,
  YEAR_WRITE_ATTEMPTS,
  isWriteConflict,
  retryWriteConflicts,
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

  it("takes a larger bound when given one (year-scoped writes, S2)", async () => {
    const write = vi.fn().mockRejectedValue(conflict());

    await expect(
      retryWriteConflicts(write, noWait, YEAR_WRITE_ATTEMPTS),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(write).toHaveBeenCalledTimes(YEAR_WRITE_ATTEMPTS);
    expect(YEAR_WRITE_ATTEMPTS).toBeGreaterThan(WRITE_CONFLICT_ATTEMPTS);
  });

  it("never retries any other error", async () => {
    const duplicate = Object.assign(new Error("dup"), { code: "P2002" });
    const write = vi.fn().mockRejectedValue(duplicate);

    await expect(retryWriteConflicts(write, noWait)).rejects.toBe(duplicate);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
