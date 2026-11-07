import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseShortMessage } from "~/lib/equipment/stock";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";
import {
  EV,
  HOUR,
  U,
  errorOf,
  makeKit,
  nowSeconds,
  win,
  type Kit,
} from "./equipmentKit";

/**
 * INTEGRATION TESTS of the stock rule (A68) against the LOCAL development
 * database (skipped unless DATABASE_URL is the local dev database). Run this
 * file on its own: `node --env-file=.env node_modules/vitest/vitest.mjs run
 * <this file> --no-file-parallelism`.
 *
 * The race tests are REAL: two approvals run at the same moment on the real
 * database, over several rounds, and one deterministic test holds one approval
 * between its stock read and its write while the other runs to the end, so the
 * conflict between them is proved to happen rather than assumed.
 */

const SHORT = "CONFLICT:EQUIPMENT_SHORT:";
const ROUNDS = 12;

type Hook = (op: string) => Promise<void> | void;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "equipment stock (local database)",
  { timeout: 300_000 },
  () => {
    let k: Kit;
    let db: PrismaClient;

    /** Calls `hook("model.method")` after every query made inside a transaction. */
    const hooked = (
      real: PrismaClient,
      hook: Hook,
      onTransaction?: () => void,
    ): PrismaClient => {
      const wrapTx = (tx: object) =>
        new Proxy(tx, {
          get(target, model) {
            const delegate = Reflect.get(target, model) as unknown;
            if (
              typeof model !== "string" ||
              delegate === null ||
              typeof delegate !== "object"
            ) {
              return delegate;
            }
            return new Proxy(delegate, {
              get(dt, method) {
                const fn = Reflect.get(dt, method) as unknown;
                if (typeof method !== "string" || typeof fn !== "function") {
                  return fn;
                }
                return async (...args: unknown[]) => {
                  const out = (await fn.apply(dt, args)) as unknown;
                  await hook(`${model}.${method}`);
                  return out;
                };
              },
            });
          },
        });
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "$transaction") {
            return (fn: (tx: unknown) => Promise<unknown>) => {
              onTransaction?.();
              return target.$transaction((tx) => fn(wrapTx(tx)));
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    };

    /** Pauses the first transaction at the first `op` until `release()`. */
    const pauseAt = (op: string) => {
      let reached!: () => void;
      let release!: () => void;
      const hit = new Promise<void>((r) => (reached = r));
      const gate = new Promise<void>((r) => (release = r));
      let used = false;
      const counter = { transactions: 0 };
      return {
        hit,
        release,
        counter,
        database: hooked(
          db,
          async (seen) => {
            if (used || seen !== op) return;
            used = true;
            reached();
            await gate;
          },
          () => {
            counter.transactions += 1;
          },
        ),
      };
    };

    const approve = (id: string, version = 0, database?: PrismaClient) =>
      k.as(U.social, undefined, database).approve({ id, version });

    beforeAll(async () => {
      k = await makeKit();
      db = k.db;
      await k.begin();
    }, 120_000);
    beforeEach(() => k.reset());
    afterAll(async () => {
      await k.finish();
    });

    describe("the rule", () => {
      it("refuses an approval that would need more than is owned, and names the item and the holders", async () => {
        const item = await k.makeItem("Chairs", 4);
        const held = await k.file(
          [{ itemID: item.id, quantity: 3 }],
          win(0, 10),
        );
        await approve(held.id);
        // Collected loans hold stock too.
        await k.as(U.social).collect({ id: held.id, version: 1 });
        const wants = await k.file(
          [{ itemID: item.id, quantity: 2 }],
          win(5, 15),
          { eventID: EV.b, by: U.headB },
        );
        const message = await errorOf(approve(wants.id));
        expect(message.startsWith(SHORT)).toBe(true);
        const detail = parseShortMessage(message.slice("CONFLICT:".length));
        expect(detail).toMatchObject({
          itemID: item.id,
          name: "TEST Chairs",
          owned: 4,
          wanted: 2,
          heldAtPeak: 3,
        });
        expect(detail?.loans.map((l) => l.id)).toEqual([held.id]);
        expect((await k.stored(wants.id)).status).toBe("requested");
        // One chair still fits.
        const one = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(5, 15),
        );
        await approve(one.id);
        expect((await k.stored(one.id)).status).toBe("approved");
      });

      it("counts the busiest instant, not the sum of overlapping loans", async () => {
        const item = await k.makeItem("Tables", 4);
        const early = await k.file(
          [{ itemID: item.id, quantity: 2 }],
          win(0, 10),
        );
        const late = await k.file(
          [{ itemID: item.id, quantity: 2 }],
          win(10, 20),
        );
        await approve(early.id);
        await approve(late.id);
        // Two of 2 each, one after the other: at most 2 are out at once, so a
        // loan of 2 across both fits, and a loan of 3 does not.
        const fits = await k.file(
          [{ itemID: item.id, quantity: 2 }],
          win(5, 15),
        );
        await approve(fits.id);
        expect((await k.stored(fits.id)).status).toBe("approved");
        const tooMany = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(8, 12),
        );
        expect((await errorOf(approve(tooMany.id))).startsWith(SHORT)).toBe(
          true,
        );
      });

      it("treats a window that only touches another as no overlap", async () => {
        const item = await k.makeItem("Mats", 2);
        const a = await k.file([{ itemID: item.id, quantity: 2 }], win(0, 10));
        const b = await k.file([{ itemID: item.id, quantity: 2 }], win(10, 20));
        await approve(a.id);
        await approve(b.id);
        expect((await k.stored(b.id)).status).toBe("approved");
      });

      it("holds nothing for a request, a returned, canceled or rejected loan, or a canceled event", async () => {
        const item = await k.makeItem("Speakers", 2);
        const w = win(0, 10);
        const states: Record<string, string> = {};
        const make = async (name: string, eventID = EV.a) => {
          const loan = await k.file([{ itemID: item.id, quantity: 2 }], w, {
            eventID,
            by: eventID === EV.b ? U.headB : U.headA,
          });
          states[name] = loan.id;
          return loan;
        };
        await make("requested");
        const returned = await make("returned");
        await approve(returned.id);
        await k.as(U.social).collect({ id: returned.id, version: 1 });
        await k
          .as(U.social)
          .markReturned({ id: returned.id, version: 2, url: null });
        const canceled = await make("canceled");
        await approve(canceled.id);
        await k
          .as(U.social)
          .cancel({ id: canceled.id, version: 1, reason: null });
        const rejected = await make("rejected");
        await k
          .as(U.social)
          .reject({ id: rejected.id, version: 0, reason: "No" });
        const cancelledEvent = await make("event", EV.b);
        await approve(cancelledEvent.id);
        await db.event.update({
          where: { eventID: EV.b },
          data: { status: "canceled" },
        });

        const next = await k.file([{ itemID: item.id, quantity: 2 }], w);
        await approve(next.id);
        expect((await k.stored(next.id)).status).toBe("approved");
        // And a loan of a canceled event is shown as not holding stock.
        const board = await k.as(U.social).list({
          status: null,
          cca: null,
          overdueOnly: false,
        });
        expect(
          board.items.find((l) => l.id === cancelledEvent.id)?.holdsStock,
        ).toBe(false);
        expect(board.items.find((l) => l.id === next.id)?.holdsStock).toBe(
          true,
        );
      });

      it("refuses an approval for a retired item, a closed event or a bad window", async () => {
        const item = await k.makeItem("Lamps", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 10),
        );
        const row = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        await k
          .as(U.social)
          .retireItem({ id: item.id, version: row.version, retired: true });
        expect(await errorOf(approve(loan.id))).toBe(
          "BAD_REQUEST:EQUIPMENT_ITEM_RETIRED",
        );
        await k.as(U.social).retireItem({
          id: item.id,
          version: row.version + 1,
          retired: false,
        });
        await db.event.update({
          where: { eventID: EV.a },
          data: { status: "canceled" },
        });
        expect(await errorOf(approve(loan.id))).toBe(
          "BAD_REQUEST:EQUIPMENT_EVENT_CLOSED",
        );
        await db.event.update({
          where: { eventID: EV.a },
          data: { status: "published" },
        });
        // A stored loan whose return is not after its collection.
        await db.equipmentLoan.update({
          where: { id: loan.id },
          data: { returnAt: win(0, 10).collectAt },
        });
        expect(await errorOf(approve(loan.id))).toBe(
          "BAD_REQUEST:EQUIPMENT_BAD_WINDOW",
        );
        expect((await k.stored(loan.id)).status).toBe("requested");
      });

      it("refuses to lower the count below what approved loans need, and allows exactly that much", async () => {
        const item = await k.makeItem("Boards", 5);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 3 }],
          win(0, 10),
        );
        await approve(loan.id);
        const row = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        const lower = (quantity: number, version = row.version) =>
          k.as(U.social).updateItem({
            id: item.id,
            version,
            name: "TEST Boards",
            note: "",
            quantity,
          });
        expect((await errorOf(lower(2))).startsWith(SHORT)).toBe(true);
        expect(
          (await db.equipmentItem.findUniqueOrThrow({ where: { id: item.id } }))
            .quantity,
        ).toBe(5);
        const ok = await lower(3);
        expect(ok.quantity).toBe(3);
      });

      /** A loan whose return time has passed and that is collected but not returned. */
      const overdueCollected = async (itemID: string, quantity: number) => {
        const loan = await k.file([{ itemID, quantity }], {
          collectAt: nowSeconds() - 10 * HOUR,
          returnAt: nowSeconds() - 2 * HOUR,
        });
        await approve(loan.id);
        await k.as(U.social).collect({ id: loan.id, version: 1 });
        return loan;
      };

      it("a collected loan past its return time still holds stock until it is returned", async () => {
        const item = await k.makeItem("Tents", 3);
        const late = await overdueCollected(item.id, 3);
        // The kit is out and it is now: a loan running across this moment cannot have it.
        const across = await k.file([{ itemID: item.id, quantity: 1 }], {
          collectAt: nowSeconds() - HOUR,
          returnAt: nowSeconds() + 2 * HOUR,
        });
        expect((await errorOf(approve(across.id))).startsWith(SHORT)).toBe(
          true,
        );
        expect((await k.stored(across.id)).status).toBe("requested");

        // Returned, the kit is back and the same approval goes through.
        await k
          .as(U.social)
          .markReturned({ id: late.id, version: 2, url: null });
        await approve(across.id);
        expect((await k.stored(across.id)).status).toBe("approved");
      });

      it("an approved loan past its return time that was never collected holds nothing", async () => {
        const item = await k.makeItem("Chairs", 3);
        const late = await k.file([{ itemID: item.id, quantity: 3 }], {
          collectAt: nowSeconds() - 10 * HOUR,
          returnAt: nowSeconds() - 2 * HOUR,
        });
        await approve(late.id);
        const across = await k.file([{ itemID: item.id, quantity: 1 }], {
          collectAt: nowSeconds() - HOUR,
          returnAt: nowSeconds() + 2 * HOUR,
        });
        await approve(across.id);
        expect((await k.stored(across.id)).status).toBe("approved");
      });

      it("refuses to lower the count below an overdue collected loan, and allows exactly that much", async () => {
        const item = await k.makeItem("Gazebos", 5);
        const late = await overdueCollected(item.id, 3);
        const row = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        const lower = (quantity: number, version = row.version) =>
          k.as(U.social).updateItem({
            id: item.id,
            version,
            name: "TEST Gazebos",
            note: "",
            quantity,
          });
        expect((await errorOf(lower(2))).startsWith(SHORT)).toBe(true);
        expect(
          (await db.equipmentItem.findUniqueOrThrow({ where: { id: item.id } }))
            .quantity,
        ).toBe(5);
        expect((await lower(3)).quantity).toBe(3);
        // Once it is returned, the count may go down further.
        await k
          .as(U.social)
          .markReturned({ id: late.id, version: 2, url: null });
        const after = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        expect((await lower(1, after.version)).quantity).toBe(1);
      });

      it("filing holds no stock but warns when the items look short", async () => {
        const item = await k.makeItem("Mics", 1);
        const first = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 10),
        );
        await approve(first.id);
        const second = await k.as(U.headA).create({
          eventID: EV.a,
          lines: [{ itemID: item.id, quantity: 1 }],
          ...win(2, 8),
        });
        expect(second.warnings).toHaveLength(1);
        expect(second.warnings[0]).toMatchObject({
          name: "TEST Mics",
          owned: 1,
        });
        expect((await k.stored(second.id)).status).toBe("requested");
        const preview = await k.as(U.headA).check({
          eventID: EV.a,
          lines: [{ itemID: item.id, quantity: 1 }],
          ...win(2, 8),
        });
        expect(preview.warnings).toHaveLength(1);
      });
    });

    describe("the race", () => {
      it("leaves exactly one of two simultaneous approvals approved, round after round", async () => {
        const winners = new Set<string>();
        const outcomes = new Set<string>();
        for (let round = 0; round < ROUNDS; round += 1) {
          // Each round files three loans; the hourly budget is not under test.
          await db.rateLimit.deleteMany({
            where: { key: { startsWith: "equipment." } },
          });
          await db.equipmentLoan.deleteMany({
            where: { eventID: { in: [EV.a, EV.b] } },
          });
          await db.equipmentItem.deleteMany({
            where: { name: { startsWith: "TEST " } },
          });
          const item = await k.makeItem("Race", 4);
          const base = await k.file(
            [{ itemID: item.id, quantity: 1 }],
            win(0, 10),
          );
          await approve(base.id);
          const x = await k.file([{ itemID: item.id, quantity: 2 }], win(2, 8));
          const y = await k.file(
            [{ itemID: item.id, quantity: 2 }],
            win(3, 9),
            {
              eventID: EV.b,
              by: U.headB,
            },
          );

          const results = await Promise.allSettled([
            approve(x.id),
            approve(y.id),
          ]);
          const ok = results.filter((r) => r.status === "fulfilled");
          const refused = results.filter((r) => r.status === "rejected");
          expect(ok).toHaveLength(1);
          expect(refused).toHaveLength(1);
          const reason = (refused[0]! as PromiseRejectedResult).reason as {
            code?: string;
            message?: string;
          };
          expect(reason.code).toBe("CONFLICT");
          // The loser is refused: for the stock when it ran again after the
          // winner committed, or with the try-again code when the winner was
          // still committing on all three of its tries (slow disk). Never both approved.
          const message = reason.message ?? "";
          expect(
            message.startsWith("EQUIPMENT_SHORT:") ||
              message === "EQUIPMENT_TRY_AGAIN",
          ).toBe(true);
          outcomes.add(
            message.startsWith("EQUIPMENT_SHORT:") ? "short" : "retry",
          );

          const [sx, sy] = [await k.stored(x.id), await k.stored(y.id)];
          expect([sx.status, sy.status].sort()).toEqual([
            "approved",
            "requested",
          ]);
          winners.add(sx.status === "approved" ? "x" : "y");
          const held = await db.equipmentLoan.findMany({
            where: { status: { in: ["approved", "collected"] } },
            select: { lines: true },
          });
          const total = held.reduce(
            (sum, l) => sum + l.lines.reduce((s, line) => s + line.quantity, 0),
            0,
          );
          expect(total).toBeLessThanOrEqual(4);
        }
        // Not asserted: who wins. Either may, and over the rounds both usually do.
        expect(winners.size).toBeGreaterThanOrEqual(1);
        expect(outcomes.size).toBeGreaterThanOrEqual(1);
      });

      it("conflicts a held-back approval with the one that ran, then retries it against the new count", async () => {
        const item = await k.makeItem("Held", 4);
        const base = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 10),
        );
        await approve(base.id);
        const x = await k.file([{ itemID: item.id, quantity: 2 }], win(2, 8));
        const y = await k.file([{ itemID: item.id, quantity: 2 }], win(3, 9), {
          eventID: EV.b,
          by: U.headB,
        });

        // X reads the holders (sees only the base loan) and waits.
        const pause = pauseAt("equipmentLoan.findMany");
        const slow = errorOf(approve(x.id, 0, pause.database));
        await pause.hit;
        // Y runs to the end and commits while X is stopped.
        await approve(y.id);
        expect((await k.stored(y.id)).status).toBe("approved");
        pause.release();
        const outcome = await slow;

        // X's write to the shared item row conflicted with Y's committed write,
        // so X ran a second time (two transactions), from fresh reads, and was
        // refused: it did NOT pass on the stale count.
        expect(pause.counter.transactions).toBe(2);
        expect(outcome.startsWith(SHORT)).toBe(true);
        expect((await k.stored(x.id)).status).toBe("requested");
      });

      it("conflicts an approval with a quantity change made while it was held back", async () => {
        const item = await k.makeItem("Shrinking", 4);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 3 }],
          win(0, 10),
        );
        const pause = pauseAt("equipmentLoan.findMany");
        const slow = errorOf(approve(loan.id, 0, pause.database));
        await pause.hit;
        const row = await db.equipmentItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        await k.as(U.social).updateItem({
          id: item.id,
          version: row.version,
          name: "TEST Shrinking",
          note: "",
          quantity: 2,
        });
        pause.release();
        const outcome = await slow;
        expect(pause.counter.transactions).toBe(2);
        expect(outcome.startsWith(SHORT)).toBe(true);
        expect((await k.stored(loan.id)).status).toBe("requested");
      });

      it("lets only one of two identical presses of the same button through", async () => {
        const item = await k.makeItem("Twice", 4);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 10),
        );
        const results = await Promise.allSettled([
          approve(loan.id),
          approve(loan.id),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect((await k.stored(loan.id)).status).toBe("approved");
        expect((await k.stored(loan.id)).version).toBe(1);
      });

      it("gives up with a try-again answer after three tries and writes nothing", async () => {
        const item = await k.makeItem("Busy", 4);
        const loan = await k.file(
          [{ itemID: item.id, quantity: 1 }],
          win(0, 10),
        );
        // Every attempt is stopped after its stock read and an outside write to
        // the item lands before it continues, so each attempt conflicts.
        let attempts = 0;
        const database = hooked(
          db,
          async (op) => {
            if (op !== "equipmentLoan.findMany") return;
            await db.equipmentItem.update({
              where: { id: item.id },
              data: { version: { increment: 1 } },
            });
          },
          () => {
            attempts += 1;
          },
        );
        const outcome = await errorOf(approve(loan.id, 0, database));
        expect(outcome).toBe("CONFLICT:EQUIPMENT_TRY_AGAIN");
        expect(attempts).toBe(3);
        expect((await k.stored(loan.id)).status).toBe("requested");
      });
    });
  },
);
