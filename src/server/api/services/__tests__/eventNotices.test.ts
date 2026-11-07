import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  noticeEventCanceled,
  noticeEventDecided,
  noticeEventEdited,
} from "../eventNotices";
import { resetNotificationsFlagCache } from "../notifications";

type Flag = "on" | "off" | "absent" | "throws";

/** A client with only the delegates the helper touches, recording every call. */
function fakeDb(
  flag: Flag,
  opts: { writeFails?: boolean; lookupFails?: boolean } = {},
) {
  const flagRead = vi.fn(async () => {
    if (flag === "throws") throw new Error("db down");
    return flag === "absent" ? null : { key: "k", value: flag };
  });
  const lookup = <T>(rows: T[]) =>
    vi.fn(async () => {
      if (opts.lookupFails) throw new Error("lookup failed");
      return rows;
    });
  const signups = lookup([{ userID: "E1" }, { userID: "E2" }]);
  const heads = lookup([{ userID: "E3" }]);
  const createMany = vi.fn(async (args: { data: unknown[] }) => {
    if (opts.writeFails) throw new Error("write failed for E1 'Secret title'");
    return { count: args.data.length };
  });
  const db = {
    systemFlag: { findUnique: flagRead },
    eventSignup: { findMany: signups },
    ccaHead: { findMany: heads },
    notification: { createMany },
  } as unknown as PrismaClient;
  return { db, flagRead, signups, heads, createMany };
}

const event = {
  eventID: 7,
  title: 'Quiz <night> & "friends"',
  ccaID: 12 as number | null,
  createdBy: "E9",
};

const written = (createMany: ReturnType<typeof fakeDb>["createMany"]) =>
  (createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>> })
    .data;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetNotificationsFlagCache();
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

describe("with notifications off", () => {
  it.each(["off", "absent", "throws"] as const)(
    "looks up nobody and writes nothing when the flag is %s",
    async (flag) => {
      const t = fakeDb(flag);
      await noticeEventCanceled(t.db, event, "Rain");
      await noticeEventEdited(t.db, event, ["time"]);
      await noticeEventDecided(t.db, event, "approve", null);
      expect(t.signups).not.toHaveBeenCalled();
      expect(t.heads).not.toHaveBeenCalled();
      expect(t.createMany).not.toHaveBeenCalled();
    },
  );
});

describe("who is told", () => {
  it("tells signed-up residents of a cancellation, with the reason", async () => {
    const t = fakeDb("on");
    await noticeEventCanceled(t.db, event, "Rain");
    const rows = written(t.createMany);
    expect(rows.map((r) => r.userID)).toEqual(["E1", "E2"]);
    expect(rows[0]).toMatchObject({
      kind: "event.canceled",
      body: "Rain",
      href: "/events/7",
    });
  });

  it("tells signed-up residents when the time or place changed", async () => {
    const t = fakeDb("on");
    await noticeEventEdited(t.db, event, ["capacity", "time", "location"]);
    expect(written(t.createMany)[0]).toMatchObject({
      kind: "event.changed",
      body: expect.stringContaining("time and place"),
    });
  });

  it("tells the heads of the event's CCA of a decision", async () => {
    const t = fakeDb("on");
    await noticeEventDecided(t.db, event, "request_changes", "Add a budget");
    expect(t.heads).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ccaID: 12 } }),
    );
    expect(written(t.createMany)[0]).toMatchObject({
      userID: "E3",
      kind: "event.decided",
      title: expect.stringMatching(/^Changes requested: /),
      body: "Add a budget",
      href: "/cca/12/events/7",
    });
  });

  it("tells the author of a hall-wide event, which has no CCA heads", async () => {
    const t = fakeDb("on");
    await noticeEventDecided(t.db, { ...event, ccaID: null }, "decline", "No");
    expect(t.heads).not.toHaveBeenCalled();
    expect(written(t.createMany).map((r) => r.userID)).toEqual(["E9"]);
  });

  it("leaves out an empty user id so one bad row does not drop the batch", async () => {
    const t = fakeDb("on");
    t.signups.mockResolvedValueOnce([{ userID: "" }, { userID: "E1" }]);
    t.heads.mockResolvedValueOnce([{ userID: "E3" }, { userID: "" }]);
    await noticeEventCanceled(t.db, event, "Rain");
    await noticeEventDecided(t.db, event, "approve", null);
    await noticeEventDecided(
      t.db,
      { ...event, ccaID: null, createdBy: "" },
      "approve",
      null,
    );
    expect(t.createMany).toHaveBeenCalledTimes(2);
    expect(
      t.createMany.mock.calls.map((c) =>
        (c[0] as { data: Array<{ userID: string }> }).data.map((r) => r.userID),
      ),
    ).toEqual([["E1"], ["E3"]]);
  });

  it("sends nothing when nobody is signed up", async () => {
    const t = fakeDb("on");
    t.signups.mockResolvedValueOnce([]);
    await noticeEventCanceled(t.db, event, null);
    expect(t.createMany).not.toHaveBeenCalled();
  });
});

describe("what is not news", () => {
  it.each([[[]], [["capacity"]]] as const)(
    "sends nothing for a no-op or capacity-only edit %j",
    async (changed) => {
      const t = fakeDb("on");
      await noticeEventEdited(t.db, event, changed);
      expect(t.flagRead).not.toHaveBeenCalled();
      expect(t.signups).not.toHaveBeenCalled();
      expect(t.createMany).not.toHaveBeenCalled();
    },
  );
});

describe("text is stored verbatim (A4)", () => {
  it('keeps <, & and " in the title exactly', async () => {
    const t = fakeDb("on");
    await noticeEventCanceled(t.db, event, 'Too <wet> & "cold"');
    expect(written(t.createMany)[0]).toMatchObject({
      title: 'Canceled: Quiz <night> & "friends"',
      body: 'Too <wet> & "cold"',
    });
  });

  it("falls back to the event number when there is no title", async () => {
    const t = fakeDb("on");
    await noticeEventCanceled(t.db, { ...event, title: null }, null);
    expect(written(t.createMany)[0]).toMatchObject({
      title: "Canceled: Event #7",
    });
  });
});

describe("a failed notice never throws", () => {
  it.each([
    ["the write", { writeFails: true }, "write"],
    ["the recipient lookup", { lookupFails: true }, "recipients"],
  ] as const)("when %s fails", async (_name, opts, stage) => {
    const t = fakeDb("on", opts);
    await expect(
      noticeEventCanceled(t.db, event, "Rain"),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = errors.mock.calls[0]![0] as string;
    expect(JSON.parse(logged)).toMatchObject({
      evt: "event_notice_failed",
      kind: "event.canceled",
      eventID: 7,
      stage,
    });
  });

  it("logs no person, title or reason", async () => {
    const t = fakeDb("on", { writeFails: true });
    await noticeEventCanceled(t.db, event, "Private reason");
    const logged = errors.mock.calls[0]![0] as string;
    for (const secret of ["E1", "E2", "Quiz", "Private reason", "Secret"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
