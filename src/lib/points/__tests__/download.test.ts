import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REVOKE_DELAY_MS, downloadCsvFile } from "~/lib/points/download";

describe("downloadCsvFile", () => {
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  const createUrl = vi.fn((_blob: Blob) => "blob:test");
  const revokeUrl = vi.fn((_url: string) => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    anchor.click.mockReset();
    anchor.remove.mockReset();
    appendChild.mockReset();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    createUrl.mockClear();
    revokeUrl.mockClear();
    vi.stubGlobal("URL", {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("clicks a temporary link named after the file", () => {
    downloadCsvFile("points_1_20270401.csv", "a,b\r\n");
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(anchor.href).toBe("blob:test");
    expect(anchor.download).toBe("points_1_20270401.csv");
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
  });

  it("does not revoke the URL synchronously, only after the delay", () => {
    downloadCsvFile("x.csv", "a");
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS - 1);
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:test");
  });

  it("still revokes later, and rethrows, when the click throws", () => {
    anchor.click.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => downloadCsvFile("x.csv", "a")).toThrow("blocked");
    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(revokeUrl).toHaveBeenCalledTimes(1);
  });
});
