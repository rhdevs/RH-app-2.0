import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));

import { runDueCheck } from "~/server/api/services/dueCheck/runner";
import type { DueKind, DueNotice } from "~/server/api/services/dueCheck/types";
import { DUE_KINDS } from "~/server/api/services/dueCheck/registry";

const ME = "E1000001";
const NOW = new Date("2026-11-02T03:00:00Z"); // 11:00 on 2 Nov in Singapore

type Row = { userID: string; kind: string; noticeKey?: string; title: string };

/** An in-memory inbox that enforces the unique notice key like the index. */
function fakeDb(opts: { flag?: "on" | "off" } = {}) {
  const rows: Row[] = [];
  const db = {
    systemFlag: {
      findUnique: vi.fn(async () => ({ value: opts.flag ?? "on" })),
    },
    notification: {
      findMany: vi.fn(
        async (args: { where: { noticeKey: { in: string[] } } }) =>
          rows
            .filter((r) => args.where.noticeKey.in.includes(r.noticeKey ?? ""))
            .map((r) => ({ noticeKey: r.noticeKey })),
      ),
      createMany: vi.fn(async (args: { data: Row[] }) => {
        for (const d of args.data) {
          if (d.noticeKey && rows.some((r) => r.noticeKey === d.noticeKey)) {
            throw new Prisma.PrismaClientKnownRequestError("dup", {
              code: "P2002",
              clientVersion: "test",
            });
          }
        }
        rows.push(...args.data);
        return { count: args.data.length };
      }),
    },
  };
  return { db: db as never, rows };
}

const notice = (key: string, over: Partial<DueNotice> = {}): DueNotice => ({
  key,
  title: `Notice ${key}`,
  ...over,
});

const fakeKind = (
  name: string,
  items: DueNotice[] | (() => never),
  catchUp: DueKind["catchUp"] = "all",
  due = vi.fn(async () => (typeof items === "function" ? items() : items)),
): DueKind & { spy: typeof due } => ({
  name,
  noticeKind: `test.${name}`,
  catchUp,
  due,
  spy: due,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("runDueCheck", () => {
  it("writes each due notice once, however many times it runs", async () => {
    const { db, rows } = fakeDb();
    const kind = fakeKind("a", [notice("a:1"), notice("a:2")]);

    const first = await runDueCheck(db, ME, { kinds: [kind], now: NOW });
    const second = await runDueCheck(db, ME, { kinds: [kind], now: NOW });

    expect(first).toEqual({ written: 2, failedKinds: [] });
    expect(second).toEqual({ written: 0, failedKinds: [] });
    expect(rows.map((r) => r.noticeKey).sort()).toEqual([
      `a:1|${ME}`,
      `a:2|${ME}`,
    ]);
    expect(rows.every((r) => r.userID === ME && r.kind === "test.a")).toBe(
      true,
    );
  });

  it("treats losing a unique-key race as already written", async () => {
    const { db, rows } = fakeDb();
    // Both runs read the inbox before either writes.
    const fresh = vi.fn(async () => []);
    (
      db as unknown as { notification: { findMany: unknown } }
    ).notification.findMany = fresh;
    const kind = fakeKind("a", [notice("a:1")]);

    const results = await Promise.all([
      runDueCheck(db, ME, { kinds: [kind], now: NOW }),
      runDueCheck(db, ME, { kinds: [kind], now: NOW }),
    ]);

    expect(rows).toHaveLength(1);
    expect(results.map((r) => r.written).sort()).toEqual([0, 1]);
    expect(results.every((r) => r.failedKinds.length === 0)).toBe(true);
  });

  it("writes nothing for a person with nothing due", async () => {
    const { db, rows } = fakeDb();
    const result = await runDueCheck(db, ME, {
      kinds: [fakeKind("a", []), fakeKind("b", [])],
      now: NOW,
    });
    expect(result).toEqual({ written: 0, failedKinds: [] });
    expect(rows).toEqual([]);
  });

  it("lets a kind that throws fail alone, logging only the error name", async () => {
    const { db, rows } = fakeDb();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    class DriverBoom extends Error {
      override name = "DriverBoom";
    }
    const bad = fakeKind("bad", () => {
      throw new DriverBoom("secret E1234567 stored value");
    });
    const good = fakeKind("good", [notice("good:1")]);

    const result = await runDueCheck(db, ME, {
      kinds: [bad, good],
      now: NOW,
    });

    expect(result).toEqual({ written: 1, failedKinds: ["bad"] });
    expect(rows).toHaveLength(1);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("DriverBoom");
    expect(logged).not.toContain("E1234567");
  });

  it("writes only the most urgent of a kind that asks for it", async () => {
    const { db, rows } = fakeDb();
    const kind = fakeKind(
      "late",
      [
        notice("late:1", { urgency: 1 }),
        notice("late:3", { urgency: 3 }),
        notice("late:2", { urgency: 2 }),
      ],
      "mostUrgent",
    );

    const result = await runDueCheck(db, ME, { kinds: [kind], now: NOW });

    expect(result.written).toBe(1);
    expect(rows.map((r) => r.noticeKey)).toEqual([`late:3|${ME}`]);
  });

  it("keeps the first of equal urgency, and does not catch up when the most urgent already exists", async () => {
    const { db, rows } = fakeDb();
    const kind = fakeKind(
      "late",
      [notice("late:a", { urgency: 5 }), notice("late:b", { urgency: 5 })],
      "mostUrgent",
    );
    await runDueCheck(db, ME, { kinds: [kind], now: NOW });
    await runDueCheck(db, ME, { kinds: [kind], now: NOW });
    expect(rows.map((r) => r.noticeKey)).toEqual([`late:a|${ME}`]);
  });

  it("writes every notice of a kind that asks for all", async () => {
    const { db, rows } = fakeDb();
    const kind = fakeKind("all", [
      notice("all:1", { urgency: 1 }),
      notice("all:2", { urgency: 9 }),
    ]);
    await runDueCheck(db, ME, { kinds: [kind], now: NOW });
    expect(rows).toHaveLength(2);
  });

  it("hands each kind only this person, the clock and the Singapore day", async () => {
    const { db } = fakeDb();
    const kind = fakeKind("a", []);

    // 16:00 UTC is already the next Singapore day.
    await runDueCheck(db, ME, {
      kinds: [kind],
      now: new Date("2026-11-02T16:00:00Z"),
    });

    expect(kind.spy).toHaveBeenCalledWith({
      db,
      userID: ME,
      now: new Date("2026-11-02T16:00:00Z"),
      dayKey: "2026-11-03",
    });
  });

  it("writes nothing while notifications are off", async () => {
    const { db, rows } = fakeDb({ flag: "off" });
    const result = await runDueCheck(db, ME, {
      kinds: [fakeKind("a", [notice("a:1")])],
      now: NOW,
    });
    expect(result.written).toBe(0);
    expect(rows).toEqual([]);
  });

  it("registers the first real kind, and adding one is a list entry", () => {
    expect(DUE_KINDS.map((k) => k.name)).toEqual(["cca_no_director"]);
  });
});
