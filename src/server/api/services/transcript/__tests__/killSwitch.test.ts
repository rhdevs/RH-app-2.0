import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCEDURE_ACCESS } from "./procedureAccess";

/**
 * DATABASE-FREE (so CI runs it): the `transcript.enabled` kill switch. While
 * the SystemFlag row is missing, or says anything but "on", EVERY transcript
 * procedure refuses with TRANSCRIPT_DISABLED, before it reads its input or
 * anything else. The database here knows only the flag row.
 */
vi.stubEnv("SKIP_ENV_VALIDATION", "1");

const flag = await import("../flag");

/** A database that holds at most the flag row, and nothing else. */
function flagDb(value: string | null | Error) {
  const findUnique = vi.fn(async () => {
    if (value instanceof Error) throw value;
    return value === null
      ? null
      : { id: "x", key: flag.TRANSCRIPT_FLAG_KEY, value };
  });
  return {
    db: { systemFlag: { findUnique } } as unknown as PrismaClient,
    findUnique,
  };
}

beforeEach(() => flag.resetTranscriptFlagCache());
afterEach(() => vi.useRealTimers());

describe("isTranscriptEnabled", () => {
  it("is off with no row, with any value but on, and on with on", async () => {
    for (const [value, on] of [
      [null, false],
      ["off", false],
      ["ON", false],
      ["true", false],
      ["on", true],
    ] as const) {
      flag.resetTranscriptFlagCache();
      expect(
        await flag.isTranscriptEnabled(flagDb(value).db),
        String(value),
      ).toBe(on);
    }
  });

  it("fails closed, and does not cache a failed read", async () => {
    const broken = flagDb(new Error("database down"));
    expect(await flag.isTranscriptEnabled(broken.db)).toBe(false);
    const healthy = flagDb("on");
    expect(await flag.isTranscriptEnabled(healthy.db)).toBe(true);
  });

  it("caches the row for 15 seconds, then reads it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-04-15T00:00:00Z"));
    const on = flagDb("on");
    expect(await flag.isTranscriptEnabled(on.db)).toBe(true);
    const off = flagDb("off");
    // Still cached: the old value.
    expect(await flag.isTranscriptEnabled(off.db)).toBe(true);
    expect(off.findUnique).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2027-04-15T00:00:16Z"));
    expect(await flag.isTranscriptEnabled(off.db)).toBe(false);
  });
});

describe("every transcript procedure refuses while the switch is off", () => {
  const session = {
    user: {
      userID: "SEED-R01",
      roles: ["admin", "jcrc", "cca_head", "resident"],
      eligible: true,
      hasMatric: true,
      credentialsStale: false,
    },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  };

  const callerFor = async (db: PrismaClient, signedIn = true) => {
    const { createCaller } = await import("~/server/api/root");
    return createCaller({
      db,
      session: signedIn ? (session as never) : null,
      headers: new Headers({ "x-forwarded-for": "203.0.113.9" }),
    });
  };

  const call = async (caller: unknown, path: string) => {
    const fn = path
      .split(".")
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        caller,
      ) as (input?: unknown) => Promise<unknown>;
    try {
      await fn(undefined);
      return "ok";
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return `${e.code}:${e.message}`;
    }
  };

  const paths = Object.keys(PROCEDURE_ACCESS).sort();

  it.each([
    ["no row", null],
    ["off", "off"],
  ] as const)(
    "with %s, all of them answer FORBIDDEN TRANSCRIPT_DISABLED",
    async (_label, value) => {
      const caller = await callerFor(flagDb(value).db);
      const results = await Promise.all(paths.map((p) => call(caller, p)));
      const wrong = paths.filter(
        (_, i) => results[i] !== "FORBIDDEN:TRANSCRIPT_DISABLED",
      );
      expect(wrong).toEqual([]);
      expect(paths.length).toBeGreaterThan(60);
    },
    60_000,
  );

  it("still answers a signed-out caller UNAUTHORIZED, so the switch is not disclosed", async () => {
    const caller = await callerFor(flagDb(null).db, false);
    expect(await call(caller, "transcript.mine.readiness")).toBe(
      "UNAUTHORIZED:UNAUTHORIZED",
    );
    expect(await call(caller, "transcript.periods.list")).toBe(
      "UNAUTHORIZED:UNAUTHORIZED",
    );
  }, 60_000);

  it("lets calls past the switch once it is on", async () => {
    const caller = await callerFor(flagDb("on").db);
    // This database has nothing else, so the call fails further in: not here.
    const result = await call(caller, "transcript.mine.readiness");
    expect(result).not.toContain("TRANSCRIPT_DISABLED");
  }, 60_000);
});
