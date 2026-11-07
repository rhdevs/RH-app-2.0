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

import type * as Router from "~/server/api/routers/equipment";
import type * as Digest from "~/server/api/services/dueCheck/collectionDigest";
import type * as Runner from "~/server/api/services/dueCheck/runner";
import type * as DecideSvc from "~/server/api/services/equipment/decide";
import type * as PhotoSvc from "~/server/api/services/equipment/photo";
import type * as ReadSvc from "~/server/api/services/equipment/read";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";
import {
  CCA_A,
  EV,
  U,
  errorOf,
  makeKit,
  nowSeconds,
  win,
  HOUR,
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
 * INTEGRATION TESTS of who may do what with equipment loans, the flag, the
 * notices, the return photo's reach, and the overdue mark and digest (A69, A70,
 * A71, A72), against the LOCAL development database (skipped unless DATABASE_URL
 * is the local dev database). Run this file on its own: `node
 * --env-file=.env node_modules/vitest/vitest.mjs run <this file>
 * --no-file-parallelism`.
 */

const NOT_SOCIAL = "FORBIDDEN:NOT_SOCIAL_DIRECTOR";
const NOT_LEADER = "FORBIDDEN:NOT_EVENT_LEADER";
const NOT_READER = "FORBIDDEN:NOT_EQUIPMENT_READER";
const DISABLED = "FORBIDDEN:EQUIPMENT_DISABLED";
const STORE_HOST = "teststore.private.blob.vercel-storage.com";

