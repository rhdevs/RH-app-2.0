import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DATABASE-FREE (so CI runs it): `transcript.mine.*` with the switch on, against
 * a fake db that records every query. A withheld year may read nothing but the
 * switch, the period and the hold; a resident's reads are scoped to the
 * session's own userID, whatever the input says.
 */
vi.stubEnv("SKIP_ENV_VALIDATION", "1");

const flag = await import("../flag");

const YEAR = "AY2026/27";
const ME = "E0000001";
const SOMEONE_ELSE = "E0000999";

const session = {
  user: {
    userID: ME,
    roles: ["resident"],
    eligible: true,
    hasMatric: true,
    credentialsStale: false,
  },
  expires: new Date(Date.now() + 3600_000).toISOString(),
};

interface Call {
  model: string;
  method: string;
  args: unknown;
}

/** Only the models in `allowed` exist; touching any other throws. */
function recordingDb(opts: { held: boolean; allowed?: "all" }) {
  const calls: Call[] = [];
  const allowed = new Set([
    "systemFlag",
    "transcriptPeriod",
    "residentWithhold",
    "transcriptAccess",
  ]);
  const answer = (model: string, method: string): unknown => {
    if (model === "systemFlag")
      return { key: flag.TRANSCRIPT_FLAG_KEY, value: "on" };
    if (model === "transcriptPeriod") {
      const row = { academicYear: YEAR, status: "published", downloadBy: null };
      return method === "findMany" ? [row] : row;
    }
    if (model === "residentWithhold" && method === "count") {
      return opts.held ? 1 : 0;
    }
    if (model === "residentWithhold" && method === "findMany") {
      return opts.held ? [{ academicYear: YEAR }] : [];
    }
    if (method === "findMany") return [];
    if (method === "count") return 0;
    return null;
  };
  const db = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (opts.allowed !== "all" && !allowed.has(model)) {
          throw new Error(`UNEXPECTED READ OF ${model}`);
        }
        return new Proxy(
          {},
          {
            get: (_m, method: string) => async (args: unknown) => {
              calls.push({ model, method, args });
              return answer(model, method);
            },
          },
        );
      },
    },
  ) as unknown as PrismaClient;
  return { db, calls };
}

const callerFor = async (db: PrismaClient) => {
  const { createCaller } = await import("~/server/api/root");
  return createCaller({
    db,
    session: session as never,
    headers: new Headers({ "x-forwarded-for": "203.0.113.9" }),
  });
};

/** Every value of a `userID` key anywhere inside a query's arguments. */
function userIDsIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n) => userIDsIn(n, found));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "userID" && typeof value === "string") found.push(value);
      else userIDsIn(value, found);
    }
  }
  return found;
}

beforeEach(() => flag.resetTranscriptFlagCache());

describe("a withheld transcript leaks nothing", () => {
  it("mine.get answers exactly the hold, and reads no transcript data", async () => {
    const { db, calls } = recordingDb({ held: true });
    const caller = await callerFor(db);

    const result = await caller.transcript.mine.get({ academicYear: YEAR });

    expect(result).toEqual({ status: "on_hold", academicYear: YEAR });
    expect(calls.some((c) => c.model === "residentWithhold")).toBe(true);
  });

  it("mine.markOpened records nothing and says so", async () => {
    const { db, calls } = recordingDb({ held: true });
    const caller = await callerFor(db);

    const result = await caller.transcript.mine.markOpened({
      academicYear: YEAR,
    });

    expect(result).toEqual({ recorded: false });
    expect(calls.filter((c) => c.model === "transcriptAccess")).toEqual([]);
  });

  it("mine.readiness leaves the held year out", async () => {
    const held = recordingDb({ held: true });
    expect(
      await (await callerFor(held.db)).transcript.mine.readiness(),
    ).toEqual({ ready: false, academicYear: null });

    const free = recordingDb({ held: false });
    expect(
      await (await callerFor(free.db)).transcript.mine.readiness(),
    ).toEqual({ ready: true, academicYear: YEAR });
  });

  it("without a hold, markOpened does record (so the checks above can fail)", async () => {
    const { db, calls } = recordingDb({ held: false });
    const caller = await callerFor(db);

    expect(
      await caller.transcript.mine.markOpened({ academicYear: YEAR }),
    ).toEqual({ recorded: true });
    expect(calls.some((c) => c.model === "transcriptAccess")).toBe(true);
  });
});

describe("a resident sees only their own", () => {
  it("scopes every query to the session's userID and ignores a userID in the input", async () => {
    const { db, calls } = recordingDb({ held: false, allowed: "all" });
    const caller = await callerFor(db);

    const result = await caller.transcript.mine.get({
      academicYear: YEAR,
      userID: SOMEONE_ELSE,
    } as never);

    expect(result.status).toBe("ready");
    expect(JSON.stringify(calls)).not.toContain(SOMEONE_ELSE);
    const ids = calls.flatMap((c) => userIDsIn(c.args));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([ME]));
    expect(calls.some((c) => c.model === "award")).toBe(true);
  });
});
