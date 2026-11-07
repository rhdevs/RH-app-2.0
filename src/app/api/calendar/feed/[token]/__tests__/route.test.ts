import type * as RateLimit from "~/lib/rateLimit";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The feed route, with the database replaced by a small fake. These tests are
 * about the HTTP surface: the status for each refusal, the headers, that the
 * token is only ever looked up by its hash, and that the token is never
 * written to a log. What a feed holds for each kind of reader is covered
 * against the real database in calendarFeed.int.test.ts.
 */
type RateLimitModule = typeof RateLimit;

const h = vi.hoisted(() => ({
  flags: {} as Record<string, string>,
  owner: null as string | null,
  tokenReadFails: false,
  eventReadFails: false,
  lookups: [] as unknown[],
  userEmail: "e0000001@u.nus.edu" as string | null,
  changedAt: null as Date | null,
  limits: [] as string[],
  limitDeny: null as string | null,
  limitThrows: false,
  userReadFails: false,
  flagReads: 0,
}));

vi.mock("~/lib/rateLimit", async (orig) => ({
  ...(await orig<RateLimitModule>()),
  rateLimit: vi.fn((key: string) => {
    h.limits.push(key);
    if (h.limitThrows) return Promise.reject(new Error("db down"));
    const denied = h.limitDeny !== null && key.startsWith(h.limitDeny);
    return Promise.resolve({ allowed: !denied, retryAfter: denied ? 120 : 0 });
  }),
}));

vi.mock("~/server/db", () => ({
  db: {
    systemFlag: {
      findUnique: vi.fn(({ where }: { where: { key: string } }) => {
        h.flagReads += 1;
        const v = h.flags[where.key];
        if (v === "throws") return Promise.reject(new Error("db down"));
        return Promise.resolve(v === undefined ? null : { value: v });
      }),
    },
    calendarFeedToken: {
      findUnique: vi.fn((args: unknown) => {
        h.lookups.push(args);
        if (h.tokenReadFails) return Promise.reject(new Error("db down"));
        return Promise.resolve(
          h.owner
            ? {
                userID: h.owner,
                createdAt: new Date("2026-10-01T00:00:00Z"),
                rotatedAt: null,
              }
            : null,
        );
      }),
    },
    user: {
      findFirst: vi.fn(() =>
        h.userReadFails
          ? Promise.reject(new Error("db down"))
          : Promise.resolve(
              h.userEmail ? { id: "u1", email: h.userEmail } : null,
            ),
      ),
    },
    credentialRevocation: {
      findUnique: vi.fn(() =>
        Promise.resolve(h.changedAt ? { changedAt: h.changedAt } : null),
      ),
    },
    event: {
      findMany: vi.fn(() => {
        if (h.eventReadFails) return Promise.reject(new Error("db down"));
        return Promise.resolve([
          {
            eventID: 12,
            ccaID: null,
            title: "Hall Dinner",
            publicDescription: "Join us, bring a friend",
            location: "Dining Hall",
            startTime: 1_800_000_000,
            endTime: 1_800_007_200,
            updatedAt: new Date("2026-10-01T00:00:00Z"),
          },
        ]);
      }),
    },
    cCA: { findMany: vi.fn(() => Promise.resolve([])) },
  },
}));

import { GET } from "../route";
import { resetEventsFlagCache } from "~/server/api/services/events";

const TOKEN = "T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0kenXYZ";
const OWNER_SELECT = { userID: true, createdAt: true, rotatedAt: true };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const get = (segment: string) =>
  GET(new Request(`http://localhost/api/calendar/feed/${segment}`), {
    params: { token: segment },
  });

