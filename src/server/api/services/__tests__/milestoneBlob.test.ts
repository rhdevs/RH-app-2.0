import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one module that talks to the private evidence store. Nothing real is
 * called: the SDK and the environment are replaced. The thing under test is the
 * rule that a missing or wrong private token REFUSES and can never fall back to
 * the public store's token.
 */

const PRIVATE = "vercel_blob_rw_PrivStore1_secretsecret1";
const PUBLIC = "vercel_blob_rw_PubStore22_secretsecret2";

const mocks = vi.hoisted(() => {
  class BlobNotFoundError extends Error {
    constructor() {
      super("not found");
      this.name = "BlobNotFoundError";
    }
  }
  return {
    env: {} as Record<string, string | undefined>,
    BlobNotFoundError,
    head: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    handleUpload: vi.fn(),
  };
});

vi.mock("~/env", () => ({ env: mocks.env }));
vi.mock("@vercel/blob", () => ({
  BlobNotFoundError: mocks.BlobNotFoundError,
  head: mocks.head,
  get: mocks.get,
  del: mocks.del,
}));
vi.mock("@vercel/blob/client", () => ({ handleUpload: mocks.handleUpload }));

const {
  evidenceStorage,
  evidenceToken,
  handleEvidenceUpload,
  isEvidenceStorageConfigured,
  MILESTONE_STORAGE_NOT_CONFIGURED,
} = await import("../milestoneBlob");

