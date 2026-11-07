import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two equipment return-photo routes with everything behind them replaced:
 * the session, the database, the access checks and the store. What is under
 * test is what the ROUTES do with each outcome: one bare 404 for every "no",
 * the flag checked first, the headers on the bytes, no redirect, no store
 * address in any body, and the order of checks.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enabled: vi.fn(),
  limit: vi.fn(),
  authorizeRead: vi.fn(),
  authorizeUpload: vi.fn(),
  read: vi.fn(),
  handleUpload: vi.fn(),
}));

vi.mock("~/server/auth", () => ({ auth: mocks.auth }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/services/equipment/flag", () => ({
  EQUIPMENT_DISABLED: "EQUIPMENT_DISABLED",
  assertEquipmentEnabled: mocks.enabled,
}));
vi.mock("~/server/api/services/equipment/limits", () => ({
  assertWithinLimit: mocks.limit,
}));
vi.mock("~/server/api/services/equipment/read", () => ({
  authorizePhotoRead: mocks.authorizeRead,
}));
vi.mock("~/server/api/services/equipment/access", () => ({
  EQUIPMENT_ACCESS_CHECK_FAILED: "EQUIPMENT_ACCESS_CHECK_FAILED",
  NOT_EVENT_LEADER: "NOT_EVENT_LEADER",
}));
vi.mock("~/server/api/services/equipment/photo", () => ({
  authorizeReturnPhotoUpload: mocks.authorizeUpload,
  EQUIPMENT_BAD_PATHNAME: "BAD_PATHNAME",
  EQUIPMENT_PHOTO_TOO_MANY: "EQUIPMENT_PHOTO_TOO_MANY",
}));
vi.mock("~/server/api/services/equipment/transition", () => ({
  EQUIPMENT_BAD_MOVE: "EQUIPMENT_BAD_MOVE",
}));
vi.mock("~/server/api/services/milestoneBlob", () => ({
  MILESTONE_STORAGE_NOT_CONFIGURED: "MILESTONE_STORAGE_NOT_CONFIGURED",
  evidenceErrorCode: (e: unknown) => (e instanceof Error ? e.name : typeof e),
  evidenceStorage: { read: mocks.read, remove: vi.fn() },
  handleEvidenceUpload: mocks.handleUpload,
}));

const { GET } = await import("../[id]/route");
const { POST } = await import("../upload/route");

const ID = "a".repeat(24);
const STORE_ADDRESS = "teststore.private.blob.vercel-storage.com";

const get = (id = ID) =>
  GET(new Request(`https://app.test/api/equipment-return/${id}`), {
    params: { id },
  });
const bytes = (n: number, chunks = 1) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < chunks; i += 1) c.enqueue(new Uint8Array(n / chunks));
      c.close();
    },
  });
const photo = {
  pathname: `equipment-return/${ID}/photo-ab12cd.webp`,
  contentType: "image/webp",
  size: 1000,
};
const trpc = (code: TRPCError["code"], message: string) =>
  new TRPCError({ code, message });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue({ user: { userID: "E1234567" } });
  mocks.enabled.mockResolvedValue(undefined);
  mocks.limit.mockResolvedValue(undefined);
  mocks.authorizeRead.mockResolvedValue(photo);
  mocks.read.mockImplementation(() =>
    Promise.resolve({
      size: 1000,
      contentType: "image/webp",
      stream: bytes(1000),
    }),
  );
});

describe("GET /api/equipment-return/[id]", () => {
  it("serves the bytes with the stored type and the locked-down headers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="return.webp"',
    );
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("location")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(mocks.authorizeRead).toHaveBeenCalledWith(
      expect.anything(),
      "E1234567",
      ID,
    );
    expect(mocks.read).toHaveBeenCalledWith(photo.pathname);
  });

  it("checks the flag before it looks at the loan", async () => {
    mocks.enabled.mockRejectedValue(trpc("FORBIDDEN", "EQUIPMENT_DISABLED"));
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(mocks.authorizeRead).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("answers one bare 404 to a signed-out visitor, without checking anything", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.enabled).not.toHaveBeenCalled();
    expect(mocks.authorizeRead).not.toHaveBeenCalled();
  });

  it.each(["short", "g".repeat(24), `${"a".repeat(23)}/`, "a".repeat(25)])(
    "answers a bare 404 to a malformed id (%s) without touching the database",
    async (id) => {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(mocks.authorizeRead).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["not found", trpc("NOT_FOUND", "EQUIPMENT_NOT_FOUND")],
    ["forbidden", trpc("FORBIDDEN", "NOT_EVENT_LEADER")],
    ["a failed guard read", trpc("FORBIDDEN", "EQUIPMENT_ACCESS_CHECK_FAILED")],
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
    mocks.limit.mockRejectedValue(trpc("TOO_MANY_REQUESTS", "RATE_LIMITED:42"));
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
      ...photo,
      contentType: "image/svg+xml",
    });
    expect((await get()).status).toBe(503);
    mocks.authorizeRead.mockResolvedValue({
      ...photo,
      size: 4 * 1024 * 1024 + 1,
    });
    expect((await get()).status).toBe(503);
    expect(mocks.read).not.toHaveBeenCalled();
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

describe("POST /api/equipment-return/upload", () => {
  const post = (body: unknown = { type: "blob.generate-client-token" }) =>
    POST(
      new Request("https://app.test/api/equipment-return/upload", {
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
    mocks.authorizeUpload.mockResolvedValue({ loanID: ID });
    mocks.handleUpload.mockImplementation(
      async (args: {
        onBeforeGenerateToken: (p: string) => Promise<Record<string, unknown>>;
      }) => {
        const options = await args.onBeforeGenerateToken(
          `equipment-return/${ID}/photo.webp`,
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
    const validUntil = options.validUntil as number;
    expect(validUntil).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    expect(validUntil).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    expect(JSON.stringify(options)).not.toMatch(/svg/i);
    expect(mocks.authorizeUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "E1234567",
      `equipment-return/${ID}/photo.webp`,
    );
    const args = mocks.handleUpload.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("onUploadCompleted");
  });

  it("passes a known refusal through and turns anything else into UPLOAD_FAILED", async () => {
    for (const known of [
      "EQUIPMENT_DISABLED",
      "NOT_EVENT_LEADER",
      "EQUIPMENT_ACCESS_CHECK_FAILED",
      "EQUIPMENT_PHOTO_TOO_MANY",
      "EQUIPMENT_BAD_MOVE",
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
    expect((await post()).status).toBe(429);
  });

  it("answers UPLOAD_FAILED when the body is not JSON", async () => {
    const res = await POST(
      new Request("https://app.test/api/equipment-return/upload", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "UPLOAD_FAILED" });
  });
});
