import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const directors = vi.hoisted(() => ({ ids: vi.fn() }));
const notifier = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock("~/server/api/services/directorGuard", () => ({
  currentSocialDirectorIDs: directors.ids,
}));
vi.mock("~/server/api/services/notifications", () => ({
  notify: notifier.notify,
}));

import { noticeFiled } from "../disposables/notices";

const db = {} as PrismaClient;
const request = { id: "64b000000000000000000001", title: "Hall dinner" };

describe("the Social director's notice for a filed disposable request", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    directors.ids.mockReset();
    notifier.notify.mockReset();
    notifier.notify.mockResolvedValue({ written: 1 });
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it("sends one notice with a link to the request", async () => {
    directors.ids.mockResolvedValue(["E0000001A"]);
    await noticeFiled(db, request, "E0000009Z");
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(db, {
      recipients: ["E0000001A"],
      kind: "disposable.filed",
      title: "A disposable request was filed",
      body: "Hall dinner",
      href: "/disposables/64b000000000000000000001",
    });
  });

  it("drops empty and blank user ids and the person who filed", async () => {
    directors.ids.mockResolvedValue(["", "  ", "E0000001A", "E0000009Z"]);
    await noticeFiled(db, request, "E0000009Z");
    const call = notifier.notify.mock.calls[0]![1] as { recipients: string[] };
    expect(call.recipients).toEqual(["E0000001A"]);
  });

  it("never throws when the director lookup fails, and logs only the error name", async () => {
    directors.ids.mockRejectedValue(new TypeError("secret detail"));
    await expect(
      noticeFiled(db, request, "E0000009Z"),
    ).resolves.toBeUndefined();
    expect(notifier.notify).not.toHaveBeenCalled();
    const log = errors.mock.calls.map((c) => String(c[0])).join(" ");
    expect(log).toContain("disposable_filed_notice_failed");
    expect(log).toContain("TypeError");
    expect(log).not.toContain("secret detail");
  });

  it("never throws when the notice cannot be written", async () => {
    directors.ids.mockResolvedValue(["E0000001A"]);
    notifier.notify.mockRejectedValue(new Error("boom"));
    await expect(
      noticeFiled(db, request, "E0000009Z"),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
