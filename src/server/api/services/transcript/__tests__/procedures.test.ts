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

describe("an unexpected error in a transcript manager procedure (F67)", () => {
  const managerCaller = async (db: PrismaClient) => {
    const { createCaller } = await import("~/server/api/root");
    return createCaller({
      db,
      session: {
        user: {
          userID: "SEED-R02",
          roles: ["jcrc", "resident"],
          eligible: true,
          hasMatric: true,
          credentialsStale: false,
        },
        expires: new Date(Date.now() + 3600_000).toISOString(),
      } as never,
      headers: new Headers({ "x-forwarded-for": "203.0.113.10" }),
    });
  };
  const caught = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );

  it("reaches the caller as 'Something went wrong.' and no log line carries its message", async () => {
    flag.resetTranscriptFlagCache();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      /* captured below */
    });
    const caller = await managerCaller(brokenDb());

    const error = await caught(caller.transcript.periods.list());

    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong.",
    });
    const lines = logged.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.some((l) => l.includes("transcript_internal_error"))).toBe(
      true,
    );
    for (const l of lines) {
      expect(l).not.toContain("secret_field");
      expect(l).not.toContain(SECRET);
    }
  }, 60_000);

  it("leaves a deliberate OPEN_FAILED alone: it is not logged as an unexpected error", async () => {
    flag.resetTranscriptFlagCache();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      /* captured below */
    });
    const base = brokenDb() as unknown as Record<string, unknown>;
    const db = new Proxy(base, {
      get: (target, prop) => {
        if (prop === "transcriptPeriod") {
          return {
            findUnique: async () => ({ status: "collecting" }),
            updateMany: () =>
              Promise.reject(
                Object.assign(new Error(SECRET), { code: "P1001" }),
              ),
          };
        }
        if (prop === "userRole") {
          return { findUnique: async () => ({ roles: ["jcrc"] }) };
        }
        if (prop === "cCA") return { findMany: async () => [] };
        if (prop === "ccaYearFreeze") return { findMany: async () => [] };
        return target[prop as string];
      },
    }) as unknown as PrismaClient;
    const caller = await managerCaller(db);
    const { currentAcademicYear } = await import(
      "~/lib/transcript/academicYear"
    );

    const error = await caught(
      caller.transcript.periods.open({
        academicYear: currentAcademicYear(new Date()),
      }),
    );
    // The repo's own sanitizeErrors (trpc.ts) still words the caller's message.
    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    const lines = logged.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.some((l) => l.includes("transcript_open_failed"))).toBe(true);
    expect(lines.some((l) => l.includes("transcript_internal_error"))).toBe(
      false,
    );
    for (const l of lines) expect(l).not.toContain("secret_field");
  }, 60_000);

  it("the middleware passes a deliberate code and any non-internal error through untouched", async () => {
    const { sanitiseInternalErrors } = await import("../procedures");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      /* captured below */
    });
    const { TRPCError } = await import("@trpc/server");
    for (const error of [
      new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "OPEN_FAILED" }),
      new TRPCError({ code: "CONFLICT", message: "RECORDS_BUSY" }),
      new TRPCError({ code: "FORBIDDEN", message: "free text, with spaces" }),
    ]) {
      const result = { ok: false as const, error };
      expect(
        await sanitiseInternalErrors({
          next: () => Promise.resolve(result),
          path: "transcript.periods.open",
        }),
      ).toBe(result);
    }
    expect(logged).not.toHaveBeenCalled();
  });
});
