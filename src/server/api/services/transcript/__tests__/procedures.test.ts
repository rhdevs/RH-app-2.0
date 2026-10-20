import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * DATABASE-FREE (so CI runs it): a head or resident procedure whose database
 * call fails unexpectedly answers "Something went wrong.", never the raw
 * database text, and logs the failure by its code and name only (F12).
 */
vi.stubEnv("SKIP_ENV_VALIDATION", "1");

const flag = await import("../flag");

const SECRET = "Unique constraint failed on the index: secret_field";

/** The flag row says "on"; every other database call throws SECRET. */
function brokenDb() {
  const fail = async () => {
    throw Object.assign(new Error(SECRET), { code: "P2002" });
  };
  const anyModel = new Proxy({}, { get: () => fail });
  const systemFlag = {
    findUnique: async () => ({
      id: "x",
      key: flag.TRANSCRIPT_FLAG_KEY,
      value: "on",
    }),
  };
  return new Proxy(
    { systemFlag },
    {
      get: (target, prop) =>
        prop === "systemFlag" ? target.systemFlag : anyModel,
    },
  ) as unknown as PrismaClient;
}

afterEach(() => {
  vi.restoreAllMocks();
  flag.resetTranscriptFlagCache();
});

describe("an unexpected error in a transcript procedure", () => {
  it("reaches the caller as 'Something went wrong.' and is logged without its message", async () => {
    flag.resetTranscriptFlagCache();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      /* captured below */
    });
    const { createCaller } = await import("~/server/api/root");
    const caller = createCaller({
      db: brokenDb(),
      session: {
        user: {
          userID: "SEED-R12",
          roles: ["resident"],
          eligible: true,
          hasMatric: true,
          credentialsStale: false,
        },
        expires: new Date(Date.now() + 3600_000).toISOString(),
      } as never,
      headers: new Headers({ "x-forwarded-for": "203.0.113.9" }),
    });

    const error = await caller.transcript.mine.readiness().then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong.",
    });

    const lines = logged.mock.calls.map((args) => args.map(String).join(" "));
    const line = lines.find((l) => l.includes("transcript_internal_error"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({
      evt: "transcript_internal_error",
      path: "transcript.mine.readiness",
      code: "P2002",
      name: "Error",
    });
    for (const l of lines) {
      expect(l).not.toContain("secret_field");
      expect(l).not.toContain(SECRET);
    }
  }, 60_000);
});
