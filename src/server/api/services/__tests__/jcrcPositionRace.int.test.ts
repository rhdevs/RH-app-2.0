import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of the check-then-write race on flagged positions, against
 * the LOCAL development database (skipped unless DATABASE_URL is the local dev
 * database; run `npm run test:db`).
 *
 * A plain member's holder or CCA change and an admin's flag change can overlap.
 * Each procedure runs its read, its lock check and its writes in one
 * transaction that also writes the position row, so the second of two
 * overlapping transactions is aborted and refused with CONFLICT. The overlap is
 * CONTROLLED here: a wrapper around the database pauses one procedure's
 * transaction right after a chosen read, the other procedure runs to the end,
 * then the first is released. The tests own users E99905xx and positions named
 * "TEST ...", all removed before and after each test.
 */

const U = {
  plain: "E9990501",
  plain2: "E9990502",
  holder: "E9990503",
  admin: "E9990504",
  selfAdmin: "E9990505",
  successor: "E9990506",
};
const ALL_IDS = Object.values(U);
const JCRC = ["resident", "jcrc"];
const ADMIN = ["resident", "admin"];
const ADMIN_JCRC = ["resident", "admin", "jcrc"];
const STALE = "CONFLICT:CONFIRMATION_STALE";

type Hook = (op: string) => Promise<void> | void;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "the race on flagged positions (local database)",
  { timeout: 180_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let ipCounter = 0;

    /** Calls run through `database` (the real one unless a hooked one is given). */
    const as = (userID: string, roles: string[], database: PrismaClient = db) =>
      createCaller({
        db: database,
        session: {
          user: {
            userID,
            roles,
            eligible: true,
            hasMatric: true,
            credentialsStale: false,
          },
          expires: new Date(Date.now() + 3600_000).toISOString(),
        } as never,
        headers: new Headers({
          "x-forwarded-for": `203.0.113.${(ipCounter += 1)}`,
        }),
      }).jcrcPositions;

    /** Calls `hook("model.method")` after every query made inside a transaction. */
    const hooked = (real: PrismaClient, hook: Hook): PrismaClient => {
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
            return (fn: (tx: unknown) => Promise<unknown>) =>
              target.$transaction((tx) => fn(wrapTx(tx)));
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
      return {
        hit,
        release,
        database: hooked(db, async (seen) => {
          if (used || seen !== op) return;
          used = true;
          reached();
          await gate;
        }),
      };
    };

    const errorOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return `${e.code}:${e.message}`;
      }
      return "ok";
    };

    const clean = async () => {
      const found = await db.jcrcPosition.findMany({
        where: { name: { startsWith: "TEST " } },
        select: { id: true },
      });
      const ids = found.map((p) => p.id);
      await db.jcrcPositionCca.deleteMany({
        where: { positionID: { in: ids } },
      });
      await db.jcrcPositionHolder.deleteMany({
        where: {
          OR: [{ positionID: { in: ids } }, { userID: { in: ALL_IDS } }],
        },
      });
      await db.jcrcPosition.deleteMany({ where: { id: { in: ids } } });
      await db.jcrcTerm.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.userRole.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.roleAuditLog.deleteMany({
        where: {
          OR: [
            { actorUserID: { in: ALL_IDS } },
            { targetUserID: { in: ALL_IDS } },
          ],
        },
      });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: {
          userID,
          roles,
          role: "",
          updatedAt: new Date(),
          updatedBy: "test",
        },
      });

    /** An unflagged position with one holder and two CCAs. */
    const makePosition = async () => {
      const p = await db.jcrcPosition.create({
        data: { name: "TEST Race", createdBy: "test" },
      });
      for (const ccaID of [9001, 9002]) {
        await db.jcrcPositionCca.create({
          data: { positionID: p.id, ccaID, addedBy: "test" },
        });
      }
      await db.jcrcPositionHolder.create({
        data: { positionID: p.id, userID: U.holder, assignedBy: U.admin },
      });
      return p.id;
    };
    const SEEN = { holderIDs: [U.holder], ccaIDs: [9001, 9002] };

    const holdersOf = async (id: string) =>
      (await db.jcrcPositionHolder.findMany({ where: { positionID: id } }))
        .map((h) => h.userID)
        .sort();
    const ccasOf = async (id: string) =>
      (await db.jcrcPositionCca.findMany({ where: { positionID: id } }))
        .map((c) => c.ccaID)
        .sort((a, b) => a - b);
    const auditActions = async () =>
      (
        await db.roleAuditLog.findMany({
          where: { action: { startsWith: "jcrcPosition." } },
          orderBy: { at: "asc" },
        })
      ).map((r) => r.action);

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await db.systemFlag.upsert({
        where: { key: "directors.enabled" },
        create: { key: "directors.enabled", value: "on" },
        update: { value: "on" },
      });
      for (const id of [U.plain, U.plain2, U.holder]) {
        await setRoles(id, JCRC);
      }
      await setRoles(U.admin, ADMIN);
      await setRoles(U.selfAdmin, ADMIN_JCRC);
      await setRoles(U.successor, ["resident"]);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        await db.$disconnect();
      }
    });

    type Writer = (id: string, database?: PrismaClient) => Promise<unknown>;
    const writers: [string, Writer][] = [
      [
        "addHolder",
        (id, d) => as(U.plain, JCRC, d).addHolder({ id, userID: U.plain2 }),
      ],
      [
        "removeHolder",
        (id, d) => as(U.plain, JCRC, d).removeHolder({ id, userID: U.holder }),
      ],
      [
        "setCcas",
        (id, d) => as(U.plain, JCRC, d).setCcas({ id, ccaIDs: [9003] }),
      ],
      [
        "rename",
        (id, d) => as(U.plain, JCRC, d).update({ id, name: "TEST Renamed" }),
      ],
      ["delete", (id, d) => as(U.plain, JCRC, d).delete({ id })],
    ];

    describe("a flag change that overlaps a holder or CCA change", () => {
      it.each(writers.slice(0, 3))(
        "refuses the FLAG when a %s commits after its snapshot",
        async (_name, write) => {
          const id = await makePosition();
          const pause = pauseAt("jcrcPositionCca.findMany");
          const flagging = errorOf(
            as(U.admin, ADMIN, pause.database).setFlag({
              id,
              flag: "vetsProposals",
              value: true,
              seen: SEEN,
            }),
          );
          await pause.hit; // the flag's snapshot is taken, nothing written yet
          expect(await errorOf(write(id))).toBe("ok"); // the member's change commits
          pause.release();

          expect(await flagging).toBe(STALE);
          const row = await db.jcrcPosition.findUnique({ where: { id } });
          expect(row?.vetsProposals ?? null).toBeNull();
          expect(await auditActions()).toEqual([]);
        },
      );

      it.each(writers)(
        "refuses the %s when it read the position before the flag committed",
        async (_name, write) => {
          const id = await makePosition();
          const pause = pauseAt("jcrcPosition.findUnique");
          const writing = errorOf(write(id, pause.database));
          await pause.hit; // the member read an UNFLAGGED position
          expect(
            await errorOf(
              as(U.admin, ADMIN).setFlag({
                id,
                flag: "vetsProposals",
                value: true,
                seen: SEEN,
              }),
            ),
          ).toBe("ok");
          pause.release();

          expect(await writing).toBe(STALE);
          // Nothing the member tried is on the flagged position.
          const row = await db.jcrcPosition.findUnique({ where: { id } });
          expect(row?.vetsProposals).toBe(true);
          expect(row?.name).toBe("TEST Race");
          expect(await holdersOf(id)).toEqual([U.holder]);
          expect(await ccasOf(id)).toEqual([9001, 9002]);
          expect(await auditActions()).toEqual(["jcrcPosition.flag.set"]);
        },
      );

      it("lets a plain member's later retry meet the lock instead", async () => {
        const id = await makePosition();
        const pause = pauseAt("jcrcPosition.findUnique");
        const writing = errorOf(writers[0]![1](id, pause.database));
        await pause.hit;
        await as(U.admin, ADMIN).setFlag({
          id,
          flag: "vetsProposals",
          value: true,
          seen: SEEN,
        });
        pause.release();
        expect(await writing).toBe(STALE);
        // Trying again now reads the flag and is locked out, not conflicted.
        expect(await errorOf(writers[0]![1](id))).toBe(
          "FORBIDDEN:POSITION_LOCKED",
        );
      });
    });

    describe("concurrent calls with no pause", () => {
      it.each([1, 2, 3, 4, 5, 6])(
        "round %i: a flagged position never has an unaudited holder or CCA",
        async () => {
          const id = await makePosition();
          await Promise.all([
            errorOf(
              as(U.admin, ADMIN).setFlag({
                id,
                flag: "vetsProposals",
                value: true,
                seen: SEEN,
              }),
            ),
            errorOf(as(U.plain, JCRC).addHolder({ id, userID: U.plain2 })),
            errorOf(as(U.plain, JCRC).setCcas({ id, ccaIDs: [9001, 9003] })),
          ]);

          const row = await db.jcrcPosition.findUnique({ where: { id } });
          if (row?.vetsProposals !== true) return; // the flag was refused
          // The flag took effect over exactly what its audit row lists.
          const [flagRow] = await db.roleAuditLog.findMany({
            where: { action: "jcrcPosition.flag.set" },
          });
          expect(flagRow?.reason).toContain(
            `holders: ${(await holdersOf(id)).join(", ")}; ccas: ${(
              await ccasOf(id)
            ).join(", ")}`,
          );
          expect(await holdersOf(id)).toEqual([U.holder]);
          expect(await ccasOf(id)).toEqual([9001, 9002]);
        },
      );
    });

    describe("the self-assigned mark", () => {
      /** A position whose holder gave it to themselves (an admin may, unflagged). */
      const selfAssigned = async () => {
        const id = await makePosition();
        await as(U.selfAdmin, ADMIN_JCRC).addHolder({
          id,
          userID: U.selfAdmin,
        });
        return id;
      };
      const markOf = async (id: string, userID: string) =>
        (
          await db.jcrcPositionHolder.findFirst({
            where: { positionID: id, userID },
          })
        )?.assignedBy;
      const setVets = (id: string) =>
        errorOf(
          as(U.admin, ADMIN).setFlag({
            id,
            flag: "vetsProposals",
            value: true,
            seen: { holderIDs: [U.holder, U.selfAdmin], ccaIDs: [9001, 9002] },
          }),
        );
      const handOver = (id: string) =>
        errorOf(
          as(U.selfAdmin, ADMIN_JCRC).handOver({
            positionIDs: [id],
            successorIDs: [U.successor],
            stepOutAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          }),
        );

      it("survives a plain member re-adding the holder: flagging and handover are still refused", async () => {
        const id = await selfAssigned();
        expect(await markOf(id, U.selfAdmin)).toBe(U.selfAdmin);

        expect(
          await errorOf(
            as(U.plain, JCRC).addHolder({ id, userID: U.selfAdmin }),
          ),
        ).toBe("ok");
        expect(await markOf(id, U.selfAdmin)).toBe(U.selfAdmin);

        expect(await setVets(id)).toBe("FORBIDDEN:SELF_ASSIGNED_HOLDER");
        expect(await auditActions()).toEqual([]);
        expect(await handOver(id)).toBe("FORBIDDEN:SELF_ASSIGNED_POSITION");
      });

      it("survives the holder re-adding themselves", async () => {
        const id = await selfAssigned();
        expect(
          await errorOf(
            as(U.selfAdmin, ADMIN_JCRC).addHolder({
              id,
              userID: U.selfAdmin,
            }),
          ),
        ).toBe("ok");
        expect(await markOf(id, U.selfAdmin)).toBe(U.selfAdmin);
        expect(await setVets(id)).toBe("FORBIDDEN:SELF_ASSIGNED_HOLDER");
      });

      it("is cleared when a different admin re-adds the holder: flagging and handover are then allowed", async () => {
        const id = await selfAssigned();
        expect(
          await errorOf(
            as(U.admin, ADMIN).addHolder({ id, userID: U.selfAdmin }),
          ),
        ).toBe("ok");
        expect(await markOf(id, U.selfAdmin)).toBe(U.admin);

        expect(await setVets(id)).toBe("ok");
        expect(await handOver(id)).toBe("ok");
      });

      it("still lets a re-add replace the assigner of an ordinary row", async () => {
        const id = await makePosition();
        expect(await markOf(id, U.holder)).toBe(U.admin);
        await as(U.plain, JCRC).addHolder({ id, userID: U.holder });
        expect(await markOf(id, U.holder)).toBe(U.plain);
      });
    });
  },
);