let logged: string[];
beforeEach(() => {
  resetEventsFlagCache();
  h.flags = { "calendar.feed.enabled": "on", "events.enabled": "on" };
  h.owner = "E0000001";
  h.tokenReadFails = false;
  h.eventReadFails = false;
  h.lookups = [];
  h.userEmail = "e0000001@u.nus.edu";
  h.changedAt = null;
  h.limits = [];
  h.limitDeny = null;
  h.limitThrows = false;
  h.userReadFails = false;
  h.flagReads = 0;
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logged.push(a.map((x) => String(x)).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/calendar/feed/[token]", () => {
  it("serves a calendar, private and uncached", async () => {
    const res = await get(`${TOKEN}.ics`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("SUMMARY:[Hall] Hall Dinner");
    expect(body).toContain("DESCRIPTION:Join us\\, bring a friend");
  });

  it("looks the token up by its SHA-256 only, with or without .ics", async () => {
    await get(`${TOKEN}.ics`);
    await get(TOKEN);

    expect(h.lookups).toEqual([
      { where: { tokenHash: sha(TOKEN) }, select: OWNER_SELECT },
      { where: { tokenHash: sha(TOKEN) }, select: OWNER_SELECT },
    ]);
    expect(JSON.stringify(h.lookups)).not.toContain(TOKEN);
  });

  it("is 503 with the flag off, absent or unreadable, and reads no token", async () => {
    for (const value of ["off", "ON", "throws", undefined]) {
      h.flags = value === undefined ? {} : { "calendar.feed.enabled": value };
      const res = await get(TOKEN);
      expect(res.status, String(value)).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(h.lookups).toEqual([]);
  });

  it("is 401 for an unknown token, a revoked one and a malformed one, with one body", async () => {
    h.owner = null;
    const bodies = new Set<string>();
    for (const segment of [
      TOKEN,
      "short",
      "a".repeat(5000),
      "%00..%2f",
      ".ics",
    ]) {
      const res = await get(segment);
      expect(res.status, segment.slice(0, 20)).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    // Every one of them cost the same single indexed read, and nothing more.
    expect(h.lookups).toHaveLength(5);
  });

  it("hashes only the first 256 characters of an oversized token", async () => {
    h.owner = null;
    const long = "a".repeat(5000);
    await get(long);
    expect(h.lookups[0]).toEqual({
      where: { tokenHash: sha("a".repeat(256)) },
      select: OWNER_SELECT,
    });
  });

  it("is 503, not an empty calendar, when a read fails", async () => {
    h.tokenReadFails = true;
    expect((await get(TOKEN)).status).toBe(503);
    h.tokenReadFails = false;
    h.eventReadFails = true;
    expect((await get(TOKEN)).status).toBe(503);
  });

  it("is 429 per address before anything is read, with no detail", async () => {
    h.limitDeny = "calendar.feed.ip:";

    const res = await get(TOKEN);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect((await res.text()).trim()).toBe("Too many requests");
    expect(h.flagReads).toBe(0);
    expect(h.lookups).toEqual([]);
  });

  it("is 429 per owner once the token names one, before any calendar read", async () => {
    h.limitDeny = "calendar.feed.owner:";

    const res = await get(TOKEN);

    expect(res.status).toBe(429);
    expect((await res.text()).trim()).toBe("Too many requests");
    expect(h.limits).toEqual([
      expect.stringMatching(/^calendar\.feed\.ip:/),
      "calendar.feed.owner:E0000001",
    ]);
  });

  it("an unknown token spends only the address budget, never an owner's", async () => {
    h.owner = null;
    await get(TOKEN);
    expect(h.limits).toHaveLength(1);
    expect(h.limits[0]).toMatch(/^calendar\.feed\.ip:/);
  });

  it("a limiter that fails refuses with 503 (it does not open), on either budget", async () => {
    h.limitThrows = true;
    expect((await get(TOKEN)).status).toBe(503);
    expect(h.lookups).toEqual([]);
  });

  it("is 401 when the owner has no account, or no NUS identity, any more", async () => {
    h.userEmail = null;
    expect((await get(TOKEN)).status).toBe(401);
    h.userEmail = "someone@gmail.com";
    expect((await get(TOKEN)).status).toBe(401);
    h.userEmail = "e0000002@u.nus.edu";
    expect((await get(TOKEN)).status).toBe(401);
    h.userEmail = "E0000001@U.NUS.EDU";
    expect((await get(TOKEN)).status).toBe(200);
  });

  it("is 401 for a link made before the owner's last credential change, 200 for one made after", async () => {
    h.changedAt = new Date("2026-10-02T00:00:00Z");
    expect((await get(TOKEN)).status).toBe(401);
    h.changedAt = new Date("2026-09-30T00:00:00Z");
    expect((await get(TOKEN)).status).toBe(200);
    // Same second as the reset: kept, as auth.ts keeps a same-second sign-in.
    h.changedAt = new Date("2026-10-01T00:00:00.900Z");
    expect((await get(TOKEN)).status).toBe(200);
  });

  it("is 503 when the account or revocation read fails", async () => {
    h.userReadFails = true;
    expect((await get(TOKEN)).status).toBe(503);
  });

  it("never writes the token to any log, on any path", async () => {
    await get(`${TOKEN}.ics`);
    h.owner = null;
    await get(`${TOKEN}.ics`);
    h.owner = "E0000001";
    h.tokenReadFails = true;
    await get(`${TOKEN}.ics`);
    h.tokenReadFails = false;
    h.eventReadFails = true;
    await get(`${TOKEN}.ics`);
    h.flags = { "calendar.feed.enabled": "throws" };
    await get(`${TOKEN}.ics`);

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(TOKEN.slice(0, 16));
      expect(line).not.toContain(sha(TOKEN));
    }
  });
});
