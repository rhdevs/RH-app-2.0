import { describe, expect, it, vi } from "vitest";

import { createMarkRetry, RETRY_DELAY_MS } from "../_components/MarkOpened";

vi.mock("~/trpc/react", () => ({ api: {} }));

describe("MarkOpened retry (F25)", () => {
  it("a failure leads to exactly one more call after the delay, however many fail", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const onError = createMarkRetry(send);

    onError();
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RETRY_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);

    onError();
    vi.advanceTimersByTime(RETRY_DELAY_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
