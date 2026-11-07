import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two evidence routes with everything behind them replaced: the session,
 * the database, the access checks and the store. What is under test is what the
 * ROUTES do with each outcome: one refusal for every "no", the headers on the
 * bytes, no redirect, no store address in any body, and the order of checks.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  authorizeRead: vi.fn(),
  authorizeUpload: vi.fn(),
  read: vi.fn(),
  handleUpload: vi.fn(),
}));

vi.mock("~/server/auth", () => ({ auth: mocks.auth }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/services/milestones/read", () => ({
  authorizeEvidenceRead: mocks.authorizeRead,
}));
vi.mock("~/server/api/services/milestones/write", () => ({
  authorizeEvidenceUpload: mocks.authorizeUpload,
  EVIDENCE_BAD_PATHNAME: "BAD_PATHNAME",
  EVIDENCE_TOO_MANY: "EVIDENCE_TOO_MANY",
}));
vi.mock("~/server/api/services/milestoneBlob", () => ({
  MILESTONE_STORAGE_NOT_CONFIGURED: "MILESTONE_STORAGE_NOT_CONFIGURED",
  // The real one maps SDK error classes to codes; the stand-in names the error.
  evidenceErrorCode: (e: unknown) => (e instanceof Error ? e.name : typeof e),
  evidenceStorage: { read: mocks.read, remove: vi.fn() },
  handleEvidenceUpload: mocks.handleUpload,
}));

const { GET } = await import("../[id]/route");
const { POST } = await import("../upload/route");

const ID = "a".repeat(24);
const STORE_ADDRESS = "teststore.private.blob.vercel-storage.com";

const get = (id = ID) =>
  GET(new Request(`https://app.test/api/milestone-evidence/${id}`), {
    params: { id },
  });
const bytes = (n: number, chunks = 1) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < chunks; i += 1) c.enqueue(new Uint8Array(n / chunks));
      c.close();
    },
  });
const evidence = {
  pathname: "milestone-evidence/9803/evidence-x.webp",
  contentType: "image/webp",
  size: 1000,
};
const trpc = (code: TRPCError["code"], message: string) =>
  new TRPCError({ code, message });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue({ user: { userID: "E1234567" } });
  mocks.authorizeRead.mockResolvedValue(evidence);
  mocks.read.mockImplementation(() =>
    Promise.resolve({
      size: 1000,
      contentType: "image/webp",
      stream: bytes(1000),
    }),
  );
});

