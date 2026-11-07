import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one module that talks to the private evidence store. Nothing real is
 * called: the SDK and the environment are replaced. The thing under test is the
 * rule that a missing or wrong private token REFUSES and can never fall back to
 * the public store's token.
 */

const PRIVATE = "vercel_blob_rw_PrivStore1_secretsecret1";
const PUBLIC = "vercel_blob_rw_PubStore22_secretsecret2";
const ADDRESS = (pathname: string) =>
  `https://privstore1.private.blob.vercel-storage.com/${pathname}`;

const mocks = vi.hoisted(() => {
  // The SDK's errors never set `name`; these do the same, so a log line that
  // used the name would say "Error" for every one of them.
  class BlobError extends Error {}
  const sub = (label: string) =>
    class extends BlobError {
      constructor() {
        super(
          `${label} secret-detail https://x.private.blob.vercel-storage.com/p`,
        );
      }
    };
  return {
    env: {} as Record<string, string | undefined>,
    BlobError,
    BlobNotFoundError: sub("not found"),
    BlobAccessError: sub("access"),
    BlobClientTokenExpiredError: sub("expired"),
    BlobContentTypeNotAllowedError: sub("type"),
    BlobFileTooLargeError: sub("large"),
    BlobPathnameMismatchError: sub("mismatch"),
    BlobRequestAbortedError: sub("aborted"),
    BlobServiceNotAvailable: sub("unavailable"),
    BlobServiceRateLimited: sub("limited"),
    BlobStoreNotFoundError: sub("store"),
    BlobStoreSuspendedError: sub("suspended"),
    BlobUnknownError: sub("unknown"),
    head: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    list: vi.fn(),
    handleUpload: vi.fn(),
  };
});

vi.mock("~/env", () => ({ env: mocks.env }));
vi.mock("@vercel/blob", () => ({
  BlobError: mocks.BlobError,
  BlobNotFoundError: mocks.BlobNotFoundError,
  BlobAccessError: mocks.BlobAccessError,
  BlobClientTokenExpiredError: mocks.BlobClientTokenExpiredError,
  BlobContentTypeNotAllowedError: mocks.BlobContentTypeNotAllowedError,
  BlobFileTooLargeError: mocks.BlobFileTooLargeError,
  BlobPathnameMismatchError: mocks.BlobPathnameMismatchError,
  BlobRequestAbortedError: mocks.BlobRequestAbortedError,
  BlobServiceNotAvailable: mocks.BlobServiceNotAvailable,
  BlobServiceRateLimited: mocks.BlobServiceRateLimited,
  BlobStoreNotFoundError: mocks.BlobStoreNotFoundError,
  BlobStoreSuspendedError: mocks.BlobStoreSuspendedError,
  BlobUnknownError: mocks.BlobUnknownError,
  head: mocks.head,
  get: mocks.get,
  del: mocks.del,
  list: mocks.list,
}));
vi.mock("@vercel/blob/client", () => ({ handleUpload: mocks.handleUpload }));

const {
  evidenceErrorCode,
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
    // remove and listBlobs never throw: nothing removed, nothing listed.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await evidenceStorage.remove("a")).toBe(false);
    expect(await evidenceStorage.listBlobs("a/", 10)).toEqual([]);
    expect(() =>
      handleEvidenceUpload({
        body: {} as never,
        request: new Request("https://example.test"),
        onBeforeGenerateToken: () => Promise.resolve({}) as never,
      }),
    ).toThrow(MILESTONE_STORAGE_NOT_CONFIGURED);
    for (const fn of [
      mocks.head,
      mocks.get,
      mocks.del,
      mocks.list,
      mocks.handleUpload,
    ]) {
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

    // head and del get the full address, as every documented example does.
    expect(mocks.head).toHaveBeenCalledWith(ADDRESS("p"), { token: PRIVATE });
    expect(mocks.get).toHaveBeenCalledWith("p", {
      access: "private",
      token: PRIVATE,
    });
    expect(mocks.del).toHaveBeenCalledWith(ADDRESS("p"), { token: PRIVATE });
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

  it("remove swallows a failure, reports false and logs only a code", async () => {
    // The SDK's errors keep the default name "Error"; the code comes from the class.
    const err = new mocks.BlobServiceNotAvailable();
    expect(err.name).toBe("Error");
    mocks.del.mockRejectedValue(err);
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(await evidenceStorage.remove("p")).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      evt: "milestone_evidence_delete_failed",
      error: "blob_service_unavailable",
    });
    expect(line).not.toContain("secret-detail");
    expect(line).not.toContain("blob.vercel-storage.com");
  });
});

