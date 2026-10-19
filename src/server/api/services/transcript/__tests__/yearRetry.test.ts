import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { errorText } from "~/lib/transcript/adminView";
import { RECORDS_BUSY, retryYearConflicts } from "../yearRetry";

const conflict = () =>
  Object.assign(new Error("Transaction failed due to a write conflict"), {
    code: "P2034",
  });
const noWait = () => Promise.resolve();

describe("retryYearConflicts", () => {
  it("returns what the write returns once it gets through", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue("saved");
    await expect(retryYearConflicts(write, { wait: noWait })).resolves.toBe(
      "saved",
    );
  });

  it("turns exhausted retries into CONFLICT RECORDS_BUSY, never a raw P2034", async () => {
    const write = vi.fn().mockRejectedValue(conflict());
    const error = await retryYearConflicts(write, {
      wait: noWait,
      clock: () => 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: "CONFLICT", message: RECORDS_BUSY });
    expect((error as TRPCError).cause).toMatchObject({ code: "P2034" });
  });

  it("passes any other error through untouched", async () => {
    const refused = new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "PERIOD_PUBLISHED",
    });
    await expect(
      retryYearConflicts(() => Promise.reject(refused), { wait: noWait }),
    ).rejects.toBe(refused);
  });

  it("is explained on screen in plain words", () => {
    expect(errorText(RECORDS_BUSY)).toBe(
      "Someone else is saving right now. Please try again.",
    );
  });
});