describe("GET /api/milestone-evidence/[id]", () => {
  it("serves the bytes with the stored type and the locked-down headers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    // No length header: the SDK can report 0, and a wrong one cuts the photo off.
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="evidence.webp"',
    );
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("location")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(mocks.authorizeRead).toHaveBeenCalledWith(
      expect.anything(),
      "E1234567",
      ID,
    );
    expect(mocks.read).toHaveBeenCalledWith(evidence.pathname);
  });

  it("sends the whole photo when the store reports a size of 0", async () => {
    mocks.read.mockImplementation(() =>
      Promise.resolve({
        size: 0,
        contentType: "image/webp",
        stream: bytes(1000, 4),
      }),
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  it("still cuts off a body longer than the bound when the store reports a size of 0", async () => {
    mocks.read.mockResolvedValue({
      size: 0,
      contentType: "image/webp",
      stream: bytes(5 * 1024 * 1024, 5),
    });
    const res = await get();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("names the file by the stored type, never by anything the file claims", async () => {
    mocks.authorizeRead.mockResolvedValue({
      ...evidence,
      contentType: "image/png",
    });
    expect((await get()).headers.get("content-disposition")).toBe(
      'inline; filename="evidence.png"',
    );
    mocks.authorizeRead.mockResolvedValue({
      ...evidence,
      contentType: "image/jpeg",
    });
    expect((await get()).headers.get("content-disposition")).toBe(
      'inline; filename="evidence.jpg"',
    );
  });

  it("answers one bare 404 to a signed-out visitor, without checking anything", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRead).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    ["not found", trpc("NOT_FOUND", "EVIDENCE_NOT_FOUND")],
    ["forbidden", trpc("FORBIDDEN", "NOT_EVIDENCE_READER")],
    ["a failed guard read", trpc("FORBIDDEN", "MILESTONE_ACCESS_CHECK_FAILED")],
    ["the flag off", trpc("NOT_FOUND", "EVIDENCE_NOT_FOUND")],
  ])(
    "answers the same bare 404 for %s, and never reads the store",
    async (_n, err) => {
      mocks.authorizeRead.mockRejectedValue(err);
      const res = await get();
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found");
      expect(res.headers.get("location")).toBeNull();
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it("answers 429 with Retry-After when the budget is spent", async () => {
    mocks.authorizeRead.mockRejectedValue(
      trpc("TOO_MANY_REQUESTS", "RATE_LIMITED:42"),
    );
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("answers 503 when the access check itself breaks, logging only the error name", async () => {
    const err = new Error("secret detail mongodb://user:pw@host");
    err.name = "PrismaClientInitializationError";
    mocks.authorizeRead.mockRejectedValue(err);
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Unavailable");
    const logged = String(vi.mocked(console.error).mock.calls[0]?.[0]);
    expect(JSON.parse(logged).error).toBe("PrismaClientInitializationError");
    expect(logged).not.toContain("secret");
  });

  it("answers 503 when the store cannot be read, without leaking why", async () => {
    mocks.read.mockRejectedValue(new Error(`failed ${STORE_ADDRESS}`));
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(STORE_ADDRESS);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).not.toContain(
      STORE_ADDRESS,
    );
  });

  it("answers the same 404 when the file is gone from the store", async () => {
    mocks.read.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("refuses a row whose type or size is outside the allowlist, before the store is read", async () => {
    mocks.authorizeRead.mockResolvedValue({
      ...evidence,
      contentType: "image/svg+xml",
    });
    expect((await get()).status).toBe(503);
    mocks.authorizeRead.mockResolvedValue({
      ...evidence,
      contentType: "text/html",
    });
    expect((await get()).status).toBe(503);
    mocks.authorizeRead.mockResolvedValue({
      ...evidence,
      size: 4 * 1024 * 1024 + 1,
    });
    expect((await get()).status).toBe(503);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("refuses and cancels a stored file that is larger than the bound", async () => {
    const stream = bytes(10);
    const cancel = vi.spyOn(stream, "cancel");
    mocks.read.mockResolvedValue({
      size: 4 * 1024 * 1024 + 1,
      contentType: "image/webp",
      stream,
    });
    expect((await get()).status).toBe(503);
    expect(cancel).toHaveBeenCalled();
  });

  it("cuts the body off if the store sends more than the bound", async () => {
    mocks.read.mockResolvedValue({
      size: 1000,
      contentType: "image/webp",
      stream: bytes(5 * 1024 * 1024, 5),
    });
    const res = await get();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});

describe("POST /api/milestone-evidence/upload", () => {
  const post = (body: unknown = { type: "blob.generate-client-token" }) =>
    POST(
      new Request("https://app.test/api/milestone-evidence/upload", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

  beforeEach(() => {
    mocks.handleUpload.mockResolvedValue({ clientToken: "fake" });
  });

  it("answers a signed-out caller before the store is looked at", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("mints a token only with the access check inside, fixing type, size and suffix", async () => {
    mocks.authorizeUpload.mockResolvedValue({ ccaID: 9803 });
    mocks.handleUpload.mockImplementation(
      async (args: {
        onBeforeGenerateToken: (p: string) => Promise<Record<string, unknown>>;
      }) => {
        const options = await args.onBeforeGenerateToken(
          "milestone-evidence/9803/evidence.webp",
        );
        return { options };
      },
    );
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { options } = (await res.json()) as {
      options: Record<string, unknown>;
    };
    expect(options).toMatchObject({
      allowedContentTypes: ["image/webp", "image/png", "image/jpeg"],
      maximumSizeInBytes: 4 * 1024 * 1024,
      addRandomSuffix: true,
    });
    // A token lasts about five minutes, not the SDK's default hour.
    const validUntil = options.validUntil as number;
    expect(validUntil).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    expect(validUntil).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    expect(JSON.stringify(options)).not.toMatch(/svg/i);
    expect(mocks.authorizeUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "E1234567",
      "milestone-evidence/9803/evidence.webp",
    );
    const args = mocks.handleUpload.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("onUploadCompleted");
  });

  it("passes a known refusal through and turns anything else into UPLOAD_FAILED", async () => {
    for (const known of [
      "MILESTONES_DISABLED",
      "NOT_EVIDENCE_HEAD",
      "MILESTONE_ACCESS_CHECK_FAILED",
      "EVIDENCE_TOO_MANY",
      "BAD_PATHNAME",
      "MILESTONE_STORAGE_NOT_CONFIGURED",
    ]) {
      mocks.handleUpload.mockRejectedValue(new Error(known));
      expect(await (await post()).json()).toEqual({ error: known });
    }
    mocks.handleUpload.mockRejectedValue(
      new Error(`boom ${STORE_ADDRESS} vercel_blob_rw_x_y`),
    );
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "UPLOAD_FAILED" });
  });

  it("answers 429 for a spent budget", async () => {
    mocks.handleUpload.mockRejectedValue(new Error("RATE_LIMITED:30"));
    const res = await post();
    expect(res.status).toBe(429);
  });

  it("answers UPLOAD_FAILED when the body is not JSON", async () => {
    const res = await POST(
      new Request("https://app.test/api/milestone-evidence/upload", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "UPLOAD_FAILED" });
  });
});
