import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RECIPIENTS,
  NOTIFICATION_RETENTION_DAYS,
  areNotificationsEnabled,
  notify,
  resetNotificationsFlagCache,
  type NotifyClient,
} from "../notifications";

type Created = { data: Array<Record<string, unknown>> };

/** A client with the two delegates `notify` touches, recording every call. */
function fakeClient(flag: "on" | "off" | "absent" | "throws") {
  const createMany = vi.fn(async (args: Created) => ({
    count: args.data.length,
  }));
  const findUnique = vi.fn(async () => {
    if (flag === "throws") throw new Error("db down");
    return flag === "absent" ? null : { key: "x", value: flag };
  });
  const db = {
    systemFlag: { findUnique },
    notification: { createMany },
  } as unknown as NotifyClient;
  return { db, createMany, findUnique };
}

const valid = {
  recipients: ["E1000001"],
  kind: "test.happened",
  title: "Hello",
};

beforeEach(() => resetNotificationsFlagCache());

describe("notifications.enabled is fail-closed", () => {
  it.each(["absent", "off", "throws"] as const)("is off when %s", async (f) => {
    expect(await areNotificationsEnabled(fakeClient(f).db)).toBe(false);
  });

  it("is on only for the exact value on", async () => {
    expect(await areNotificationsEnabled(fakeClient("on").db)).toBe(true);
  });

  it("does not cache a failed read", async () => {
    const failing = fakeClient("throws");
    expect(await areNotificationsEnabled(failing.db)).toBe(false);
    expect(await areNotificationsEnabled(fakeClient("on").db)).toBe(true);
  });
});

describe("notify", () => {
  it("writes one row per distinct recipient in a single write", async () => {
    const { db, createMany } = fakeClient("on");

    const res = await notify(db, {
      ...valid,
      recipients: ["E1000001", "E1000002", "E1000001"],
    });

    expect(res.written).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]![0].data.map((r) => r.userID)).toEqual([
      "E1000001",
      "E1000002",
    ]);
  });

  it("stores the title and body exactly as given", async () => {
    const { db, createMany } = fakeClient("on");
    const title = `<b>Fish & "Chips"</b> <script>x</script>`;

    await notify(db, { ...valid, title, body: `a < b & "c"` });

    const row = createMany.mock.calls[0]![0].data[0]!;
    expect(row.title).toBe(title);
    expect(row.body).toBe(`a < b & "c"`);
  });

  it("writes readAt as an explicit null, which is what the unread filter matches", async () => {
    const { db, createMany } = fakeClient("on");

    await notify(db, valid);

    const row = createMany.mock.calls[0]![0].data[0]!;
    expect(Object.prototype.hasOwnProperty.call(row, "readAt")).toBe(true);
    expect(row.readAt).toBeNull();
  });

  it("sets an expiry about 180 days after creation", async () => {
    const { db, createMany } = fakeClient("on");

    await notify(db, valid);

    const row = createMany.mock.calls[0]![0].data[0]! as {
      createdAt: Date;
      expiresAt: Date;
    };
    const days =
      (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(days).toBe(NOTIFICATION_RETENTION_DAYS);
    expect(NOTIFICATION_RETENTION_DAYS).toBe(180);
  });

  it.each(["absent", "off"] as const)(
    "writes nothing while the switch is %s",
    async (f) => {
      const { db, createMany } = fakeClient(f);

      expect(await notify(db, valid)).toEqual({ written: 0 });
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it("rejects, and writes nothing, when the flag read fails", async () => {
    const { db, createMany } = fakeClient("throws");

    await expect(notify(db, valid)).rejects.toThrow("db down");
    expect(createMany).not.toHaveBeenCalled();
  });

  it("reads the flag fresh on every call: turning it on counts at once despite a cached off", async () => {
    const off = fakeClient("off");
    expect(await areNotificationsEnabled(off.db)).toBe(false); // cached off
    const on = fakeClient("on");

    const res = await notify(on.db, valid);

    expect(res.written).toBe(1);
    expect(on.findUnique).toHaveBeenCalledTimes(1);
    // and notify never trusts or fills the cache: still cached off
    expect(await areNotificationsEnabled(on.db)).toBe(false);
  });

  it("asks the database every time, with no cache", async () => {
    const { db, findUnique } = fakeClient("on");

    await notify(db, valid);
    await notify(db, valid);

    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("lets a failed write propagate, so a caller's transaction rolls back", async () => {
    const { db, createMany } = fakeClient("on");
    createMany.mockRejectedValueOnce(new Error("write failed"));

    await expect(notify(db, valid)).rejects.toThrow("write failed");
  });

  it("does nothing for no recipients", async () => {
    const { db, createMany } = fakeClient("on");

    expect(await notify(db, { ...valid, recipients: [] })).toEqual({
      written: 0,
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty recipient", { recipients: ["E1000001", " "] }],
    [
      "too many recipients",
      {
        recipients: Array.from(
          { length: MAX_RECIPIENTS + 1 },
          (_, i) => `E${i}`,
        ),
      },
    ],
    ["a bad kind", { kind: "Not A Kind" }],
    ["an empty title", { title: "  " }],
    ["a 201-character title", { title: "x".repeat(201) }],
    ["a 1001-character body", { body: "x".repeat(1001) }],
    ["an absolute href", { href: "https://example.com/x" }],
    ["a protocol-relative href", { href: "//example.com/x" }],
    ["a javascript: href", { href: "javascript:alert(1)" }],
    ["a backslash href", { href: "/\\example.com" }],
  ])("refuses %s and writes nothing", async (_name, over) => {
    const { db, createMany } = fakeClient("on");

    await expect(notify(db, { ...valid, ...over })).rejects.toThrow(/notify:/);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("accepts an in-app path", async () => {
    const { db, createMany } = fakeClient("on");

    await notify(db, { ...valid, href: "/events/12?tab=a" });

    expect(createMany.mock.calls[0]![0].data[0]!.href).toBe("/events/12?tab=a");
  });
});
