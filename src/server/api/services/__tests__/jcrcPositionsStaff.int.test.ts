import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type * as GuardModule from "../directorGuard";
import type * as ScrcFlagModule from "../scrcFlag";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of the staff door to flagged positions (the panel on
 * /scrc) against the LOCAL development database (skipped unless DATABASE_URL
 * is the local dev database; run `npm run test:db`). They cover A63 and A65 in
 * full and the vacancy cases of A49 that need no proposals.
 *
 * The tests own every row they touch: users E99906xx and positions named
 * "TEST ...", all removed before and after each test, and the `scrc.enabled`
 * and `directors.enabled` rows are put back as they were.
 */

const U = {
  plain: "E9990601",
  plain2: "E9990602",
  holder: "E9990603",
  admin: "E9990604",
  rf: "E9990605",
  office: "E9990606",
  successor: "E9990607",
  noJcrc: "E9990608",
};
const ALL_IDS = Object.values(U);
const SCRC_FLAG = "scrc.enabled";
const DIRECTORS_FLAG = "directors.enabled";
const JCRC = ["resident", "jcrc"];
const ADMIN = ["resident", "admin"];
const RF = ["resident", "scrc"];
const OFFICE = ["resident", "hall_office"];

const STAFF: [string, string, string[]][] = [
  ["an admin", U.admin, ADMIN],
  ["an RF", U.rf, RF],
  ["a Hall Office member", U.office, OFFICE],
];

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "the staff door to flagged positions (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let guard: typeof GuardModule;
    let scrcFlag: typeof ScrcFlagModule;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;

    const caller = (
      userID: string,
      roles: string[],
      database: PrismaClient = db,
    ) =>
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
      });
    const staff = (userID: string, roles: string[]) =>
      caller(userID, roles).jcrcPositionsStaff;
    const positionsApi = (userID: string, roles: string[]) =>
      caller(userID, roles).jcrcPositions;

    const errorOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return `${e.code}:${e.message}`;
      }
      return "ok";
    };

    const setFlag = async (key: string, value: string | null) => {
      if (value === null) {
        await db.systemFlag.deleteMany({ where: { key } });
      } else {
        await db.systemFlag.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      }
      scrcFlag.resetScrcFlagCache();
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
      await db.ccaHead.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.jcrcPosition.deleteMany({ where: { id: { in: ids } } });
      await db.jcrcTerm.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.pendingRoleGrant.deleteMany({
        where: { userID: { in: ALL_IDS } },
      });
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

    /** A position straight in the database, so the setup is not under test. */
    const makePosition = async (
      name: string,
      opts: {
        vets?: boolean;
        social?: boolean;
        ccaIDs?: number[];
        holders?: { userID: string; assignedBy?: string; endsAt?: Date }[];
      } = {},
    ) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          ...(opts.vets === undefined ? {} : { vetsProposals: opts.vets }),
          ...(opts.social === undefined
            ? {}
            : { handlesDisposables: opts.social }),
        },
      });
      for (const ccaID of opts.ccaIDs ?? []) {
        await db.jcrcPositionCca.create({
          data: { positionID: p.id, ccaID, addedBy: "test" },
        });
      }
      for (const h of opts.holders ?? []) {
        await db.jcrcPositionHolder.create({
          data: {
            positionID: p.id,
            userID: h.userID,
            assignedBy: h.assignedBy ?? U.admin,
            endsAt: h.endsAt ?? null,
          },
        });
      }
      return p.id;
    };

    const flagged = () =>
      makePosition("Sports", {
        vets: true,
        ccaIDs: [9001, 9002],
        holders: [{ userID: U.holder }],
      });
    const unflagged = () =>
      makePosition("Culture", {
        ccaIDs: [9001, 9002],
        holders: [{ userID: U.holder }],
      });

    const positionAudit = () =>
      db.roleAuditLog.findMany({
        where: { action: { startsWith: "jcrcPosition." } },
        orderBy: { at: "asc" },
      });
    const holdersOf = async (id: string) =>
      (await db.jcrcPositionHolder.findMany({ where: { positionID: id } }))
        .map((h) => h.userID)
        .sort();
    const ccasOf = async (id: string) =>
      (await db.jcrcPositionCca.findMany({ where: { positionID: id } }))
        .map((c) => c.ccaID)
        .sort();
    const nameOf = async (id: string) =>
      (await db.jcrcPosition.findUnique({ where: { id } }))?.name ?? null;

    /** The five staff changes, each aimed at position `id`. */
    const changes = (id: string, who: ReturnType<typeof staff>) =>
      [
        ["add a holder", () => who.addHolder({ id, userID: U.plain2 })],
        ["remove a holder", () => who.removeHolder({ id, userID: U.holder })],
        ["change the CCA list", () => who.setCcas({ id, ccaIDs: [9003] })],
        ["rename", () => who.rename({ id, name: "TEST Renamed" })],
        ["delete", () => who.delete({ id })],
      ] as [string, () => Promise<unknown>][];

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      guard = await import("../directorGuard");
      scrcFlag = await import("../scrcFlag");
      for (const key of [SCRC_FLAG, DIRECTORS_FLAG]) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await setFlag(SCRC_FLAG, "on");
      await setFlag(DIRECTORS_FLAG, "on");
      for (const id of [U.plain, U.plain2, U.holder, U.successor]) {
        await setRoles(id, JCRC);
      }
      await setRoles(U.admin, ADMIN);
      await setRoles(U.rf, RF);
      await setRoles(U.office, OFFICE);
      await setRoles(U.noJcrc, ["resident"]);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of [SCRC_FLAG, DIRECTORS_FLAG]) {
          await setFlag(key, original[key] ?? null);
        }
        await db.$disconnect();
      }
    });

    // ---------------------------------------------------------------- A63
    describe("A63: admins, RFs and Hall Office reach flagged positions through the staff door", () => {
      it.each(STAFF)(
        "%s lists the flagged positions only",
        async (_n, id, roles) => {
          await flagged();
          await unflagged();
          const { positions, ccas } = await staff(id, roles).list();
          const mine = positions.filter((p) => p.name.startsWith("TEST "));
          expect(mine.map((p) => p.name)).toEqual(["TEST Sports"]);
          expect(mine[0]!.ccas.map((c) => c.ccaID).sort()).toEqual([
            9001, 9002,
          ]);
          expect(mine[0]!.holders.map((h) => h.userID)).toEqual([U.holder]);
          expect(mine[0]!.powers).toEqual(["Vets proposals"]);
          expect(Array.isArray(ccas)).toBe(true);
        },
      );

      it.each(STAFF)(
        "%s edits a flagged position through it",
        async (_n, id, roles) => {
          const position = await flagged();
          const who = staff(id, roles);
          await who.addHolder({ id: position, userID: U.plain2 });
          expect(await holdersOf(position)).toEqual(
            [U.holder, U.plain2].sort(),
          );
          await who.removeHolder({ id: position, userID: U.plain2 });
          expect(await holdersOf(position)).toEqual([U.holder]);
          await who.setCcas({ id: position, ccaIDs: [9002, 9003] });
          expect(await ccasOf(position)).toEqual([9002, 9003]);
          await who.rename({ id: position, name: "TEST Renamed" });
          expect(await nameOf(position)).toBe("TEST Renamed");
          await who.delete({ id: position });
          expect(await nameOf(position)).toBeNull();
        },
      );

      it("shows the panel only with scrc.enabled and directors.enabled both on", async () => {
        const who = staff(U.rf, RF);
        expect(await who.status()).toEqual({ visible: true });
        await setFlag(DIRECTORS_FLAG, "off");
        expect(await who.status()).toEqual({ visible: false });
        await setFlag(DIRECTORS_FLAG, null);
        expect(await who.status()).toEqual({ visible: false });
        await setFlag(DIRECTORS_FLAG, "on");
        await setFlag(SCRC_FLAG, "off");
        expect(await who.status()).toEqual({ visible: false });
        await setFlag(SCRC_FLAG, null);
        expect(await who.status()).toEqual({ visible: false });
      });

      describe("with scrc.enabled off", () => {
        it.each([["off"], [null]])(
          "refuses every call when the switch is %s, and changes nothing",
          async (value) => {
            const position = await flagged();
            await setFlag(SCRC_FLAG, value);
            for (const [, id, roles] of STAFF) {
              const who = staff(id, roles);
              expect(await errorOf(who.list())).toBe("FORBIDDEN:SCRC_DISABLED");
              for (const [, run] of changes(position, who)) {
                expect(await errorOf(run())).toBe("FORBIDDEN:SCRC_DISABLED");
              }
            }
            expect(await holdersOf(position)).toEqual([U.holder]);
            expect(await ccasOf(position)).toEqual([9001, 9002]);
            expect(await nameOf(position)).toBe("TEST Sports");
            expect(await positionAudit()).toEqual([]);
          },
        );

        it("refuses every call when the switch cannot be read", async () => {
          const position = await flagged();
          // Not cached: the next read must hit the broken database.
          scrcFlag.resetScrcFlagCache();
          const broken = new Proxy(db, {
            get(target, prop, receiver) {
              if (prop === "systemFlag") {
                return {
                  findUnique: () => Promise.reject(new Error("unreadable")),
                };
              }
              return Reflect.get(target, prop, receiver) as unknown;
            },
          });
          const who = caller(U.rf, RF, broken).jcrcPositionsStaff;
          expect(await errorOf(who.list())).toBe("FORBIDDEN:SCRC_DISABLED");
          for (const [, run] of changes(position, who)) {
            expect(await errorOf(run())).toBe("FORBIDDEN:SCRC_DISABLED");
          }
          expect(await holdersOf(position)).toEqual([U.holder]);
          expect(await positionAudit()).toEqual([]);
        });

        it("leaves admins editing through the Positions page", async () => {
          const position = await flagged();
          await setFlag(SCRC_FLAG, "off");
          const admin = positionsApi(U.admin, ADMIN);
          await admin.addHolder({ id: position, userID: U.plain2 });
          await admin.setCcas({ id: position, ccaIDs: [9003] });
          expect(await holdersOf(position)).toEqual(
            [U.holder, U.plain2].sort(),
          );
          expect(await ccasOf(position)).toEqual([9003]);
        });
      });

      it("keeps a staff member from setting or clearing a flag", async () => {
        const id = await unflagged();
        const withFlag = await flagged();
        for (const [, userID, roles] of STAFF.slice(1)) {
          const api = positionsApi(userID, roles);
          expect(
            await errorOf(
              api.setFlag({
                id,
                flag: "vetsProposals",
                value: true,
                seen: { holderIDs: [U.holder], ccaIDs: [9001, 9002] },
              }),
            ),
          ).toMatch(/^FORBIDDEN/);
          expect(
            await errorOf(
              api.setFlag({
                id: withFlag,
                flag: "vetsProposals",
                value: false,
                seen: { holderIDs: [U.holder], ccaIDs: [9001, 9002] },
              }),
            ),
          ).toMatch(/^FORBIDDEN/);
        }
        const row = await db.jcrcPosition.findUnique({ where: { id } });
        expect(row?.vetsProposals ?? null).toBeNull();
        expect(
          (await db.jcrcPosition.findUnique({ where: { id: withFlag } }))
            ?.vetsProposals,
        ).toBe(true);
        // And the staff door has no way to say it at all.
        const { jcrcPositionsStaffRouter } = await import(
          "~/server/api/routers/jcrcPositionsStaff"
        );
        const names = Object.keys(
          (
            jcrcPositionsStaffRouter as unknown as {
              _def: { procedures: Record<string, unknown> };
            }
          )._def.procedures,
        );
        expect(names.filter((n) => /flag/i.test(n))).toEqual([]);
        expect(names.sort()).toEqual(
          [
            "addHolder",
            "delete",
            "list",
            "removeHolder",
            "rename",
            "setCcas",
            "status",
          ].sort(),
        );
      });

      it("does not give staff the Positions router's own edits", async () => {
        const position = await flagged();
        for (const [, userID, roles] of STAFF.slice(1)) {
          const api = positionsApi(userID, roles);
          // Staff may set holders of an ordinary position through the Positions
          // router, but a flagged one only through the staff door.
          expect(
            await errorOf(api.addHolder({ id: position, userID: U.plain2 })),
          ).toBe("FORBIDDEN:USE_DIRECTOR_PANEL");
          expect(
            await errorOf(api.removeHolder({ id: position, userID: U.holder })),
          ).toBe("FORBIDDEN:USE_DIRECTOR_PANEL");
          expect(await errorOf(api.delete({ id: position }))).toMatch(
            /^FORBIDDEN/,
          );
        }
        expect(await holdersOf(position)).toEqual([U.holder]);
      });

      it("refuses a staff member's edit of an unflagged position, for every change", async () => {
        const position = await unflagged();
        for (const [, id, roles] of STAFF) {
          for (const [name, run] of changes(position, staff(id, roles))) {
            expect(await errorOf(run()), name).toBe("FORBIDDEN:NOT_FLAGGED");
          }
        }
        expect(await holdersOf(position)).toEqual([U.holder]);
        expect(await ccasOf(position)).toEqual([9001, 9002]);
        expect(await nameOf(position)).toBe("TEST Culture");
        expect(await positionAudit()).toEqual([]);
      });

      it("reads the flag from the stored row at each call", async () => {
        const position = await unflagged();
        const who = staff(U.rf, RF);
        expect(
          await errorOf(who.addHolder({ id: position, userID: U.plain2 })),
        ).toBe("FORBIDDEN:NOT_FLAGGED");
        await db.jcrcPosition.update({
          where: { id: position },
          data: { handlesDisposables: true },
        });
        expect(
          await errorOf(who.addHolder({ id: position, userID: U.plain2 })),
        ).toBe("ok");
        await db.jcrcPosition.update({
          where: { id: position },
          data: { handlesDisposables: false },
        });
        expect(
          await errorOf(who.removeHolder({ id: position, userID: U.plain2 })),
        ).toBe("FORBIDDEN:NOT_FLAGGED");
      });

      it("answers NOT_FOUND for a position that does not exist", async () => {
        const gone = "0123456789abcdef01234567";
        const who = staff(U.office, OFFICE);
        for (const [, run] of changes(gone, who)) {
          expect(await errorOf(run())).toBe("NOT_FOUND:POSITION_NOT_FOUND");
        }
      });

      it("never makes a staff editor a director: staff cannot hold jcrc", async () => {
        const position = await flagged();
        // Adding a staff member as a holder is refused: they hold no jcrc.
        expect(
          await errorOf(
            staff(U.admin, ADMIN).addHolder({ id: position, userID: U.rf }),
          ),
        ).toBe("BAD_REQUEST:TARGET_NOT_JCRC");
        // Even a holder row written straight in grants nothing without jcrc.
        await db.jcrcPositionHolder.create({
          data: { positionID: position, userID: U.rf, assignedBy: U.admin },
        });
        expect(await guard.isDirectorOf(db, U.rf, 9001)).toBe(false);
        expect(await guard.isDirectorOf(db, U.office, 9001)).toBe(false);
      });

      it.each([
        ["a plain jcrc member", U.plain, JCRC],
        ["a resident", U.noJcrc, ["resident"]],
      ])("keeps %s out of the panel's calls", async (_n, id, roles) => {
        const position = await flagged();
        const who = staff(id, roles);
        expect(await errorOf(who.list())).toMatch(/^FORBIDDEN/);
        expect(await errorOf(who.status())).toMatch(/^FORBIDDEN/);
        for (const [, run] of changes(position, who)) {
          expect(await errorOf(run())).toMatch(/^FORBIDDEN/);
        }
        expect(await holdersOf(position)).toEqual([U.holder]);
        expect(await ccasOf(position)).toEqual([9001, 9002]);
        expect(await positionAudit()).toEqual([]);
      });

      it("reads the caller's roles live, not from a stale session", async () => {
        const position = await flagged();
        // The session still says RF, but the stored role has gone.
        await db.userRole.update({
          where: { userID: U.rf },
          data: { roles: ["resident"] },
        });
        expect(
          await errorOf(
            staff(U.rf, RF).addHolder({ id: position, userID: U.plain2 }),
          ),
        ).toBe("FORBIDDEN:NOT_STAFF");
        expect(await holdersOf(position)).toEqual([U.holder]);
      });
    });

    // ---------------------------------------------------------------- A65
    describe("A65: the lock, seen from the staff door", () => {
      it.each(STAFF)(
        "%s succeeds at each change, and each writes one audit row",
        async (_n, id, roles) => {
          const position = await flagged();
          const who = staff(id, roles);
          await who.addHolder({ id: position, userID: U.plain2 });
          await who.removeHolder({ id: position, userID: U.plain2 });
          await who.setCcas({ id: position, ccaIDs: [9002, 9003] });
          await who.rename({ id: position, name: "TEST Sports (renamed)" });
          let rows = await positionAudit();
          expect(rows.map((r) => r.action)).toEqual([
            "jcrcPosition.holder.add",
            "jcrcPosition.holder.remove",
            "jcrcPosition.ccas.set",
            "jcrcPosition.rename",
          ]);
          expect(rows.every((r) => r.actorUserID === id)).toBe(true);
          expect(rows.every((r) => r.actorRoles.includes(roles[1]!))).toBe(
            true,
          );
          expect(rows.every((r) => r.ok)).toBe(true);
          expect(rows.every((r) => r.reason?.includes(position))).toBe(true);
          expect(rows[0]!.targetUserID).toBe(U.plain2);
          expect(rows[2]!.reason).toContain("added: 9003");
          expect(rows[2]!.reason).toContain("removed: 9001");

          await who.delete({ id: position });
          rows = await positionAudit();
          expect(rows).toHaveLength(5);
          expect(rows[4]!.action).toBe("jcrcPosition.delete");
          expect(rows[4]!.reason).toContain(U.holder);
          expect(rows[4]!.reason).toContain("9002, 9003");
        },
      );

      it("writes no audit row for a change that changed nothing", async () => {
        const position = await flagged();
        const who = staff(U.rf, RF);
        await who.removeHolder({ id: position, userID: U.plain2 });
        await who.setCcas({ id: position, ccaIDs: [9001, 9002] });
        await who.rename({ id: position, name: "TEST Sports" });
        expect(await positionAudit()).toEqual([]);
      });

      it("refuses the rename of a flagged position to a name already taken", async () => {
        const position = await flagged();
        await unflagged();
        expect(
          await errorOf(
            staff(U.rf, RF).rename({ id: position, name: "TEST Culture" }),
          ),
        ).toBe("CONFLICT:NAME_TAKEN");
        expect(await nameOf(position)).toBe("TEST Sports");
      });

      it("refuses an unknown CCA and a target without jcrc, and changes nothing", async () => {
        const position = await flagged();
        const who = staff(U.office, OFFICE);
        expect(
          await errorOf(who.setCcas({ id: position, ccaIDs: [123456] })),
        ).toBe("BAD_REQUEST:UNKNOWN_CCA");
        expect(
          await errorOf(who.addHolder({ id: position, userID: U.noJcrc })),
        ).toBe("BAD_REQUEST:TARGET_NOT_JCRC");
        expect(await holdersOf(position)).toEqual([U.holder]);
        expect(await ccasOf(position)).toEqual([9001, 9002]);
        expect(await positionAudit()).toEqual([]);
      });

      it("refuses self-assignment to a flagged position, an admin's included", async () => {
        const position = await flagged();
        await db.userRole.update({
          where: { userID: U.admin },
          data: { roles: ["resident", "admin", "jcrc"] },
        });
        expect(
          await errorOf(
            staff(U.admin, ["resident", "admin", "jcrc"]).addHolder({
              id: position,
              userID: U.admin,
            }),
          ),
        ).toBe("FORBIDDEN:SELF_ASSIGN_FLAGGED");
        expect(await holdersOf(position)).toEqual([U.holder]);
      });

      it("shares its refusals with the Positions router: a plain member is still locked out", async () => {
        const position = await flagged();
        const plain = positionsApi(U.plain, JCRC);
        expect(
          await errorOf(plain.addHolder({ id: position, userID: U.plain2 })),
        ).toBe("FORBIDDEN:POSITION_LOCKED");
        expect(await errorOf(plain.delete({ id: position }))).toBe(
          "FORBIDDEN:POSITION_LOCKED",
        );
        // An unflagged position keeps #119's open editing, with no audit row.
        const open = await unflagged();
        await plain.addHolder({ id: open, userID: U.plain2 });
        await plain.removeHolder({ id: open, userID: U.plain2 });
        expect(await positionAudit()).toEqual([]);
      });

      it("keeps a holder's handover working on a flagged position", async () => {
        const position = await flagged();
        await caller(U.holder, JCRC).jcrcPositions.handOver({
          positionIDs: [position],
          successorIDs: [U.successor],
          stepOutAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        expect(await holdersOf(position)).toEqual(
          [U.holder, U.successor].sort(),
        );
      });

      it.each(STAFF)(
        "refuses %s adding someone who heads a CCA the position lists",
        async (_label, userID, roles) => {
          const position = await flagged();
          await db.ccaHead.create({ data: { userID: U.plain, ccaID: 9002 } });
          expect(
            await errorOf(
              staff(userID, roles).addHolder({ id: position, userID: U.plain }),
            ),
          ).toBe("FORBIDDEN:HEADS_LISTED_CCA");
          expect(await holdersOf(position)).toEqual([U.holder]);
          expect(await positionAudit()).toEqual([]);
          // Heading a CCA the position does not list is fine.
          await db.ccaHead.deleteMany({ where: { userID: U.plain } });
          await db.ccaHead.create({ data: { userID: U.plain, ccaID: 9099 } });
          expect(
            await errorOf(
              staff(userID, roles).addHolder({ id: position, userID: U.plain }),
            ),
          ).toBe("ok");
        },
      );

      it("lets an RF confirm a handover successor, who can then hand on once", async () => {
        const position = await flagged();
        const hour = 60 * 60 * 1000;
        await caller(U.holder, JCRC).jcrcPositions.handOver({
          positionIDs: [position],
          successorIDs: [U.successor],
          stepOutAt: new Date(Date.now() + hour),
        });
        const handOn = () =>
          errorOf(
            caller(U.successor, JCRC).jcrcPositions.handOver({
              positionIDs: [position],
              successorIDs: [U.plain2],
              stepOutAt: new Date(Date.now() + hour),
            }),
          );
        expect(await handOn()).toBe("FORBIDDEN:NEEDS_STAFF_CONFIRMATION");
        expect(
          await errorOf(
            staff(U.rf, RF).addHolder({ id: position, userID: U.successor }),
          ),
        ).toBe("ok");
        expect(await handOn()).toBe("ok");
      });
    });

    // ---------------------------------------------------------------- A49
    describe("A49: a flagged position with no current qualifying holder is vacant", () => {
      const vacantOf = async (
        id: string,
        via: "staff" | "positions" = "staff",
      ) => {
        if (via === "positions") {
          const rows = await positionsApi(U.admin, ADMIN).list();
          return rows.find((p) => p.id === id)?.vacant;
        }
        const { positions } = await staff(U.rf, RF).list();
        return positions.find((p) => p.id === id)?.vacant;
      };

      it("is vacant with no holder", async () => {
        const id = await makePosition("Empty", { vets: true, ccaIDs: [9001] });
        expect(await vacantOf(id)).toBe(true);
        expect(await vacantOf(id, "positions")).toBe(true);
      });

      it("is vacant when every row has ended", async () => {
        const id = await makePosition("Ended", {
          vets: true,
          ccaIDs: [9001],
          holders: [
            { userID: U.holder, endsAt: new Date(Date.now() - 1000) },
            { userID: U.plain, endsAt: new Date(Date.now() - 2000) },
          ],
        });
        expect(await vacantOf(id)).toBe(true);
        expect(await vacantOf(id, "positions")).toBe(true);
      });

      it("is vacant when its holders do not hold jcrc", async () => {
        const id = await makePosition("No jcrc", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.noJcrc }],
        });
        expect(await vacantOf(id)).toBe(true);
        expect(await vacantOf(id, "positions")).toBe(true);
      });

      it("is vacant when the only holder's jcrc has ended", async () => {
        const id = await makePosition("Stepped out", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.holder }],
        });
        expect(await vacantOf(id)).toBe(false);
        await db.jcrcTerm.create({
          data: { userID: U.holder, endsAt: new Date(Date.now() - 1000) },
        });
        expect(await vacantOf(id)).toBe(true);
      });

      it("is not vacant with one current holder who holds jcrc, among others who do not", async () => {
        const id = await makePosition("Covered", {
          vets: true,
          ccaIDs: [9001],
          holders: [
            { userID: U.noJcrc },
            { userID: U.holder },
            { userID: U.plain, endsAt: new Date(Date.now() - 1000) },
          ],
        });
        expect(await vacantOf(id)).toBe(false);
        expect(await vacantOf(id, "positions")).toBe(false);
      });

      it("applies to a position flagged only for disposables", async () => {
        const id = await makePosition("Social", { social: true });
        expect(await vacantOf(id)).toBe(true);
      });

      it("marks an unflagged position as not vacant: it grants nothing", async () => {
        const id = await makePosition("Plain", { ccaIDs: [9001] });
        expect(await vacantOf(id, "positions")).toBe(false);
      });

      it("is computed on read: a new holder clears it, a removed one brings it back", async () => {
        const id = await makePosition("Moving", { vets: true });
        expect(await vacantOf(id)).toBe(true);
        await staff(U.rf, RF).addHolder({ id, userID: U.holder });
        expect(await vacantOf(id)).toBe(false);
        await staff(U.rf, RF).removeHolder({ id, userID: U.holder });
        expect(await vacantOf(id)).toBe(true);
      });

      it("a handover to a successor never leaves the position vacant", async () => {
        const id = await flagged();
        expect(await vacantOf(id)).toBe(false);
        await caller(U.holder, JCRC).jcrcPositions.handOver({
          positionIDs: [id],
          successorIDs: [U.successor],
          stepOutAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        expect(await vacantOf(id)).toBe(false);
        // The outgoing holder's row ends; the successor's has no end.
        await db.jcrcPositionHolder.updateMany({
          where: { positionID: id, userID: U.holder },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        expect(await vacantOf(id)).toBe(false);
      });

      /** A database whose vacancy read of jcrcTerm (the only one with a select) fails. */
      const breakVacancyRead = () =>
        new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "jcrcTerm") {
              return new Proxy(target.jcrcTerm, {
                get(model, method, r) {
                  if (method === "findMany") {
                    return (args?: { select?: unknown }) =>
                      args?.select
                        ? Promise.reject(new Error("down"))
                        : model.findMany(args as never);
                  }
                  return Reflect.get(model, method, r) as unknown;
                },
              });
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });

      it("a failed vacancy read shows 'unknown' (null) and still lists, on both doors", async () => {
        const held = await flagged();
        const plain = await unflagged();
        const broken = breakVacancyRead();
        const { positions } = await caller(
          U.rf,
          RF,
          broken,
        ).jcrcPositionsStaff.list();
        expect(positions.find((p) => p.id === held)?.vacant).toBeNull();
        const rows = await caller(U.admin, ADMIN, broken).jcrcPositions.list();
        expect(rows.find((p) => p.id === held)?.vacant).toBeNull();
        // An unflagged position is not affected: it has nothing to be vacant of.
        expect(rows.find((p) => p.id === plain)?.vacant).toBe(false);
        // The guard itself stays strict.
        await expect(
          guard.isPositionVacant(broken, held),
        ).rejects.toBeDefined();
      });

      it("the Positions list marks vacancy: no holder, ended rows, no jcrc, and a live holder", async () => {
        const none = await makePosition("None", { vets: true });
        const ended = await makePosition("Ended", {
          social: true,
          holders: [{ userID: U.holder, endsAt: new Date(Date.now() - 1000) }],
        });
        const noJcrc = await makePosition("NoJcrc", {
          vets: true,
          holders: [{ userID: U.noJcrc }],
        });
        const live = await makePosition("Live", {
          vets: true,
          holders: [{ userID: U.holder }],
        });
        const open = await makePosition("Open", {
          holders: [{ userID: U.plain }],
        });
        const rows = await positionsApi(U.admin, ADMIN).list();
        const vacant = (id: string) => rows.find((p) => p.id === id)?.vacant;
        expect(vacant(none)).toBe(true);
        expect(vacant(ended)).toBe(true);
        expect(vacant(noJcrc)).toBe(true);
        expect(vacant(live)).toBe(false);
        expect(vacant(open)).toBe(false);
        // A plain JCRC member sees the same, and "mine" no longer carries it.
        const member = await caller(U.plain, JCRC).jcrcPositions.list();
        expect(member.find((p) => p.id === none)?.vacant).toBe(true);
        const mine = await caller(U.holder, JCRC).jcrcPositions.mine();
        expect(mine.positions.every((p) => !("vacant" in p))).toBe(true);
      });
    });
  },
);