beforeEach(() => {
  mocks.env.MILESTONE_BLOB_READ_WRITE_TOKEN = PRIVATE;
  mocks.env.BLOB_READ_WRITE_TOKEN = PUBLIC;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("evidenceToken", () => {
  it("returns the private token when it is set and names another store", () => {
    expect(evidenceToken()).toBe(PRIVATE);
    expect(isEvidenceStorageConfigured()).toBe(true);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["not a read-write token", "not-a-token"],
    ["a token with a missing part", "vercel_blob_rw_PrivStore1"],
  ])("refuses when the private token is %s", (_name, value) => {
    mocks.env.MILESTONE_BLOB_READ_WRITE_TOKEN = value;
    expect(() => evidenceToken()).toThrow(MILESTONE_STORAGE_NOT_CONFIGURED);
    expect(isEvidenceStorageConfigured()).toBe(false);
  });

  it("refuses when it names the same store as the public token, in any letter case", () => {
    mocks.env.MILESTONE_BLOB_READ_WRITE_TOKEN =
      "vercel_blob_rw_PubStore22_other";
    expect(() => evidenceToken()).toThrow(MILESTONE_STORAGE_NOT_CONFIGURED);
    mocks.env.MILESTONE_BLOB_READ_WRITE_TOKEN =
      "vercel_blob_rw_pubstore22_other";
    expect(() => evidenceToken()).toThrow(MILESTONE_STORAGE_NOT_CONFIGURED);
  });

  it("never returns the public token", () => {
    mocks.env.MILESTONE_BLOB_READ_WRITE_TOKEN = undefined;
    expect(() => evidenceToken()).toThrow(MILESTONE_STORAGE_NOT_CONFIGURED);
    expect(mocks.head).not.toHaveBeenCalled();
  });
});

describe("evidenceStorage with no private token", () => {
  beforeEach(() => {
    mocks.env.MILESTONE_BLOB_READ_WRITE_TOKEN = undefined;
  });

  it("refuses every call and never reaches the SDK", async () => {
    expect(() => evidenceStorage.host()).toThrow(
      MILESTONE_STORAGE_NOT_CONFIGURED,
    );
    await expect(evidenceStorage.head("a")).rejects.toThrow(
      MILESTONE_STORAGE_NOT_CONFIGURED,
    );
    await expect(evidenceStorage.read("a")).rejects.toThrow(
      MILESTONE_STORAGE_NOT_CONFIGURED,
    );
    // remove never throws, but it reports that nothing was removed.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await evidenceStorage.remove("a")).toBe(false);
    expect(() =>
      handleEvidenceUpload({
        body: {} as never,
        request: new Request("https://example.test"),
        onBeforeGenerateToken: () => Promise.resolve({}) as never,
      }),
    ).toThrow(MILESTONE_STORAGE_NOT_CONFIGURED);
    for (const fn of [mocks.head, mocks.get, mocks.del, mocks.handleUpload]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("evidenceStorage", () => {
  it("names the private store's host, lower-cased", () => {
    expect(evidenceStorage.host()).toBe(
      "privstore1.private.blob.vercel-storage.com",
    );
  });

  it("passes the private token explicitly on every call", async () => {
    mocks.head.mockResolvedValue({ size: 10, contentType: "image/webp" });
    mocks.get.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream(),
      blob: { size: 10, contentType: "image/webp" },
    });
    mocks.del.mockResolvedValue(undefined);
    mocks.handleUpload.mockResolvedValue({
      type: "blob.generate-client-token",
    });

    expect(await evidenceStorage.head("p")).toEqual({
      size: 10,
      contentType: "image/webp",
    });
    expect(await evidenceStorage.read("p")).toMatchObject({ size: 10 });
    expect(await evidenceStorage.remove("p")).toBe(true);
    await handleEvidenceUpload({
      body: {} as never,
      request: new Request("https://example.test"),
      onBeforeGenerateToken: () => Promise.resolve({}) as never,
    });

    expect(mocks.head).toHaveBeenCalledWith("p", { token: PRIVATE });
    expect(mocks.get).toHaveBeenCalledWith("p", {
      access: "private",
      token: PRIVATE,
    });
    expect(mocks.del).toHaveBeenCalledWith("p", { token: PRIVATE });
    expect(mocks.handleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ token: PRIVATE }),
    );
    expect(JSON.stringify(mocks.handleUpload.mock.calls)).not.toContain(PUBLIC);
  });

  it("does not pass an onUploadCompleted callback to the upload handler", async () => {
    mocks.handleUpload.mockResolvedValue({});
    await handleEvidenceUpload({
      body: {} as never,
      request: new Request("https://example.test"),
      onBeforeGenerateToken: () => Promise.resolve({}) as never,
    });
    const args = mocks.handleUpload.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("onUploadCompleted");
  });

  it("answers null for a file that is not in the store", async () => {
    mocks.head.mockRejectedValue(new mocks.BlobNotFoundError());
    expect(await evidenceStorage.head("p")).toBeNull();
    mocks.get.mockResolvedValue(null);
    expect(await evidenceStorage.read("p")).toBeNull();
    mocks.get.mockResolvedValue({ statusCode: 304 });
    expect(await evidenceStorage.read("p")).toBeNull();
  });

  it("lets a store fault on head or read through, so the caller can fail cleanly", async () => {
    mocks.head.mockRejectedValue(new Error("boom"));
    await expect(evidenceStorage.head("p")).rejects.toThrow("boom");
    mocks.get.mockRejectedValue(new Error("boom"));
    await expect(evidenceStorage.read("p")).rejects.toThrow("boom");
  });

  it("remove counts a file already gone as removed", async () => {
    mocks.del.mockRejectedValue(new mocks.BlobNotFoundError());
    expect(await evidenceStorage.remove("p")).toBe(true);
  });

  it("remove swallows a failure, reports false and logs only the error name", async () => {
    const secret = "message with vercel_blob_rw_Secret_value and a path";
    const err = new Error(secret);
    err.name = "BlobServiceNotAvailable";
    mocks.del.mockRejectedValue(err);
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(await evidenceStorage.remove("p")).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      evt: "milestone_evidence_delete_failed",
      error: "BlobServiceNotAvailable",
    });
    expect(line).not.toContain("Secret");
    expect(line).not.toContain(secret);
  });
});
