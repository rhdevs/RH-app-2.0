import type { PrismaClient } from "@prisma/client";
import type * as BlobSdk from "@vercel/blob";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type * as Limits from "~/server/api/services/equipment/limits";
import type * as Digest from "~/server/api/services/dueCheck/collectionDigest";
import type * as Runner from "~/server/api/services/dueCheck/runner";
import type * as DecideSvc from "~/server/api/services/equipment/decide";
import type * as ReadSvc from "~/server/api/services/equipment/read";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";
import {
  DAY,
  EV,
  U,
  errorOf,
  makeKit,
  nowSeconds,
  win,
  HOUR,
  BASE,
  type Kit,
} from "./equipmentKit";

// Nothing here may reach the real store: every SDK call that could is stubbed.
vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof BlobSdk>()),
  head: vi.fn(() => Promise.reject(new Error("no real store in tests"))),
  get: vi.fn(() => Promise.reject(new Error("no real store in tests"))),
  list: vi.fn(() => Promise.reject(new Error("no real store in tests"))),
  del: vi.fn(() => Promise.reject(new Error("no real store in tests"))),
  put: vi.fn(() => Promise.reject(new Error("no real store in tests"))),
}));

/**
 * INTEGRATION TESTS of the review fixes to equipment loans (P19), against the
 * LOCAL development database (skipped unless DATABASE_URL is the local dev
 * database). Run this file on its own: `node --env-file=.env
 * node_modules/vitest/vitest.mjs run <this file> --no-file-parallelism`.
 * Each test fails without the fix it names.
 */

const NOT_SOCIAL = "FORBIDDEN:NOT_SOCIAL_DIRECTOR";
const SHORT = "CONFLICT:EQUIPMENT_SHORT:";
const CLOSED = "BAD_REQUEST:EQUIPMENT_EVENT_CLOSED";
const TOO_LONG = "BAD_REQUEST:EQUIPMENT_WINDOW_TOO_LONG";
const STORE_HOST = "teststore.private.blob.vercel-storage.com";

type Listed = { pathname: string; uploadedAt: Date };
const fakeStorage = (listed: Listed[] | Error = []) => ({
  host: () => STORE_HOST,
  head: vi.fn(() => Promise.resolve({ size: 1000, contentType: "image/webp" })),
  remove: vi.fn((_pathname: string) => Promise.resolve(true)),
  listBlobs: vi.fn(() =>
    listed instanceof Error ? Promise.reject(listed) : Promise.resolve(listed),
  ),
});
const photoPath = (loanID: string, name = "photo-ab12cd") =>
  `equipment-return/${loanID}/${name}.webp`;
const photoUrl = (loanID: string, name?: string) =>
  `https://${STORE_HOST}/${photoPath(loanID, name)}`;
