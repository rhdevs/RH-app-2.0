import { describe, expect, it } from "vitest";
import { lockRetryDelayMs } from "../events";

describe("lockRetryDelayMs", () => {
  it("waits at least 1ms even when the dice roll zero", () => {
    expect(lockRetryDelayMs(0, () => 0)).toBe(1);
    expect(lockRetryDelayMs(10, () => 0)).toBe(1);
  });

  it("doubles the ceiling with each attempt", () => {
    const top = () => 0.999999;
    expect(lockRetryDelayMs(0, top)).toBe(25);
    expect(lockRetryDelayMs(1, top)).toBe(50);
    expect(lockRetryDelayMs(2, top)).toBe(100);
    expect(lockRetryDelayMs(3, top)).toBe(200);
  });

  it("never waits more than 400ms, however many attempts", () => {
    const top = () => 0.999999;
    expect(lockRetryDelayMs(4, top)).toBe(400);
    expect(lockRetryDelayMs(60, top)).toBe(400);
  });

  it("spreads waiting signups across the window", () => {
    expect(lockRetryDelayMs(3, () => 0.5)).toBe(101);
  });
});