const fakeStorage = (
  over: Partial<{
    head: () => Promise<{ size: number; contentType: string } | null>;
  }> = {},
) => ({
  host: () => STORE_HOST,
  head: vi.fn(
    over.head ??
      (() => Promise.resolve({ size: 1000, contentType: "image/webp" })),
  ),
  remove: vi.fn(() => Promise.resolve(true)),
  listBlobs: vi.fn(() => Promise.resolve([])),
});
const photoUrl = (loanID: string, name = "photo-ab12cd") =>
  `https://${STORE_HOST}/equipment-return/${loanID}/${name}.webp`;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "equipment access (local database)",
  { timeout: 300_000 },
  () => {
    let k: Kit;
    let db: PrismaClient;
    let decide: typeof DecideSvc;
    let photo: typeof PhotoSvc;
    let readSvc: typeof ReadSvc;
    let runDueCheck: typeof Runner.runDueCheck;
    let collectionDigestKind: typeof Digest.collectionDigestKind;
    let equipmentRouter: typeof Router.equipmentRouter;

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
    const failing = () => ({
      findFirst: () => Promise.reject(new Error("db down")),
      findMany: () => Promise.reject(new Error("db down")),
      findUnique: () => Promise.reject(new Error("db down")),
      count: () => Promise.reject(new Error("db down")),
    });

    /** An item and an approved loan for CCA A's event, in the future. */
    const approvedLoan = async (quantity = 1) => {
      const item = await k.makeItem("Gear", 10);
      const loan = await k.file([{ itemID: item.id, quantity }], win(0, 10));
      await k.as(U.social).approve({ id: loan.id, version: 0 });
      return { item, loan };
    };

    /** A collected loan, ready to be returned. */
    const collectedLoan = async () => {
      const made = await approvedLoan();
      await k.as(U.social).collect({ id: made.loan.id, version: 1 });
      return made;
    };

    beforeAll(async () => {
      k = await makeKit();
      db = k.db;
      decide = await import("~/server/api/services/equipment/decide");
      photo = await import("~/server/api/services/equipment/photo");
      readSvc = await import("~/server/api/services/equipment/read");
      ({ runDueCheck } = await import("~/server/api/services/dueCheck/runner"));
      ({ collectionDigestKind } = await import(
        "~/server/api/services/dueCheck/collectionDigest"
      ));
      ({ equipmentRouter } = await import("~/server/api/routers/equipment"));
      await k.begin();
    }, 120_000);
    beforeEach(() => k.reset());
    afterAll(async () => {
      await k.finish();
    });

    describe("the flag", () => {
      it("is off when absent, not 'on' or unreadable", async () => {
        for (const value of [null, "off", "ON", ""]) {
          await k.setFlag("equipment.enabled", value);
          expect((await k.as(U.headA).enabled()).enabled).toBe(false);
          expect(await k.as(U.headA).entry()).toEqual({ show: false });
        }
        await k.setFlag("equipment.enabled", "on");
        expect((await k.as(U.headA).enabled()).enabled).toBe(true);
        expect(await k.as(U.headA).entry()).toEqual({ show: true });
        expect(await k.as(U.resident).entry()).toEqual({ show: false });
      });

      it("is read once and kept for a short while, until the cache is reset", async () => {
        await k.setFlag("equipment.enabled", "on");
        expect(await k.as(U.headA).entry()).toEqual({ show: true });
        // Switched off behind the cache's back: the row is not read again yet.
        await db.systemFlag.update({
          where: { key: "equipment.enabled" },
          data: { value: "off" },
        });
        expect(await k.as(U.headA).entry()).toEqual({ show: true });
        expect((await k.as(U.headA).enabled()).enabled).toBe(true);
        k.resetEquipmentFlagCache();
        expect(await k.as(U.headA).entry()).toEqual({ show: false });
        expect((await k.as(U.headA).enabled()).enabled).toBe(false);
      });

      it("does not keep a failed read, so an outage is not stretched", async () => {
        const { isEquipmentEnabled } = await import(
          "~/server/api/services/equipment/flag"
        );
        await k.setFlag("equipment.enabled", "on");
        const down = {
          systemFlag: { findUnique: () => Promise.reject(new Error("down")) },
        };
        expect(await isEquipmentEnabled(down as never)).toBe(false);
        expect(await isEquipmentEnabled(db)).toBe(true);
      });

      it("refuses EVERY other procedure while off, and writes nothing", async () => {
        const item = await k.makeItem("Off", 3);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        await k.setFlag("equipment.enabled", "off");
        const id = loan.id;
        const calls: Record<
          string,
          (c: ReturnType<Kit["as"]>) => Promise<unknown>
        > = {
          list: (c) => c.list({ status: null, cca: null, overdueOnly: false }),
          get: (c) => c.get({ id }),
          items: (c) => c.items(),
          canFile: (c) => c.canFile({ eventID: EV.a }),
          draft: (c) => c.draft({ eventID: EV.a }),
          check: (c) =>
            c.check({
              eventID: EV.a,
              lines: [{ itemID: item.id, quantity: 1 }],
              ...win(0, 5),
            }),
          create: (c) =>
            c.create({
              eventID: EV.a,
              lines: [{ itemID: item.id, quantity: 1 }],
              ...win(0, 5),
            }),
          approve: (c) => c.approve({ id, version: 0 }),
          reject: (c) => c.reject({ id, version: 0, reason: "No" }),
          cancel: (c) => c.cancel({ id, version: 0, reason: null }),
          collect: (c) => c.collect({ id, version: 0 }),
          markReturned: (c) => c.markReturned({ id, version: 0, url: null }),
          note: (c) => c.note({ id, version: 0, directorNote: "Note" }),
          createItem: (c) =>
            c.createItem({ name: "TEST X", note: "", quantity: 1 }),
          updateItem: (c) =>
            c.updateItem({
              id: item.id,
              version: 0,
              name: "TEST Y",
              note: "",
              quantity: 1,
            }),
          retireItem: (c) =>
            c.retireItem({ id: item.id, version: 0, retired: true }),
          deleteItem: (c) => c.deleteItem({ id: item.id }),
        };
        // A new procedure cannot be added without being listed (and refused) here.
        const names = Object.keys(equipmentRouter._def.procedures).sort();
        expect(names).toEqual(
          ["enabled", "entry", ...Object.keys(calls)].sort(),
        );
        for (const [name, call] of Object.entries(calls)) {
          for (const who of [U.social, U.headA, U.admin]) {
            expect([name, await errorOf(call(k.as(who)))]).toEqual([
              name,
              DISABLED,
            ]);
          }
        }
        expect((await k.stored(loan.id)).status).toBe("requested");
        expect(
          await db.equipmentItem.count({
            where: { name: { startsWith: "TEST " } },
          }),
        ).toBe(1);
        expect(await db.equipmentLoan.count({ where: { eventID: EV.a } })).toBe(
          1,
        );
      });
    });

    describe("A69: the Social director edits the list and decides", () => {
      const intruders = () =>
        [
          ["a CCA head", U.headA],
          ["an admin", U.admin],
          ["a CCA director", U.director],
          ["a JCRC member", U.jcrc],
          ["SCRC", U.scrc],
          ["a resident", U.resident],
        ] as const;

      it("refuses everyone else, whatever their session claims", async () => {
        const item = await k.makeItem("Tent", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        for (const [label, who] of intruders()) {
          const c = k.as(who); // the session claims every role
          const results = {
            createItem: await errorOf(
              c.createItem({ name: "TEST Z", note: "", quantity: 1 }),
            ),
            updateItem: await errorOf(
              c.updateItem({
                id: item.id,
                version: 0,
                name: "TEST Z",
                note: "",
                quantity: 9,
              }),
            ),
            retireItem: await errorOf(
              c.retireItem({ id: item.id, version: 0, retired: true }),
            ),
            deleteItem: await errorOf(c.deleteItem({ id: item.id })),
            approve: await errorOf(c.approve({ id: loan.id, version: 0 })),
            reject: await errorOf(
              c.reject({ id: loan.id, version: 0, reason: "No" }),
            ),
          };
          expect([label, results]).toEqual([
            label,
            {
              createItem: NOT_SOCIAL,
              updateItem: NOT_SOCIAL,
              retireItem: NOT_SOCIAL,
              deleteItem: NOT_SOCIAL,
              approve: NOT_SOCIAL,
              reject: NOT_SOCIAL,
            },
          ]);
        }
        const after = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        expect(after).toMatchObject({
          name: "TEST Tent",
          quantity: 5,
          retired: false,
          version: 0,
        });
        expect((await k.stored(loan.id)).status).toBe("requested");
      });

      it("lets the Social director create, rename, resize, retire and delete an unused item", async () => {
        const c = k.as(U.social);
        const made = await c.createItem({
          name: "TEST Bench",
          note: "oak",
          quantity: 4,
        });
        expect(made).toMatchObject({
          name: "TEST Bench",
          quantity: 4,
          retired: false,
        });
        const renamed = await c.updateItem({
          id: made.id,
          version: made.version,
          name: "TEST Bench A",
          note: "oak",
          quantity: 6,
        });
        expect(renamed).toMatchObject({ name: "TEST Bench A", quantity: 6 });
        expect(
          await errorOf(
            c.updateItem({
              id: made.id,
              version: made.version,
              name: "TEST Old",
              note: "",
              quantity: 1,
            }),
          ),
        ).toBe("CONFLICT:EQUIPMENT_CONFLICT");
        const retired = await c.retireItem({
          id: made.id,
          version: renamed.version,
          retired: true,
        });
        expect(retired.retired).toBe(true);
        expect(
          (await c.items()).items.find((i) => i.id === made.id)?.retired,
        ).toBe(true);
        expect(await c.deleteItem({ id: made.id })).toEqual({ removed: true });
        expect(await db.equipmentItem.count({ where: { id: made.id } })).toBe(
          0,
        );
      });

      it("does not delete an item a loan names, even a finished one, but retiring it works", async () => {
        const c = k.as(U.social);
        const item = await k.makeItem("Named", 3);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        await c.reject({ id: loan.id, version: 0, reason: "No" });
        expect(await errorOf(c.deleteItem({ id: item.id }))).toBe(
          "CONFLICT:EQUIPMENT_ITEM_IN_USE",
        );
        const row = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        await c.retireItem({
          id: item.id,
          version: row.version,
          retired: true,
        });
        expect(await db.equipmentItem.count({ where: { id: item.id } })).toBe(
          1,
        );
      });

      it("refuses when the director cannot be confirmed: switch off, a failed read, a second flagged position", async () => {
        const item = await k.makeItem("Guard", 3);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        await k.setFlag("directors.enabled", "off");
        expect(
          await errorOf(k.as(U.social).approve({ id: loan.id, version: 0 })),
        ).toBe(NOT_SOCIAL);
        await k.setFlag("directors.enabled", "on");

        const broken = proxied(db, (p) =>
          p === "jcrcPositionHolder" ? failing() : undefined,
        );
        const outcome = await errorOf(
          k
            .as(U.social, undefined, broken)
            .approve({ id: loan.id, version: 0 }),
        );
        expect(outcome.startsWith("FORBIDDEN:")).toBe(true);
        expect(outcome).not.toBe("ok");

        await k.makePosition("Second flag", U.jcrc, { social: true });
        expect(
          await errorOf(k.as(U.social).approve({ id: loan.id, version: 0 })),
        ).toBe(NOT_SOCIAL);
        expect((await k.stored(loan.id)).status).toBe("requested");
      });

      it("approves, rejects with a reason and director-cancels, and tells the requester each time", async () => {
        const item = await k.makeItem("Notice", 9);
        const a = await k.file([{ itemID: item.id, quantity: 1 }], win(0, 5));
        const b = await k.file([{ itemID: item.id, quantity: 1 }], win(10, 15));
        const c = await k.file([{ itemID: item.id, quantity: 1 }], win(20, 25));
        const s = k.as(U.social);
        await s.approve({ id: a.id, version: 0, directorNote: "Bring ID" });
        expect(
          await errorOf(s.reject({ id: b.id, version: 0, reason: "  " })),
        ).toMatch(/^BAD_REQUEST/);
        await s.reject({ id: b.id, version: 0, reason: "Not this term" });
        await s.approve({ id: c.id, version: 0 });
        await s.cancel({ id: c.id, version: 1, reason: "Event moved" });

        const rows = await Promise.all([a, b, c].map((l) => k.stored(l.id)));
        expect(rows.map((r) => r.status)).toEqual([
          "approved",
          "rejected",
          "canceled",
        ]);
        expect(rows[0]).toMatchObject({
          decidedBy: U.social,
          directorNote: "Bring ID",
        });
        expect(rows[1]).toMatchObject({
          reason: "Not this term",
          decidedBy: U.social,
        });
        const notices = await k.noticesFor(U.headA);
        expect(notices.map((n) => n.kind).sort()).toEqual([
          "equipment.approved",
          "equipment.approved",
          "equipment.canceled",
          "equipment.rejected",
        ]);
        expect(notices.every((n) => n.href?.startsWith("/equipment/"))).toBe(
          true,
        );
        // The director is never told what they just did; the request told them.
        expect((await k.noticesFor(U.social)).map((n) => n.kind)).toEqual(
          Array(3).fill("equipment.requested"),
        );
      });

      it("does not undo a decision when its notice cannot be written", async () => {
        const item = await k.makeItem("Quiet", 3);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
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
          .approve({ id: loan.id, version: 0 });
        err.mockRestore();
        expect((await k.stored(loan.id)).status).toBe("approved");
      });
    });

    describe("A70: filing, handing over, and reading", () => {
      it("lets whoever may file disposables for the event ask, with the event's CCA", async () => {
        const item = await k.makeItem("Filing", 9);
        const lines = [{ itemID: item.id, quantity: 1 }];
        // CCA A's event: its heads only.
        expect(
          await errorOf(
            k.as(U.headB).create({ eventID: EV.a, lines, ...win(0, 5) }),
          ),
        ).toBe(NOT_LEADER);
        expect(
          await errorOf(
            k.as(U.admin).create({ eventID: EV.a, lines, ...win(0, 5) }),
          ),
        ).toBe(NOT_LEADER);
        expect(
          await errorOf(
            k.as(U.jcrc).create({ eventID: EV.a, lines, ...win(0, 5) }),
          ),
        ).toBe(NOT_LEADER);
        expect(
          await errorOf(
            k.as(U.resident).create({ eventID: EV.a, lines, ...win(0, 5) }),
          ),
        ).toBe(NOT_LEADER);
        const mine = await k
          .as(U.headA2)
          .create({ eventID: EV.a, lines, ...win(0, 5) });
        expect(await k.stored(mine.id)).toMatchObject({
          eventID: EV.a,
          ccaID: CCA_A,
          requestedBy: U.headA2,
          status: "requested",
          version: 0,
        });
        // The CCA cannot be chosen by the browser.
        const sneaky = await k.as(U.headA).create({
          eventID: EV.a,
          lines,
          ...win(0, 5),
          ccaID: 9042,
        } as never);
        expect((await k.stored(sneaky.id)).ccaID).toBe(CCA_A);

        // The hall-wide event: JCRC members and admins, not a CCA head.
        expect(
          await errorOf(
            k.as(U.headA).create({ eventID: EV.hall, lines, ...win(0, 5) }),
          ),
        ).toBe(NOT_LEADER);
        const hall = await k
          .as(U.jcrc)
          .create({ eventID: EV.hall, lines, ...win(0, 5) });
        const adminHall = await k
          .as(U.admin)
          .create({ eventID: EV.hall, lines, ...win(0, 5) });
        for (const id of [hall.id, adminHall.id]) {
          expect(
            await db.equipmentLoan.count({ where: { id, ccaID: null } }),
          ).toBe(1);
        }
        expect(
          await errorOf(
            k.as(U.headA).create({ eventID: 99999999, lines, ...win(0, 5) }),
          ),
        ).toBe("BAD_REQUEST:EQUIPMENT_BAD_EVENT");
      });

      it("refuses an event that is canceled, declined, ended or untitled", async () => {
        const item = await k.makeItem("Closed", 9);
        const lines = [{ itemID: item.id, quantity: 1 }];
        const file = () =>
          errorOf(k.as(U.headA).create({ eventID: EV.a, lines, ...win(0, 5) }));
        await db.event.update({
          where: { eventID: EV.a },
          data: { status: "canceled" },
        });
        expect(await file()).toBe("BAD_REQUEST:DISPOSABLE_EVENT_CANCELED");
        await db.event.update({
          where: { eventID: EV.a },
          data: { status: "declined" },
        });
        expect(await file()).toBe("BAD_REQUEST:DISPOSABLE_EVENT_DECLINED");
        await db.event.update({
          where: { eventID: EV.a },
          data: { status: "published", endTime: nowSeconds() - HOUR },
        });
        expect(await file()).toBe("BAD_REQUEST:DISPOSABLE_EVENT_ENDED");
        await db.event.update({
          where: { eventID: EV.a },
          data: { endTime: nowSeconds() + 5 * HOUR, title: " " },
        });
        expect(await file()).toBe("BAD_REQUEST:DISPOSABLE_EVENT_UNTITLED");
      });

      it("takes only valid items and lines", async () => {
        const item = await k.makeItem("Valid", 9);
        const gone = "a".repeat(24);
        const base = { eventID: EV.a, ...win(0, 5) };
        const c = k.as(U.headA);
        expect(
          await errorOf(
            c.create({ ...base, lines: [{ itemID: gone, quantity: 1 }] }),
          ),
        ).toBe("BAD_REQUEST:EQUIPMENT_BAD_ITEM");
        expect(await errorOf(c.create({ ...base, lines: [] }))).toMatch(
          /^BAD_REQUEST/,
        );
        expect(
          await errorOf(
            c.create({ ...base, lines: [{ itemID: item.id, quantity: 0 }] }),
          ),
        ).toMatch(/^BAD_REQUEST/);
        expect(
          await errorOf(
            c.create({
              ...base,
              lines: [
                { itemID: item.id, quantity: 1 },
                { itemID: item.id, quantity: 2 },
              ],
            }),
          ),
        ).toMatch(/^BAD_REQUEST/);
        const row = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        await k
          .as(U.social)
          .retireItem({ id: item.id, version: row.version, retired: true });
        expect(
          await errorOf(
            c.create({ ...base, lines: [{ itemID: item.id, quantity: 1 }] }),
          ),
        ).toBe("BAD_REQUEST:EQUIPMENT_ITEM_RETIRED");
      });

      it("lets only that event's leaders or the Social director collect, return and cancel", async () => {
        const { loan } = await approvedLoan();
        const stranger = [U.headB, U.admin, U.jcrc, U.director, U.resident];
        for (const who of stranger) {
          expect(
            await errorOf(k.as(who).collect({ id: loan.id, version: 1 })),
          ).toBe(NOT_LEADER);
          expect(
            await errorOf(
              k.as(who).cancel({ id: loan.id, version: 1, reason: null }),
            ),
          ).toBe(NOT_LEADER);
        }
        // Not yet collected: returning is refused, even for a leader.
        expect(
          await errorOf(
            k.as(U.headA).markReturned({ id: loan.id, version: 1, url: null }),
          ),
        ).toBe("CONFLICT:EQUIPMENT_CONFLICT");
        // A stale version is a conflict, not a silent success.
        expect(
          await errorOf(k.as(U.headA).collect({ id: loan.id, version: 0 })),
        ).toBe("CONFLICT:EQUIPMENT_CONFLICT");
        await k.as(U.headA2).collect({ id: loan.id, version: 1 });
        expect(await k.stored(loan.id)).toMatchObject({
          status: "collected",
          version: 2,
        });
        for (const who of stranger) {
          expect(
            await errorOf(
              k.as(who).markReturned({ id: loan.id, version: 2, url: null }),
            ),
          ).toBe(NOT_LEADER);
        }
        // Collected cannot be canceled any more.
        expect(
          await errorOf(
            k.as(U.headA).cancel({ id: loan.id, version: 2, reason: null }),
          ),
        ).toBe("BAD_REQUEST:EQUIPMENT_BAD_MOVE");
        await k
          .as(U.headA)
          .markReturned({ id: loan.id, version: 2, url: null });
        const done = await k.stored(loan.id);
        expect(done).toMatchObject({
          status: "returned",
          returnedBy: U.headA,
          returnPhoto: null,
        });
        expect(done.returnedAt).not.toBeNull();

        // The Social director may do the same for any loan, and a leader may
        // cancel before collection.
        const other = await approvedLoan();
        await k.as(U.social).collect({ id: other.loan.id, version: 1 });
        await k
          .as(U.social)
          .markReturned({ id: other.loan.id, version: 2, url: null });
        const third = await k.file(
          [{ itemID: other.item.id, quantity: 1 }],
          win(30, 40),
        );
        await k
          .as(U.headA)
          .cancel({ id: third.id, version: 0, reason: "Changed plans" });
        expect(await k.stored(third.id)).toMatchObject({
          status: "canceled",
          reason: null,
        });
        // The director is told when the kit comes back (not when they did it).
        expect(
          (await k.noticesFor(U.social, "equipment.returned")).length,
        ).toBe(1);
      });

      it("shows the board to every head, JCRC member, the Social director and admins, and nobody else", async () => {
        const { loan } = await approvedLoan();
        const board = (who: string) =>
          errorOf(
            k.as(who).list({ status: null, cca: null, overdueOnly: false }),
          );
        for (const who of [
          U.headA,
          U.headB,
          U.jcrc,
          U.director,
          U.social,
          U.admin,
        ]) {
          expect([who, await board(who)]).toEqual([who, "ok"]);
          expect((await k.as(who).get({ id: loan.id })).id).toBe(loan.id);
          expect((await k.as(who).items()).items.length).toBeGreaterThan(0);
        }
        for (const who of [U.scrc, U.resident, U.outsider]) {
          expect([who, await board(who)]).toEqual([who, NOT_READER]);
          expect(await errorOf(k.as(who).get({ id: loan.id }))).toBe(
            NOT_READER,
          );
          expect(await errorOf(k.as(who).items())).toBe(NOT_READER);
        }
        // A head who has stopped heading loses it at once.
        await db.ccaHead.deleteMany({ where: { userID: U.headB } });
        expect(await board(U.headB)).toBe(NOT_READER);
        // A failed read refuses.
        const broken = proxied(db, (p) =>
          p === "ccaHead" ? failing() : undefined,
        );
        const err = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        expect(
          await errorOf(
            k
              .as(U.headA, undefined, broken)
              .list({ status: null, cca: null, overdueOnly: false }),
          ),
        ).toBe("FORBIDDEN:EQUIPMENT_ACCESS_CHECK_FAILED");
        err.mockRestore();
      });

      it("filters the board by status, CCA, hall-wide and overdue, and carries no photo, reason or note", async () => {
        const item = await k.makeItem("Board", 20);
        const a = await k.file([{ itemID: item.id, quantity: 1 }], win(0, 5));
        const b = await k.file([{ itemID: item.id, quantity: 1 }], win(0, 5), {
          eventID: EV.b,
          by: U.headB,
        });
        const hall = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
          { eventID: EV.hall, by: U.jcrc },
        );
        const s = k.as(U.social);
        await s.approve({ id: a.id, version: 0, directorNote: "secret note" });
        await s.reject({ id: b.id, version: 0, reason: "private reason" });
        const list = (over: object) =>
          s.list({ status: null, cca: null, overdueOnly: false, ...over });
        const ids = async (over: object) =>
          (await list(over)).items.map((l) => l.id).sort();
        expect(await ids({})).toEqual([a.id, b.id, hall.id].sort());
        expect(await ids({ status: "approved" })).toEqual([a.id]);
        expect(await ids({ status: "rejected" })).toEqual([b.id]);
        expect(await ids({ cca: CCA_A })).toEqual([a.id]);
        expect(await ids({ cca: "hall" })).toEqual([hall.id]);
        expect(await ids({ overdueOnly: true })).toEqual([]);
        const everything = JSON.stringify(await list({}));
        expect(everything).not.toMatch(
          /secret note|private reason|returnPhoto|equipment-return/,
        );
        const first = (await list({})).items.find((l) => l.id === hall.id);
        expect(first).toMatchObject({
          hallWide: true,
          ccaName: null,
          status: "requested",
        });
        // A reader who is not a leader gets no reason, note or photo flag.
        const asReader = await k.as(U.headB).get({ id: a.id });
        expect(asReader).toMatchObject({
          viewerIs: "reader",
          reason: null,
          directorNote: null,
          hasPhoto: false,
        });
        expect(asReader.can).toEqual({
          approve: false,
          reject: false,
          cancel: false,
          collect: false,
          markReturned: false,
          note: false,
        });
        const asLeader = await k.as(U.headA).get({ id: a.id });
        expect(asLeader).toMatchObject({
          viewerIs: "leader",
          directorNote: "secret note",
        });
        expect(asLeader.can).toMatchObject({
          collect: true,
          cancel: true,
          approve: false,
        });
        const asDirector = await s.get({ id: b.id });
        expect(asDirector).toMatchObject({
          viewerIs: "director",
          reason: "private reason",
        });
      });

      it("notifies the Social director of a new request, with a link to the loan", async () => {
        const item = await k.makeItem("Ping", 3);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 2 }],
          win(0, 5),
        );
        const [n] = await k.noticesFor(U.social, "equipment.requested");
        expect(n?.href).toBe(`/equipment/${loan.id}`);
        expect(await k.noticesFor(U.headA)).toHaveLength(0);
      });
    });

    describe("A71: the return photo", () => {
      const returnWithPhoto = async (who = U.headA) => {
        const { loan } = await collectedLoan();
        const storage = fakeStorage();
        const url = photoUrl(loan.id);
        await decide.returnLoan(db as never, storage, who, {
          id: loan.id,
          version: 2,
          url,
        });
        return { loan, storage, url };
      };

      it("is readable only by the Social director and that event's leaders", async () => {
        const { loan } = await returnWithPhoto();
        const read = (who: string) =>
          errorOf(readSvc.authorizePhotoRead(db as never, who, loan.id));
        for (const who of [U.social, U.headA, U.headA2]) {
          expect([who, await read(who)]).toEqual([who, "ok"]);
        }
        for (const who of [
          U.headB,
          U.jcrc,
          U.director,
          U.admin,
          U.scrc,
          U.resident,
          U.outsider,
        ]) {
          expect([who, await read(who)]).toEqual([
            who,
            "NOT_FOUND:EQUIPMENT_NOT_FOUND",
          ]);
        }
        const ok = await readSvc.authorizePhotoRead(
          db as never,
          U.headA,
          loan.id,
        );
        expect(ok).toMatchObject({ contentType: "image/webp", size: 1000 });
        expect(ok.pathname).toBe(
          `equipment-return/${loan.id}/photo-ab12cd.webp`,
        );
        // A loan with no photo, and a missing one, look the same to everyone.
        const bare = await approvedLoan();
        expect(
          await errorOf(
            readSvc.authorizePhotoRead(db as never, U.social, bare.loan.id),
          ),
        ).toBe("NOT_FOUND:EQUIPMENT_NOT_FOUND");
        expect(
          await errorOf(
            readSvc.authorizePhotoRead(db as never, U.social, "b".repeat(24)),
          ),
        ).toBe("NOT_FOUND:EQUIPMENT_NOT_FOUND");
        // A failed guard read refuses rather than allowing.
        const broken = proxied(db, (p) =>
          p === "jcrcPositionHolder" ? failing() : undefined,
        );
        const err = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        expect(
          await errorOf(
            readSvc.authorizePhotoRead(broken as never, U.social, loan.id),
          ),
        ).not.toBe("ok");
        err.mockRestore();
      });

      it("is flagged only for the director and the leaders, and no storage address ever leaves the server", async () => {
        const { loan } = await returnWithPhoto();
        expect((await k.as(U.social).get({ id: loan.id })).hasPhoto).toBe(true);
        expect((await k.as(U.headA2).get({ id: loan.id })).hasPhoto).toBe(true);
        expect((await k.as(U.headB).get({ id: loan.id })).hasPhoto).toBe(false);
        expect((await k.as(U.admin).get({ id: loan.id })).hasPhoto).toBe(false);
        for (const who of [U.social, U.headA, U.headB, U.admin]) {
          const shown = JSON.stringify([
            await k.as(who).get({ id: loan.id }),
            await k
              .as(who)
              .list({ status: null, cca: null, overdueOnly: false }),
          ]);
          expect(shown).not.toMatch(
            /equipment-return|photo-ab12cd|blob\.vercel|returnPhoto/,
          );
        }
        const [n] = await k.noticesFor(U.social, "equipment.returned");
        expect(n?.href).toBe(`/equipment/${loan.id}`);
        expect(JSON.stringify(n)).not.toMatch(
          /equipment-return|photo-ab12cd|blob\.vercel|https?:/,
        );
        // The row keeps a path, a type and a size, and no address.
        expect(await k.stored(loan.id)).toMatchObject({
          returnPhoto: `equipment-return/${loan.id}/photo-ab12cd.webp`,
          returnPhotoType: "image/webp",
          returnPhotoSize: 1000,
        });
      });

      it("takes only a photo of this loan, in this store, as an allowed image within the size bound", async () => {
        const { loan } = await collectedLoan();
        const attempt = (
          storage: ReturnType<typeof fakeStorage>,
          url: string,
        ) =>
          errorOf(
            decide.returnLoan(db as never, storage, U.headA, {
              id: loan.id,
              version: 2,
              url,
            }),
          );
        const bad = "BAD_REQUEST:EQUIPMENT_BAD_FILE";
        const other = "c".repeat(24);
        for (const url of [
          photoUrl(other),
          `https://evil.example/equipment-return/${loan.id}/photo-ab12cd.webp`,
          `http://${STORE_HOST}/equipment-return/${loan.id}/photo-ab12cd.webp`,
          `${photoUrl(loan.id)}?x=1`,
          `https://${STORE_HOST}/milestone-evidence/9803/evidence-x.webp`,
          `https://${STORE_HOST}/equipment-return/${loan.id}/../${other}/photo-ab12cd.webp`,
          "not a url",
        ]) {
          expect([url, await attempt(fakeStorage(), url)]).toEqual([url, bad]);
        }
        expect(
          await attempt(
            fakeStorage({ head: () => Promise.resolve(null) }),
            photoUrl(loan.id),
          ),
        ).toBe("BAD_REQUEST:EQUIPMENT_NOT_UPLOADED");
        const svg = fakeStorage({
          head: () =>
            Promise.resolve({ size: 10, contentType: "image/svg+xml" }),
        });
        expect(await attempt(svg, photoUrl(loan.id))).toBe(bad);
        expect(svg.remove).toHaveBeenCalledTimes(1);
        const huge = fakeStorage({
          head: () =>
            Promise.resolve({ size: 50_000_000, contentType: "image/webp" }),
        });
        expect(await attempt(huge, photoUrl(loan.id))).toBe(bad);
        const lying = fakeStorage({
          head: () => Promise.resolve({ size: 10, contentType: "image/png" }),
        });
        expect(await attempt(lying, photoUrl(loan.id))).toBe(bad);
        expect((await k.stored(loan.id)).status).toBe("collected");
      });

      it("removes a checked photo when the move then fails, and keeps it when the loan holds it", async () => {
        const { loan } = await collectedLoan();
        const storage = fakeStorage();
        // A stale version: the photo was checked, the move fails, the file goes.
        expect(
          await errorOf(
            decide.returnLoan(db as never, storage, U.headA, {
              id: loan.id,
              version: 1,
              url: photoUrl(loan.id),
            }),
          ),
        ).toBe("CONFLICT:EQUIPMENT_CONFLICT");
        expect(storage.remove).toHaveBeenCalledWith(
          `equipment-return/${loan.id}/photo-ab12cd.webp`,
        );
        expect((await k.stored(loan.id)).returnPhoto).toBeNull();
      });

      it("lets only the director and the leaders mint an upload, and only for a collected loan", async () => {
        const { loan } = await approvedLoan();
        const path = `equipment-return/${loan.id}/photo.webp`;
        const storage = fakeStorage();
        const mint = (who: string, pathname = path) =>
          errorOf(
            photo.authorizeReturnPhotoUpload(
              db as never,
              storage,
              who,
              pathname,
            ),
          );
        // Approved, not collected yet.
        expect(await mint(U.headA)).toBe("CONFLICT:EQUIPMENT_BAD_MOVE");
        await k.as(U.social).collect({ id: loan.id, version: 1 });
        for (const who of [U.social, U.headA, U.headA2])
          expect([who, await mint(who)]).toEqual([who, "ok"]);
        for (const who of [U.headB, U.admin, U.jcrc, U.resident]) {
          expect([who, await mint(who)]).toEqual([who, NOT_LEADER]);
        }
        expect(
          await mint(U.headA, `equipment-return/${loan.id}/other.webp`),
        ).toBe("BAD_REQUEST:BAD_PATHNAME");
        expect(
          await mint(U.headA, `equipment-return/${loan.id}/../x/photo.webp`),
        ).toBe("BAD_REQUEST:BAD_PATHNAME");
        expect(
          await mint(U.headA, `milestone-evidence/${CCA_A}/photo.webp`),
        ).toBe("BAD_REQUEST:BAD_PATHNAME");
        expect(
          await mint(U.headA, `equipment-return/${"d".repeat(24)}/photo.webp`),
        ).toBe(NOT_LEADER);
        await k.setFlag("equipment.enabled", "off");
        expect(await mint(U.headA)).toBe(DISABLED);
      });
    });

    describe("A72: times are required, and late loans are marked and reported", () => {
      it("requires a collection and a return time, with the return after the collection", async () => {
        const item = await k.makeItem("Times", 5);
        const lines = [{ itemID: item.id, quantity: 1 }];
        const c = k.as(U.headA);
        const { collectAt, returnAt } = win(0, 5);
        expect(
          await errorOf(c.create({ eventID: EV.a, lines, returnAt } as never)),
        ).toMatch(/^BAD_REQUEST/);
        expect(
          await errorOf(c.create({ eventID: EV.a, lines, collectAt } as never)),
        ).toMatch(/^BAD_REQUEST/);
        expect(
          await errorOf(
            c.create({ eventID: EV.a, lines, collectAt, returnAt: collectAt }),
          ),
        ).toMatch(/^BAD_REQUEST/);
        expect(
          await errorOf(
            c.create({
              eventID: EV.a,
              lines,
              collectAt: returnAt,
              returnAt: collectAt,
            }),
          ),
        ).toMatch(/^BAD_REQUEST/);
        expect(await db.equipmentLoan.count({ where: { eventID: EV.a } })).toBe(
          0,
        );
        expect(
          await errorOf(
            c.create({ eventID: EV.a, lines, collectAt, returnAt }),
          ),
        ).toBe("ok");
      });

      const lateWindow = () => ({
        collectAt: nowSeconds() - 10 * HOUR,
        returnAt: nowSeconds() - 2 * HOUR,
      });

      it("marks an approved or collected loan past its return time, and nothing else", async () => {
        const item = await k.makeItem("Late", 20);
        const mk = (eventID = EV.a, by = U.headA) =>
          k.file([{ itemID: item.id, quantity: 1 }], lateWindow(), {
            eventID,
            by,
          });
        const requested = await mk();
        const approved = await mk();
        const collected = await mk();
        const returned = await mk();
        const future = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 5),
        );
        const s = k.as(U.social);
        for (const l of [approved, collected, returned, future]) {
          await s.approve({ id: l.id, version: 0 });
        }
        for (const l of [collected, returned])
          await s.collect({ id: l.id, version: 1 });
        await s.markReturned({ id: returned.id, version: 2, url: null });

        const board = await s.list({
          status: null,
          cca: null,
          overdueOnly: false,
        });
        const overdueOf = (id: string) =>
          board.items.find((l) => l.id === id)?.overdue;
        expect(overdueOf(requested.id)).toBe(false);
        expect(overdueOf(approved.id)).toBe(true);
        expect(overdueOf(collected.id)).toBe(true);
        expect(overdueOf(returned.id)).toBe(false);
        expect(overdueOf(future.id)).toBe(false);
        const only = await s.list({
          status: null,
          cca: null,
          overdueOnly: true,
        });
        expect(only.items.map((l) => l.id).sort()).toEqual(
          [approved.id, collected.id].sort(),
        );
        expect((await k.as(U.headB).get({ id: approved.id })).overdue).toBe(
          true,
        );
      });

      const digestFor = async (who: string, now = new Date()) => {
        await runDueCheck(db, who, { kinds: [collectionDigestKind], now });
        return db.notification.findMany({
          where: { userID: who, kind: "disposable.digest" },
        });
      };

      it("puts overdue loans, hall-wide ones included, in the Social director's daily digest, once", async () => {
        const item = await k.makeItem("Digest", 20);
        const late = (eventID: number, by: string) =>
          k.file([{ itemID: item.id, quantity: 1 }], lateWindow(), {
            eventID,
            by,
          });
        const inCca = await late(EV.a, U.headA);
        const hall = await late(EV.hall, U.jcrc);
        await k.as(U.social).approve({ id: inCca.id, version: 0 });
        await k.as(U.social).approve({ id: hall.id, version: 0 });
        await k.setFlag("disposables.enabled", "off"); // equipment alone is enough

        expect(await digestFor(U.headA)).toHaveLength(0);
        expect(await digestFor(U.admin)).toHaveLength(0);
        const [n] = await digestFor(U.social);
        expect(n?.title).toBe("2 overdue equipment loans");
        expect(n?.body).toContain("TEST event 99941001 (Test CCA 9041)");
        expect(n?.body).toContain("TEST event 99941003 (hall-wide)");
        expect(n?.href).toBe("/equipment");
        expect(n?.body).not.toMatch(/Digest|TEST Digest/); // what was borrowed is not named
        // A second run the same day writes nothing more.
        expect(await digestFor(U.social)).toHaveLength(1);
      });

      it("adds nothing when equipment is off, when nothing is late, or after the loan is returned", async () => {
        const item = await k.makeItem("Quiet digest", 20);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          lateWindow(),
        );
        const s = k.as(U.social);
        await s.approve({ id: loan.id, version: 0 });
        await k.setFlag("disposables.enabled", "off");
        await k.setFlag("equipment.enabled", "off");
        expect(await digestFor(U.social)).toHaveLength(0);
        await k.setFlag("equipment.enabled", "on");
        await s.collect({ id: loan.id, version: 1 });
        await s.markReturned({ id: loan.id, version: 2, url: null });
        expect(await digestFor(U.social)).toHaveLength(0);
      });
    });

    describe("account deletion", () => {
      it("clears the requester, decider, returner and canceler from loans, and leaves everyone else's names", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "../userAdmin"
        );
        const emails = ["e9994101@u.nus.edu", "e9994104@u.nus.edu"];
        try {
          const requester = await db.user.create({
            data: { email: emails[0]!, userID: U.headA },
          });
          const director = await db.user.create({
            data: { email: emails[1]!, userID: U.social },
          });
          const item = await k.makeItem("Gone", 20);
          const s = k.as(U.social);
          const filed = (by = U.headA, eventID = EV.a) =>
            k.file([{ itemID: item.id, quantity: 1 }], win(0, 5), {
              by,
              eventID,
            });
          // Returned: filed by headA, decided and returned by the director.
          const returned = await filed();
          await s.approve({ id: returned.id, version: 0 });
          await s.collect({ id: returned.id, version: 1 });
          await s.markReturned({ id: returned.id, version: 2, url: null });
          // Canceled by the director.
          const canceled = await filed();
          await s.approve({ id: canceled.id, version: 0 });
          await s.cancel({ id: canceled.id, version: 1, reason: "Clash" });
          // Someone else's loan, decided by the director.
          const theirs = await filed(U.headB, EV.b);
          await s.approve({ id: theirs.id, version: 0 });

          const first = await deleteUserAccountCascade(
            db,
            await loadAdminUserTarget(db, requester.id),
            U.admin,
          );
          expect(first.deleted).toMatchObject({ equipmentRequesterCleared: 2 });
          const second = await deleteUserAccountCascade(
            db,
            await loadAdminUserTarget(db, director.id),
            U.admin,
          );
          expect(second.deleted).toMatchObject({
            equipmentDeciderCleared: 3,
            equipmentReturnerCleared: 1,
            equipmentCancellerCleared: 1,
          });

          expect(await k.stored(returned.id)).toMatchObject({
            requestedBy: null,
            decidedBy: null,
            returnedBy: null,
            status: "returned",
          });
          expect(await k.stored(canceled.id)).toMatchObject({
            requestedBy: null,
            decidedBy: null,
            canceledBy: null,
            cancelReason: "Clash",
            status: "canceled",
          });
          expect(await k.stored(theirs.id)).toMatchObject({
            requestedBy: U.headB,
            decidedBy: null,
            status: "approved",
          });
        } finally {
          await db.user.deleteMany({ where: { email: { in: emails } } });
        }
      });
    });
  },
);
