import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The poster token route. `handleUpload` is replaced by a stand-in that runs
 * `onBeforeGenerateToken` and hands back what it returned, so the tests see
 * exactly the constraints Blob would be given. No real Blob call, no token.
 */
const h = vi.hoisted(() => ({
  session: null as unknown,
  flag: "on" as "on" | "off" | "absent" | "throws",
  proposal: null as { ccaID: number; status: string } | null,
  heads: [] as Array<{ userID: string; ccaID: number }>,
  headReadFails: false,
  limit: { allowed: true, retryAfter: 0 },
  calls: [] as string[],
}));

vi.mock("@vercel/blob/client", () => ({
  handleUpload: vi.fn(
    async (opts: {
      body: { payload: { pathname: string } };
      onBeforeGenerateToken: (p: string) => Promise<unknown>;
    }) => ({
      type: "blob.generate-client-token",
      granted: await opts.onBeforeGenerateToken(opts.body.payload.pathname),
    }),
  ),
}));
vi.mock("~/server/auth", () => ({
  auth: vi.fn(() => Promise.resolve(h.session)),
}));
vi.mock("~/lib/rateLimit", () => ({
  rateLimit: vi.fn(() => {
    h.calls.push("rateLimit");
    return Promise.resolve(h.limit);
  }),
}));
vi.mock("~/server/db", () => ({
  db: {
    systemFlag: {
      findUnique: vi.fn(() => {
        h.calls.push("flag");
        if (h.flag === "throws") return Promise.reject(new Error("db down"));
        if (h.flag === "absent") return Promise.resolve(null);
        return Promise.resolve({ key: "proposals.enabled", value: h.flag });
      }),
    },
    proposal: {
      findUnique: vi.fn(() => {
        h.calls.push("proposal");
        return Promise.resolve(h.proposal);
      }),
    },
    ccaHead: {
      findFirst: vi.fn(
        ({ where }: { where: { userID: string; ccaID: number } }) => {
          h.calls.push("head");
          if (h.headReadFails) return Promise.reject(new Error("db down"));
          const hit = h.heads.find(
            (r) => r.userID === where.userID && r.ccaID === where.ccaID,
          );
          return Promise.resolve(hit ? { id: "x" } : null);
        },
      ),
    },
  },
}));

import { POST } from "../route";
import {
  PROPOSAL_POSTER_CONTENT_TYPES,
  PROPOSAL_POSTER_MAX_BYTES,
  proposalPosterPath,
} from "~/lib/schemas/proposalFiles";

const ME = "E1000001";
const ID = "0123456789abcdef01234567";
const CCA = 7;

type Granted = {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  addRandomSuffix: boolean;
  tokenPayload: string;
};