describe("evidenceStorage.listBlobs", () => {
  const blob = (pathname: string) => ({
    pathname,
    url: `https://x/${pathname}`,
    uploadedAt: new Date("2026-01-01T00:00:00Z"),
  });

  it("lists under the prefix with the private token and keeps only pathname and time", async () => {
    mocks.list.mockResolvedValue({ blobs: [blob("a/1.webp")], hasMore: false });
    expect(await evidenceStorage.listBlobs("a/", 50)).toEqual([
      { pathname: "a/1.webp", uploadedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "a/", token: PRIVATE, limit: 50 }),
    );
  });

  it("follows the cursor but never returns more than the limit", async () => {
    mocks.list
      .mockResolvedValueOnce({
        blobs: [blob("a/1.webp"), blob("a/2.webp")],
        hasMore: true,
        cursor: "c1",
      })
      .mockResolvedValueOnce({
        blobs: [blob("a/3.webp"), blob("a/4.webp")],
        hasMore: true,
        cursor: "c2",
      });
    const got = await evidenceStorage.listBlobs("a/", 3);
    expect(got.map((b) => b.pathname)).toEqual([
      "a/1.webp",
      "a/2.webp",
      "a/3.webp",
    ]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list.mock.calls[1]?.[0]).toMatchObject({
      cursor: "c1",
      limit: 1,
    });
  });

  it("answers an empty list and logs only a code when the listing fails", async () => {
    mocks.list.mockRejectedValue(new mocks.BlobStoreSuspendedError());
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(await evidenceStorage.listBlobs("a/", 10)).toEqual([]);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      evt: "milestone_evidence_list_failed",
      error: "blob_store_suspended",
    });
    expect(line).not.toContain("secret-detail");
  });
});

describe("evidenceErrorCode", () => {
  it.each([
    ["BlobNotFoundError", "blob_not_found"],
    ["BlobAccessError", "blob_access_denied"],
    ["BlobStoreNotFoundError", "blob_store_not_found"],
    ["BlobStoreSuspendedError", "blob_store_suspended"],
    ["BlobServiceNotAvailable", "blob_service_unavailable"],
    ["BlobServiceRateLimited", "blob_rate_limited"],
    ["BlobRequestAbortedError", "blob_request_aborted"],
    ["BlobClientTokenExpiredError", "blob_token_expired"],
    ["BlobFileTooLargeError", "blob_file_too_large"],
    ["BlobContentTypeNotAllowedError", "blob_content_type_not_allowed"],
    ["BlobPathnameMismatchError", "blob_pathname_mismatch"],
    ["BlobUnknownError", "blob_unknown"],
  ] as const)("%s logs as %s, with no message in it", (cls, code) => {
    const Ctor = mocks[cls] as new () => Error;
    expect(evidenceErrorCode(new Ctor())).toBe(code);
  });

  it("names the base SDK error, a plain error by its own name, and a non-error by type", () => {
    expect(evidenceErrorCode(new mocks.BlobError("x"))).toBe("blob_error");
    const prisma = new Error("mongodb://user:pw@host");
    prisma.name = "PrismaClientInitializationError";
    expect(evidenceErrorCode(prisma)).toBe("PrismaClientInitializationError");
    expect(evidenceErrorCode(new Error("x"))).toBe("Error");
    expect(evidenceErrorCode("boom")).toBe("string");
    expect(evidenceErrorCode(undefined)).toBe("undefined");
  });
});