const listedAt = (pathname: string): Listed => ({
  pathname,
  uploadedAt: new Date(),
});

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "equipment review fixes (local database)",
  { timeout: 300_000 },
  () => {
    let k: Kit;
    let db: PrismaClient;
    let decide: typeof DecideSvc;
    let readSvc: typeof ReadSvc;
    let EQUIPMENT_LIMITS: typeof Limits.EQUIPMENT_LIMITS;
    let runDueCheck: typeof Runner.runDueCheck;
    let collectionDigestKind: typeof Digest.collectionDigestKind;

    const proxied = (
      target: PrismaClient,
      patch: (prop: string | symbol) => unknown,
    ) =>
      new Proxy(target, {
        get: (_t, prop) =>
          patch(prop) ??
          (typeof Reflect.get(target, prop, target) === "function"
            ? (
                Reflect.get(target, prop, target) as (
                  ...a: unknown[]
                ) => unknown
              ).bind(target)
            : (Reflect.get(target, prop, target) as unknown)),
      });

    /** An item and an approved loan for a given event (CCA A's by default). */
    const approvedLoan = async (
      opts: {
        eventID?: number;
        by?: string;
        quantity?: number;
        stock?: number;
      } = {},
    ) => {
      const item = await k.makeItem("Gear", opts.stock ?? 10);
      const loan = await k.file(
        [{ itemID: item.id, quantity: opts.quantity ?? 1 }],
        win(0, 10),
        { eventID: opts.eventID ?? EV.a, by: opts.by ?? U.headA },
      );
      await k.as(U.social).approve({ id: loan.id, version: 0 });
      return { item, loan };
    };
    const collectedLoan = async (
      opts: Parameters<typeof approvedLoan>[0] = {},
    ) => {
      const made = await approvedLoan(opts);
      await k.as(U.social).collect({ id: made.loan.id, version: 1 });
      return made;
    };
    const returnedLoan = async () => {
      const made = await collectedLoan();
      await k
        .as(U.social)
        .markReturned({ id: made.loan.id, version: 2, url: null });
      return made;
    };
    const setEventStatus = (eventID: number, status: string) =>
      db.event.update({ where: { eventID }, data: { status } });

    beforeAll(async () => {
      k = await makeKit();
      db = k.db;
      decide = await import("~/server/api/services/equipment/decide");
      readSvc = await import("~/server/api/services/equipment/read");
      ({ EQUIPMENT_LIMITS } = await import(
        "~/server/api/services/equipment/limits"
      ));
      ({ runDueCheck } = await import("~/server/api/services/dueCheck/runner"));
      ({ collectionDigestKind } = await import(
        "~/server/api/services/dueCheck/collectionDigest"
      ));
      await k.begin();
    }, 120_000);
    beforeEach(() => k.reset());
    afterAll(async () => {
      await k.finish();
    });

    describe("1: the director note after a return", () => {
      it("sets and replaces the note on a returned loan, shows it to the leaders and the director only, and tells the requester", async () => {
        const { loan } = await returnedLoan();
        const before = await k.stored(loan.id);
        expect(before).toMatchObject({ status: "returned", version: 3 });

        await k.as(U.social).note({
          id: loan.id,
          version: 3,
          directorNote: "  One cable bent  ",
        });
        const first = await k.stored(loan.id);
        expect(first).toMatchObject({
          status: "returned",
          version: 4,
          directorNote: "One cable bent",
          returnedBy: before.returnedBy,
          returnPhoto: null,
        });
        expect(first.returnedAt).toEqual(before.returnedAt);

        await k.as(U.social).note({
          id: loan.id,
          version: 4,
          directorNote: "Replaced the cable",
        });
        expect((await k.stored(loan.id)).directorNote).toBe(
          "Replaced the cable",
        );

        expect((await k.as(U.headA).get({ id: loan.id })).directorNote).toBe(
          "Replaced the cable",
        );
        expect((await k.as(U.social).get({ id: loan.id })).can.note).toBe(true);
        expect((await k.as(U.headA).get({ id: loan.id })).can.note).toBe(false);
        for (const reader of [U.headB, U.jcrc, U.admin]) {
          expect(
            (await k.as(reader).get({ id: loan.id })).directorNote,
          ).toBeNull();
        }

        const notices = await k.noticesFor(U.headA, "equipment.noted");
        expect(notices).toHaveLength(2);
        expect(notices.every((n) => n.href === `/equipment/${loan.id}`)).toBe(
          true,
        );
        expect(await k.noticesFor(U.social, "equipment.noted")).toHaveLength(0);
      });

      it("compares and sets the version, caps the length, and only works on a returned loan", async () => {
        const { loan } = await returnedLoan();
        const s = k.as(U.social);
        await s.note({ id: loan.id, version: 3, directorNote: "First" });
        expect(
          await errorOf(
            s.note({ id: loan.id, version: 3, directorNote: "Late" }),
          ),
        ).toBe("CONFLICT:EQUIPMENT_CONFLICT");
        expect(
          (
            await errorOf(
              s.note({
                id: loan.id,
                version: 4,
                directorNote: "x".repeat(501),
              }),
            )
          ).startsWith("BAD_REQUEST"),
        ).toBe(true);
        expect(
          (
            await errorOf(
              s.note({ id: loan.id, version: 4, directorNote: "  " }),
            )
          ).startsWith("BAD_REQUEST"),
        ).toBe(true);
        await s.note({
          id: loan.id,
          version: 4,
          directorNote: "x".repeat(500),
        });
        expect((await k.stored(loan.id)).directorNote).toHaveLength(500);

        const live = await collectedLoan();
        expect(
          await errorOf(
            s.note({ id: live.loan.id, version: 2, directorNote: "Early" }),
          ),
        ).toBe("BAD_REQUEST:EQUIPMENT_NOT_RETURNED");
        expect((await k.stored(live.loan.id)).directorNote).toBeNull();
      });

      it("is the Social director only, not the leaders, directors or admins, whatever the session claims", async () => {
        const { loan } = await returnedLoan();
        for (const who of [U.headA, U.admin, U.director, U.jcrc, U.resident]) {
          expect(
            await errorOf(
              k.as(who).note({ id: loan.id, version: 3, directorNote: "Hi" }),
            ),
          ).toBe(NOT_SOCIAL);
        }
        expect((await k.stored(loan.id)).directorNote).toBeNull();
      });

      it("keeps the saved note when its notice cannot be written", async () => {
        const { loan } = await returnedLoan();
        const noNotices = proxied(db, (p) =>
          p === "notification"
            ? {
                createMany: () => Promise.reject(new Error("boom")),
                create: () => Promise.reject(new Error("boom")),
                findMany: () => Promise.reject(new Error("boom")),
              }
            : undefined,
        );
        const err = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await k
          .as(U.social, undefined, noNotices)
          .note({ id: loan.id, version: 3, directorNote: "Saved anyway" });
        err.mockRestore();
        expect((await k.stored(loan.id)).directorNote).toBe("Saved anyway");
      });
    });

    describe("2: stock for canceled or declined events", () => {
      it("a collected loan keeps holding stock after its event is canceled or declined", async () => {
        for (const status of ["canceled", "declined"]) {
          await k.reset();
          const { item } = await collectedLoan({
            eventID: EV.b,
            by: U.headB,
            quantity: 2,
            stock: 2,
          });
          await setEventStatus(EV.b, status);
          const next = await k.file(
            [{ itemID: item.id, quantity: 1 }],
            win(0, 10),
          );
          expect([
            status,
            (
              await errorOf(k.as(U.social).approve({ id: next.id, version: 0 }))
            ).startsWith(SHORT),
          ]).toEqual([status, true]);
        }
      });

      it("an approved, uncollected loan lets go when its event is canceled or declined", async () => {
        for (const status of ["canceled", "declined"]) {
          await k.reset();
          const { item } = await approvedLoan({
            eventID: EV.b,
            by: U.headB,
            quantity: 2,
            stock: 2,
          });
          await setEventStatus(EV.b, status);
          const next = await k.file(
            [{ itemID: item.id, quantity: 2 }],
            win(0, 10),
          );
          await k.as(U.social).approve({ id: next.id, version: 0 });
          expect((await k.stored(next.id)).status).toBe("approved");
        }
      });

      it("shows what holds: collected always, approved only while its event is open", async () => {
        const kept = await collectedLoan({ eventID: EV.b, by: U.headB });
        const released = await approvedLoan({ eventID: EV.b, by: U.headB });
        await setEventStatus(EV.b, "declined");
        const board = await k.as(U.social).list({
          status: null,
          cca: null,
          overdueOnly: false,
        });
        const find = (id: string) => board.items.find((l) => l.id === id);
        expect(find(kept.loan.id)?.holdsStock).toBe(true);
        expect(find(released.loan.id)?.holdsStock).toBe(false);
        const detail = await k.as(U.social).get({ id: released.loan.id });
        expect(detail.can.collect).toBe(false);
        expect(detail.can.cancel).toBe(true);
        expect(
          (await k.as(U.social).get({ id: kept.loan.id })).can.markReturned,
        ).toBe(true);
      });

      it("refuses to collect for a canceled or declined event, leaving the loan approved", async () => {
        for (const status of ["canceled", "declined"]) {
          await k.reset();
          const { loan } = await approvedLoan({ eventID: EV.b, by: U.headB });
          await setEventStatus(EV.b, status);
          for (const who of [U.headB, U.social]) {
            expect([
              status,
              await errorOf(k.as(who).collect({ id: loan.id, version: 1 })),
            ]).toEqual([status, CLOSED]);
          }
          expect(await k.stored(loan.id)).toMatchObject({
            status: "approved",
            version: 1,
            collectedAt: null,
          });
          // It can still be canceled, and a published event can still collect.
          await setEventStatus(EV.b, "published");
          await k.as(U.headB).collect({ id: loan.id, version: 1 });
          expect((await k.stored(loan.id)).status).toBe("collected");
        }
      });

      it("will not lower an item below what a collected loan of a canceled event still has out", async () => {
        const { item } = await collectedLoan({
          eventID: EV.b,
          by: U.headB,
          quantity: 3,
          stock: 5,
        });
        await setEventStatus(EV.b, "canceled");
        const row = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        const lower = k.as(U.social).updateItem({
          id: item.id,
          version: row.version,
          name: "TEST Gear",
          note: "",
          quantity: 2,
        });
        expect((await errorOf(lower)).startsWith(SHORT)).toBe(true);
      });

      it("drops an uncollected loan of a closed event from the overdue digest, and keeps a collected one", async () => {
        const late = () => ({
          collectAt: nowSeconds() - 10 * HOUR,
          returnAt: nowSeconds() - 2 * HOUR,
        });
        const item = await k.makeItem("Late", 20);
        const mk = (eventID: number, by: string) =>
          k.file([{ itemID: item.id, quantity: 1 }], late(), { eventID, by });
        const open = await mk(EV.a, U.headA);
        const closedApproved = await mk(EV.b, U.headB);
        const closedCollected = await mk(EV.b, U.headB);
        const s = k.as(U.social);
        for (const l of [open, closedApproved, closedCollected]) {
          await s.approve({ id: l.id, version: 0 });
        }
        await s.collect({ id: closedCollected.id, version: 1 });
        await setEventStatus(EV.b, "canceled");
        await k.setFlag("disposables.enabled", "off");
        await runDueCheck(db, U.social, {
          kinds: [collectionDigestKind],
          now: new Date(),
        });
        const [n] = await db.notification.findMany({
          where: { userID: U.social, kind: "disposable.digest" },
        });
        expect(n?.title).toBe("2 overdue equipment loans");
        expect(n?.body).toContain("TEST event 99941001");
        expect(n?.body).toContain("TEST event 99941002");
        expect(n?.body?.match(/TEST event 99941002/g)).toHaveLength(1);
      });
    });

    describe("3: a read after the commit never fails the call", () => {
      const failTitle = (target: PrismaClient) =>
        proxied(target, (p) =>
          p === "event"
            ? {
                findUnique: () => Promise.reject(new Error("db down")),
                findMany: (...a: unknown[]) =>
                  (target.event.findMany as (...x: unknown[]) => unknown)(...a),
              }
            : undefined,
        );

      it("approve, reject, director cancel and return still succeed when the title read fails, and log the code only", async () => {
        const item = await k.makeItem("Quiet", 9);
        const file = (from: number) =>
          k.file([{ itemID: item.id, quantity: 1 }], win(from, from + 5));
        const a = await file(0);
        const b = await file(10);
        const c = await file(20);
        const flaky = failTitle(db);
        const s = k.as(U.social, undefined, flaky);
        const err = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);

        await s.approve({ id: a.id, version: 0 });
        await s.reject({ id: b.id, version: 0, reason: "No" });
        await s.approve({ id: c.id, version: 0 });
        await s.cancel({ id: c.id, version: 1, reason: "Moved" });
        const held = await collectedLoan();
        await k
          .as(U.social, undefined, flaky)
          .markReturned({ id: held.loan.id, version: 2, url: null });

        const lines = err.mock.calls.map((c) => String(c[0]));
        err.mockRestore();
        const failures = lines.filter((l) =>
          l.includes("equipment_notice_failed"),
        );
        // approve and cancel each notify the requester; return tells the
        // director, who did it, so there is no recipient and no title read.
        expect(failures.length).toBeGreaterThanOrEqual(4);
        for (const line of failures) {
          expect(JSON.parse(line)).toMatchObject({
            evt: "equipment_notice_failed",
            stage: "title",
            err: "Error",
          });
          expect(line).not.toContain("db down");
        }
        const rows = await Promise.all([a, b, c].map((l) => k.stored(l.id)));
        expect(rows.map((r) => r.status)).toEqual([
          "approved",
          "rejected",
          "canceled",
        ]);
        expect((await k.stored(held.loan.id)).status).toBe("returned");
      });

      it("the return by a leader also succeeds when the director notice cannot read the title", async () => {
        const held = await collectedLoan();
        const err = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await k
          .as(U.headA, undefined, failTitle(db))
          .markReturned({ id: held.loan.id, version: 2, url: null });
        const lines = err.mock.calls.map((c) => String(c[0]));
        err.mockRestore();
        expect(lines.some((l) => l.includes('"stage":"title"'))).toBe(true);
        expect((await k.stored(held.loan.id)).status).toBe("returned");
      });
    });

    describe("4: spare photos are removed after a return", () => {
      it("removes every other file in the loan's folder and keeps the photo it holds", async () => {
        const { loan } = await collectedLoan();
        const other = "0123456789abcdef01234567";
        const storage = fakeStorage([
          listedAt(photoPath(loan.id)),
          listedAt(photoPath(loan.id, "photo-spare1")),
          listedAt(photoPath(loan.id, "photo-spare2")),
          listedAt(photoPath(other, "photo-foreign")),
        ]);
        await decide.returnLoan(db as never, storage, U.headA, {
          id: loan.id,
          version: 2,
          url: photoUrl(loan.id),
        });
        const removed = storage.remove.mock.calls.map((c) => c[0]);
        expect(removed.sort()).toEqual([
          photoPath(loan.id, "photo-spare1"),
          photoPath(loan.id, "photo-spare2"),
        ]);
        expect((await k.stored(loan.id)).returnPhoto).toBe(photoPath(loan.id));
      });

      it("removes them all when returned without a photo", async () => {
        const { loan } = await collectedLoan();
        const storage = fakeStorage([
          listedAt(photoPath(loan.id)),
          listedAt(photoPath(loan.id, "photo-spare1")),
        ]);
        await decide.returnLoan(db as never, storage, U.headA, {
          id: loan.id,
          version: 2,
          url: null,
        });
        expect(storage.remove.mock.calls.map((c) => c[0]).sort()).toEqual([
          photoPath(loan.id),
          photoPath(loan.id, "photo-spare1"),
        ]);
      });

      it("never fails the return when the folder cannot be listed, and logs the code only", async () => {
        const { loan } = await collectedLoan();
        const storage = fakeStorage(new Error("secret store detail"));
        const err = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await decide.returnLoan(db as never, storage, U.headA, {
          id: loan.id,
          version: 2,
          url: null,
        });
        const lines = err.mock.calls.map((c) => String(c[0]));
        err.mockRestore();
        expect((await k.stored(loan.id)).status).toBe("returned");
        const line = lines.find((l) =>
          l.includes("equipment_photo_cleanup_failed"),
        );
        expect(JSON.parse(line ?? "{}")).toMatchObject({ err: "Error" });
        expect(line).not.toContain("secret store detail");
      });

      it("leaves the folder alone when the return itself fails", async () => {
        const { loan } = await collectedLoan();
        const storage = fakeStorage([listedAt(photoPath(loan.id, "photo-x"))]);
        expect(
          await errorOf(
            decide.returnLoan(db as never, storage, U.headA, {
              id: loan.id,
              version: 1,
              url: null,
            }),
          ),
        ).toBe("CONFLICT:EQUIPMENT_CONFLICT");
        expect(storage.listBlobs).not.toHaveBeenCalled();
      });
    });

    describe("6: a director cancel keeps the approval it follows", () => {
      it("writes the cancel to its own fields and leaves decidedBy, decidedAt and reason as they were", async () => {
        const item = await k.makeItem("Cancelable", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        await k
          .as(U.social)
          .approve({ id: loan.id, version: 0, directorNote: "Bring ID" });
        const approved = await k.stored(loan.id);
        expect(approved).toMatchObject({
          decidedBy: U.social,
          canceledBy: null,
          canceledAt: null,
          cancelReason: null,
        });

        await new Promise((r) => setTimeout(r, 20));
        await k
          .as(U.social)
          .cancel({ id: loan.id, version: 1, reason: "Event moved" });
        const canceled = await k.stored(loan.id);
        expect(canceled.status).toBe("canceled");
        expect(canceled.decidedBy).toBe(approved.decidedBy);
        expect(canceled.decidedAt).toEqual(approved.decidedAt);
        expect(canceled.reason).toBe(approved.reason);
        expect(canceled.directorNote).toBe("Bring ID");
        expect(canceled).toMatchObject({
          canceledBy: U.social,
          cancelReason: "Event moved",
        });
        expect(canceled.canceledAt).not.toBeNull();
        expect(canceled.canceledAt!.getTime()).toBeGreaterThan(
          approved.decidedAt!.getTime(),
        );
      });

      it("records a cancel of a plain request in the cancel fields, not as a decision", async () => {
        const item = await k.makeItem("Cancel early", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        await k
          .as(U.social)
          .cancel({ id: loan.id, version: 0, reason: "Duplicate" });
        expect(await k.stored(loan.id)).toMatchObject({
          status: "canceled",
          decidedBy: null,
          decidedAt: null,
          reason: null,
          canceledBy: U.social,
          cancelReason: "Duplicate",
        });
      });

      it("writes explicit nulls when a loan is filed, and a leader cancel records nothing", async () => {
        const item = await k.makeItem("Nulls", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        const raw = (await db.$runCommandRaw({
          find: "EquipmentLoan",
          filter: { _id: { $oid: loan.id } },
        })) as unknown as {
          cursor: { firstBatch: Record<string, unknown>[] };
        };
        const doc = raw.cursor.firstBatch[0]!;
        for (const key of ["canceledBy", "canceledAt", "cancelReason"]) {
          expect([key, key in doc, doc[key]]).toEqual([key, true, null]);
        }
        await k.as(U.headA).cancel({ id: loan.id, version: 0, reason: "Oops" });
        expect(await k.stored(loan.id)).toMatchObject({
          status: "canceled",
          canceledBy: null,
          cancelReason: null,
        });
      });

      it("shows the cancel to the director and the leaders only", async () => {
        const item = await k.makeItem("Show", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        await k
          .as(U.social)
          .cancel({ id: loan.id, version: 0, reason: "Event moved" });
        for (const who of [U.social, U.headA]) {
          const seen = await k.as(who).get({ id: loan.id });
          // The name comes from the people table, which the test users lack.
          expect(seen.cancelReason).toBe("Event moved");
          expect(seen.canceledAt).not.toBeNull();
        }
        for (const who of [U.headB, U.jcrc]) {
          expect(await k.as(who).get({ id: loan.id })).toMatchObject({
            cancelReason: null,
            canceledAt: null,
            canceledBy: null,
          });
        }
      });
    });

    describe("8: the form's preview has its own budget", () => {
      it("refuses the preview once the hourly budget is spent, after the access check", async () => {
        const item = await k.makeItem("Preview", 5);
        const input = {
          eventID: EV.a,
          lines: [{ itemID: item.id, quantity: 1 }],
          ...win(0, 5),
        };
        await k.as(U.headA).check(input);
        await db.rateLimit.upsert({
          where: { key: `equipment.check:${U.headA}` },
          create: {
            key: `equipment.check:${U.headA}`,
            count: EQUIPMENT_LIMITS.check,
            expiresAt: new Date(Date.now() + HOUR * 1000),
          },
          update: { count: EQUIPMENT_LIMITS.check },
        });
        expect(await errorOf(k.as(U.headA).check(input))).toMatch(
          /^TOO_MANY_REQUESTS:RATE_LIMITED:/,
        );
        // Another person is not affected, and a person who may not file spends nothing.
        await k.as(U.headA2).check(input);
        expect(await errorOf(k.as(U.resident).check(input))).toMatch(
          /^FORBIDDEN/,
        );
        expect(
          await db.rateLimit.count({
            where: { key: `equipment.check:${U.resident}` },
          }),
        ).toBe(0);
      });
    });

    describe("10: a loan runs for at most 60 days", () => {
      const sixty = 60 * DAY;

      it("refuses a longer window on filing and on the preview, and accepts exactly 60 days", async () => {
        const item = await k.makeItem("Long", 5);
        const lines = [{ itemID: item.id, quantity: 1 }];
        const over = { collectAt: BASE, returnAt: BASE + sixty + 1 };
        const exact = { collectAt: BASE, returnAt: BASE + sixty };
        expect(
          await errorOf(
            k.as(U.headA).create({ eventID: EV.a, lines, ...over }),
          ),
        ).toBe(TOO_LONG);
        expect(
          await errorOf(k.as(U.headA).check({ eventID: EV.a, lines, ...over })),
        ).toBe(TOO_LONG);
        expect(await db.equipmentLoan.count({ where: { eventID: EV.a } })).toBe(
          0,
        );
        await k.as(U.headA).create({ eventID: EV.a, lines, ...exact });
        expect(await db.equipmentLoan.count({ where: { eventID: EV.a } })).toBe(
          1,
        );
      });

      it("refuses to approve a stored loan longer than 60 days", async () => {
        const item = await k.makeItem("Long stored", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        await db.equipmentLoan.update({
          where: { id: loan.id },
          data: { returnAt: BASE + sixty + 1 },
        });
        expect(
          await errorOf(k.as(U.social).approve({ id: loan.id, version: 0 })),
        ).toBe(TOO_LONG);
        expect((await k.stored(loan.id)).status).toBe("requested");
        await db.equipmentLoan.update({
          where: { id: loan.id },
          data: { returnAt: BASE + sixty },
        });
        await k.as(U.social).approve({ id: loan.id, version: 0 });
        expect((await k.stored(loan.id)).status).toBe("approved");
      });
    });

    describe("11: the photo route serves only this loan's folder", () => {
      it("answers NOT_FOUND when the stored pathname is outside this loan's folder", async () => {
        const { loan } = await returnedLoan();
        const other = "0123456789abcdef01234567";
        const set = (returnPhoto: string) =>
          db.equipmentLoan.update({
            where: { id: loan.id },
            data: {
              returnPhoto,
              returnPhotoType: "image/webp",
              returnPhotoSize: 1000,
            },
          });
        await set(photoPath(loan.id));
        expect(
          await readSvc.authorizePhotoRead(db as never, U.social, loan.id),
        ).toMatchObject({ pathname: photoPath(loan.id) });
        for (const bad of [
          photoPath(other),
          `evidence/${loan.id}/photo.webp`,
          `equipment-return/${loan.id.slice(0, 23)}/photo.webp`,
        ]) {
          await set(bad);
          expect([
            bad,
            await errorOf(
              readSvc.authorizePhotoRead(db as never, U.social, loan.id),
            ),
          ]).toEqual([bad, "NOT_FOUND:EQUIPMENT_NOT_FOUND"]);
        }
      });
    });
  },
);