async function mint(pathname = proposalPosterPath(ID)) {
  const res = await POST(
    new Request("http://localhost/api/proposal/upload", {
      method: "POST",
      body: JSON.stringify({ payload: { pathname } }),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as { error?: string; granted?: Granted },
  };
}

beforeEach(() => {
  h.session = { user: { userID: ME } };
  h.flag = "on";
  h.proposal = { ccaID: CCA, status: "draft" };
  h.heads = [{ userID: ME, ccaID: CCA }];
  h.headReadFails = false;
  h.limit = { allowed: true, retryAfter: 0 };
  h.calls = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("minting a poster token", () => {
  it("grants images only, capped, with a random suffix, to a head of a draft", async () => {
    const { status, body } = await mint();
    expect(status).toBe(200);
    expect(body.granted).toMatchObject({
      allowedContentTypes: [...PROPOSAL_POSTER_CONTENT_TYPES],
      maximumSizeInBytes: PROPOSAL_POSTER_MAX_BYTES,
      addRandomSuffix: true,
    });
    expect(body.granted?.tokenPayload).toBe(JSON.stringify({ proposalID: ID }));
    // The browser sends the file straight to the store; nothing here reads it.
    expect(h.calls).toEqual(["flag", "proposal", "head", "rateLimit"]);
  });

  it("refuses a declared non-image: the grant allows no PDF, SVG or HTML", async () => {
    const { body } = await mint();
    const allowed = body.granted?.allowedContentTypes ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    for (const type of allowed) expect(type.startsWith("image/")).toBe(true);
    for (const bad of [
      "application/pdf",
      "image/svg+xml",
      "text/html",
      "*/*",
    ]) {
      expect(allowed).not.toContain(bad);
    }
  });

  it("refuses an oversized declared upload: the grant caps the size at 2 MB", async () => {
    const { body } = await mint();
    expect(body.granted?.maximumSizeInBytes).toBe(2 * 1024 * 1024);
  });

  it("also works for a returned proposal (needs_action)", async () => {
    h.proposal = { ccaID: CCA, status: "needs_action" };
    expect((await mint()).status).toBe(200);
  });

  it("refuses when proposals are switched off, before touching any proposal row", async () => {
    h.flag = "off";
    const { status, body } = await mint();
    expect(status).toBe(400);
    expect(body.error).toBe("PROPOSALS_DISABLED");
    expect(h.calls).toEqual(["flag"]);
  });

  it("refuses when the flag row is missing", async () => {
    h.flag = "absent";
    expect((await mint()).body.error).toBe("PROPOSALS_DISABLED");
    expect(h.calls).toEqual(["flag"]);
  });

  it("fails closed when the flag cannot be read", async () => {
    h.flag = "throws";
    const { status, body } = await mint();
    expect(status).toBe(400);
    expect(body.error).toBe("PROPOSALS_DISABLED");
    expect(h.calls).toEqual(["flag"]);
  });

  it("refuses a signed-out caller before reading anything", async () => {
    h.session = null;
    expect((await mint()).body.error).toBe("UNAUTHENTICATED");
    expect(h.calls).toEqual([]);
  });

  it("refuses a caller with no canonical identity", async () => {
    h.session = { user: { userID: null } };
    expect((await mint()).body.error).toBe("UNAUTHENTICATED");
    expect(h.calls).toEqual([]);
  });

  it("refuses a path that is not a proposal poster, such as an Event banner", async () => {
    for (const bad of [
      "event/12/banner",
      `proposal/${ID}/photo`,
      `proposal/${ID}/poster/../../event/1/banner`,
      "../poster",
    ]) {
      h.calls = [];
      const { body } = await mint(bad);
      expect(body.error).toBe("BAD_PATHNAME");
      expect(h.calls).toEqual(["flag"]);
    }
  });

  it("refuses a person who does not head the proposal's CCA, and says only NOT_FOUND", async () => {
    h.heads = [];
    const { status, body } = await mint();
    expect(status).toBe(400);
    expect(body.error).toBe("PROPOSAL_NOT_FOUND");
    expect(h.calls).not.toContain("rateLimit");
  });

  it("refuses a head of another CCA with the same answer as a missing proposal", async () => {
    h.heads = [{ userID: ME, ccaID: CCA + 1 }];
    const other = await mint();
    h.proposal = null;
    const missing = await mint();
    expect(other.body).toEqual(missing.body);
    expect(other.body.error).toBe("PROPOSAL_NOT_FOUND");
  });

  it("does not let an admin role stand in for headship", async () => {
    h.session = { user: { userID: ME, roles: ["admin", "jcrc", "cca_head"] } };
    h.heads = [];
    expect((await mint()).body.error).toBe("PROPOSAL_NOT_FOUND");
  });

  it("refuses when the head lookup fails, without leaking the error", async () => {
    h.headReadFails = true;
    const { status, body } = await mint();
    expect(status).toBe(400);
    expect(body.error).toBe("UPLOAD_FAILED");
    expect(h.calls).not.toContain("rateLimit");
  });

  it.each(["in_review", "cleared", "finished", "canceled", "mystery"])(
    "refuses a proposal that is %s",
    async (status) => {
      h.proposal = { ccaID: CCA, status };
      const res = await mint();
      expect(res.body.error).toBe("PROPOSAL_NOT_EDITABLE");
      expect(res.body.granted).toBeUndefined();
      expect(h.calls).not.toContain("rateLimit");
    },
  );

  it("refuses past the hourly ceiling with a 429 and no token", async () => {
    h.limit = { allowed: false, retryAfter: 90 };
    const { status, body } = await mint();
    expect(status).toBe(429);
    expect(body.error).toBe("RATE_LIMITED:90");
    expect(body.granted).toBeUndefined();
  });

  it("charges the ceiling only after the access checks", async () => {
    h.heads = [];
    await mint();
    h.proposal = { ccaID: CCA, status: "cleared" };
    h.heads = [{ userID: ME, ccaID: CCA }];
    await mint();
    expect(h.calls.filter((c) => c === "rateLimit")).toEqual([]);
  });
});
