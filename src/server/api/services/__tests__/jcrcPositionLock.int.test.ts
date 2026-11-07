import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type * as GuardModule from "../directorGuard";
import type * as AccessModule from "../access";
import type * as ScopeModule from "../ccaScope";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of the lock on flagged positions, the admin-only flag
 * controls and the handover, against the LOCAL development database (skipped
 * unless DATABASE_URL is the local dev database; run `npm run test:db`). The
 * tests own every row they touch: users E99904xx and positions named
 * "TEST ...", all removed before and after each test, and the
 * `directors.enabled` row is put back as it was.
 *
 * RFs and Hall Office reach the lock through the staff panel in a later PR;
 * the check they will call is covered in jcrcPositionLock.test.ts.
 */

const U = {
  plain: "E9990401",
  plain2: "E9990402",
  holder: "E9990403",
  admin: "E9990404",
  successor: "E9990405",
  unplaced: "E9990406",
  resident: "E9990407",
};
const ALL_IDS = Object.values(U);
const FLAG = "directors.enabled";
const JCRC = ["resident", "jcrc"];
const ADMIN = ["resident", "admin"];

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "flagged positions (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let guard: typeof GuardModule;
    let access: typeof AccessModule;
    let scope: typeof ScopeModule;
    let originalFlag: string | null = null;
    let ipCounter = 0;

    const as = (userID: string, roles: string[]) =>
      createCaller({
        db,
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

    const errorOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return `${e.code}:${e.message}`;
      }
      return "ok";
    };

    const setFlag = async (value: string | null) => {
      if (value === null) {
        await db.systemFlag.deleteMany({ where: { key: FLAG } });
      } else {
        await db.systemFlag.upsert({
          where: { key: FLAG },
          create: { key: FLAG, value },
          update: { value },
        });
      }
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

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      guard = await import("../directorGuard");
      access = await import("../access");
      scope = await import("../ccaScope");
      originalFlag =
        (await db.systemFlag.findUnique({ where: { key: FLAG } }))?.value ??
        null;
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await setFlag("on");
      for (const id of [U.plain, U.plain2, U.holder, U.unplaced]) {
        await setRoles(id, JCRC);
      }
      await setRoles(U.admin, ADMIN);
      await setRoles(U.successor, ["resident"]);
      await setRoles(U.resident, ["resident"]);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        await setFlag(originalFlag);
        await db.$disconnect();
      }
    });

    // ---------------------------------------------------------------- A65
    describe("A65: a plain jcrc member is locked out of a flagged position", () => {
      const attempts: [string, (id: string) => Promise<unknown>][] = [
        [
          "add a holder",
          (id) => as(U.plain, JCRC).addHolder({ id, userID: U.plain2 }),
        ],
        [
          "remove a holder",
          (id) => as(U.plain, JCRC).removeHolder({ id, userID: U.holder }),
        ],
        [
          "change the CCA list",
          (id) => as(U.plain, JCRC).setCcas({ id, ccaIDs: [9003] }),
        ],
        [
          "rename",
          (id) => as(U.plain, JCRC).update({ id, name: "TEST Renamed" }),
        ],
        ["delete", (id) => as(U.plain, JCRC).delete({ id })],
      ];

      it.each(attempts)(
        "refuses to %s and changes nothing",
        async (_n, run) => {
          const id = await flagged();
          expect(await errorOf(run(id))).toBe("FORBIDDEN:POSITION_LOCKED");
          expect(await holdersOf(id)).toEqual([U.holder]);
          expect(await ccasOf(id)).toEqual([9001, 9002]);
          const row = await db.jcrcPosition.findUnique({ where: { id } });
          expect(row?.name).toBe("TEST Sports");
          expect(await positionAudit()).toEqual([]);
        },
      );

      it.each([["vetsProposals" as const], ["handlesDisposables" as const]])(
        "locks a position flagged only %s",
        async (flag) => {
          const id = await makePosition(`Only ${flag}`, {
            vets: flag === "vetsProposals" ? true : undefined,
            social: flag === "handlesDisposables" ? true : undefined,
            ccaIDs: [9001],
            holders: [{ userID: U.holder }],
          });
          expect(
            await errorOf(
              as(U.plain, JCRC).addHolder({ id, userID: U.plain2 }),
            ),
          ).toBe("FORBIDDEN:POSITION_LOCKED");
        },
      );

      it("keeps the lock when directors.enabled is off or absent", async () => {
        const id = await flagged();
        for (const value of ["off", null]) {
          await setFlag(value);
          expect(
            await errorOf(
              as(U.plain, JCRC).addHolder({ id, userID: U.plain2 }),
            ),
          ).toBe("FORBIDDEN:POSITION_LOCKED");
          expect(
            await errorOf(as(U.plain, JCRC).update({ id, name: "TEST Nope" })),
          ).toBe("FORBIDDEN:POSITION_LOCKED");
        }
      });

      it("reads the flag from the stored row at each call", async () => {
        const id = await unflagged();
        const me = as(U.plain, JCRC);
        expect(await errorOf(me.addHolder({ id, userID: U.plain2 }))).toBe(
          "ok",
        );
        await db.jcrcPosition.update({
          where: { id },
          data: { handlesDisposables: true },
        });
        expect(await errorOf(me.removeHolder({ id, userID: U.plain2 }))).toBe(
          "FORBIDDEN:POSITION_LOCKED",
        );
        await db.jcrcPosition.update({
          where: { id },
          data: { handlesDisposables: false },
        });
        expect(await errorOf(me.removeHolder({ id, userID: U.plain2 }))).toBe(
          "ok",
        );
      });

      it("still lets a plain member change what grants nothing: the oversees-all switch and the order", async () => {
        const id = await flagged();
        const me = as(U.plain, JCRC);
        expect(
          await errorOf(me.update({ id, overseesAll: true, order: 7 })),
        ).toBe("ok");
        // Sending the unchanged name is not a rename.
        expect(
          await errorOf(me.update({ id, name: "TEST Sports", order: 8 })),
        ).toBe("ok");
        expect(await positionAudit()).toEqual([]);
      });

      it("lets an admin do each, and writes one audit row for each", async () => {
        const id = await flagged();
        const admin = as(U.admin, ADMIN);
        await admin.addHolder({ id, userID: U.plain2 });
        await admin.removeHolder({ id, userID: U.plain2 });
        await admin.setCcas({ id, ccaIDs: [9002, 9003] });
        await admin.update({ id, name: "TEST Sports (renamed)" });
        const rows = await positionAudit();
        expect(rows.map((r) => r.action)).toEqual([
          "jcrcPosition.holder.add",
          "jcrcPosition.holder.remove",
          "jcrcPosition.ccas.set",
          "jcrcPosition.rename",
        ]);
        expect(rows.every((r) => r.actorUserID === U.admin)).toBe(true);
        expect(rows.every((r) => r.actorRoles.includes("admin"))).toBe(true);
        expect(rows.every((r) => r.ok)).toBe(true);
        expect(rows.every((r) => r.reason?.includes(id))).toBe(true);
        expect(rows[0]!.targetUserID).toBe(U.plain2);
        expect(rows[1]!.targetUserID).toBe(U.plain2);
        expect(rows[2]!.reason).toContain("added: 9003");
        expect(rows[2]!.reason).toContain("removed: 9001");
        expect(rows[3]!.reason).toContain("TEST Sports (renamed)");

        await admin.delete({ id });
        const all = await positionAudit();
        expect(all).toHaveLength(5);
        const last = all[4]!;
        expect(last.action).toBe("jcrcPosition.delete");
        // The delete row keeps what was deleted.
        expect(last.reason).toContain(U.holder);
        expect(last.reason).toContain("9002, 9003");
        expect(await db.jcrcPosition.findUnique({ where: { id } })).toBeNull();
      });

      it("writes no audit row for a change that changed nothing", async () => {
        const id = await flagged();
        const admin = as(U.admin, ADMIN);
        await admin.removeHolder({ id, userID: U.plain2 });
        await admin.setCcas({ id, ccaIDs: [9001, 9002] });
        expect(await positionAudit()).toEqual([]);
      });

      it("lets a plain member do every one on an unflagged position, with no audit row", async () => {
        const id = await unflagged();
        const me = as(U.plain, JCRC);
        await me.addHolder({ id, userID: U.plain2 });
        await me.removeHolder({ id, userID: U.plain2 });
        await me.setCcas({ id, ccaIDs: [9003] });
        await me.update({ id, name: "TEST Culture (renamed)" });
        await me.delete({ id });
        expect(await positionAudit()).toEqual([]);
      });

      it("lets an admin edit an unflagged position without an audit row", async () => {
        const id = await unflagged();
        await as(U.admin, ADMIN).setCcas({ id, ccaIDs: [9004] });
        expect(await positionAudit()).toEqual([]);
      });

      it("refuses a plain member before any other check, so a refusal is the lock", async () => {
        const id = await flagged();
        // Not JCRC target, unknown CCA: the lock answers first.
        expect(
          await errorOf(
            as(U.plain, JCRC).addHolder({ id, userID: U.resident }),
          ),
        ).toBe("FORBIDDEN:POSITION_LOCKED");
        expect(
          await errorOf(as(U.plain, JCRC).setCcas({ id, ccaIDs: [123456] })),
        ).toBe("FORBIDDEN:POSITION_LOCKED");
      });
    });

    describe("self-assignment", () => {
      it("is refused on a flagged position for a plain member and for an admin", async () => {
        const id = await flagged();
        expect(
          await errorOf(as(U.plain, JCRC).addHolder({ id, userID: U.plain })),
        ).toBe("FORBIDDEN:POSITION_LOCKED");
        await db.userRole.update({
          where: { userID: U.admin },
          data: { roles: ["resident", "admin", "jcrc"] },
        });
        expect(
          await errorOf(
            as(U.admin, ["resident", "admin", "jcrc"]).addHolder({
              id,
              userID: U.admin,
            }),
          ),
        ).toBe("FORBIDDEN:SELF_ASSIGN_FLAGGED");
        expect(await holdersOf(id)).toEqual([U.holder]);
      });

      it("keeps #119's rule on an unflagged position: an admin may, a plain member may not", async () => {
        const id = await unflagged();
        await db.userRole.update({
          where: { userID: U.admin },
          data: { roles: ["resident", "admin", "jcrc"] },
        });
        expect(
          await errorOf(
            as(U.admin, ["resident", "admin", "jcrc"]).addHolder({
              id,
              userID: U.admin,
            }),
          ),
        ).toBe("ok");
        expect(
          await errorOf(as(U.plain, JCRC).addHolder({ id, userID: U.plain })),
        ).toBe("FORBIDDEN:SELF_ASSIGN");
      });
    });

    // ------------------------------------------------- A47: setting a flag
    describe("setting and clearing a flag", () => {
      // What the screen shows: current holders only (an ended row is history).
      const seen = async (id: string) => ({
        holderIDs: (
          await db.jcrcPositionHolder.findMany({
            where: {
              positionID: id,
              OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
            },
          })
        )
          .map((h) => h.userID)
          .sort(),
        ccaIDs: await ccasOf(id),
      });

      it("is admin only", async () => {
        const id = await unflagged();
        const body = { id, flag: "vetsProposals" as const, value: true };
        expect(
          await errorOf(
            as(U.plain, JCRC).setFlag({ ...body, seen: await seen(id) }),
          ),
        ).toBe("FORBIDDEN:ADMIN_REQUIRED");
        expect(
          await errorOf(
            as(U.resident, ["resident"]).setFlag({
              ...body,
              seen: await seen(id),
            }),
          ),
        ).toMatch(/^FORBIDDEN/);
        const row = await db.jcrcPosition.findUnique({ where: { id } });
        expect(row?.vetsProposals ?? null).toBeNull();
        expect(await positionAudit()).toEqual([]);
      });

      it("records the holders and CCAs at that moment", async () => {
        const id = await unflagged();
        await as(U.admin, ADMIN).setFlag({
          id,
          flag: "vetsProposals",
          value: true,
          seen: await seen(id),
        });
        const [row] = await positionAudit();
        expect(row?.action).toBe("jcrcPosition.flag.set");
        expect(row?.actorUserID).toBe(U.admin);
        expect(row?.reason).toContain("vetsProposals set");
        expect(row?.reason).toContain(`holders: ${U.holder}`);
        expect(row?.reason).toContain("ccas: 9001, 9002");
        expect(row?.reason).toContain(id);
        expect(
          (await db.jcrcPosition.findUnique({ where: { id } }))?.vetsProposals,
        ).toBe(true);
        // The guard honours it at once.
        expect(await guard.isDirectorOf(db, U.holder, 9001)).toBe(true);

        await as(U.admin, ADMIN).setFlag({
          id,
          flag: "vetsProposals",
          value: false,
          seen: await seen(id),
        });
        const rows = await positionAudit();
        expect(rows.map((r) => r.action)).toEqual([
          "jcrcPosition.flag.set",
          "jcrcPosition.flag.clear",
        ]);
        expect(rows[1]!.reason).toContain(`holders: ${U.holder}`);
        expect(await guard.isDirectorOf(db, U.holder, 9001)).toBe(false);
      });

      it("sets the two flags independently", async () => {
        const id = await unflagged();
        const admin = as(U.admin, ADMIN);
        await admin.setFlag({
          id,
          flag: "handlesDisposables",
          value: true,
          seen: await seen(id),
        });
        const row = await db.jcrcPosition.findUnique({ where: { id } });
        expect(row?.handlesDisposables).toBe(true);
        expect(row?.vetsProposals ?? null).toBeNull();
        expect(await guard.isSocialDirector(db, U.holder)).toBe(true);
      });

      it("refuses, and writes nothing, when the holders or CCAs changed since the admin confirmed", async () => {
        const id = await unflagged();
        const admin = as(U.admin, ADMIN);
        const stale = await seen(id);
        await as(U.plain, JCRC).addHolder({ id, userID: U.plain2 });
        expect(
          await errorOf(
            admin.setFlag({
              id,
              flag: "vetsProposals",
              value: true,
              seen: stale,
            }),
          ),
        ).toBe("CONFLICT:CONFIRMATION_STALE");
        expect(
          await errorOf(
            admin.setFlag({
              id,
              flag: "vetsProposals",
              value: true,
              seen: { ...(await seen(id)), ccaIDs: [9001] },
            }),
          ),
        ).toBe("CONFLICT:CONFIRMATION_STALE");
        const row = await db.jcrcPosition.findUnique({ where: { id } });
        expect(row?.vetsProposals ?? null).toBeNull();
        expect(await positionAudit()).toEqual([]);
      });

      it("is refused while a current holder's row is self-assigned", async () => {
        const id = await makePosition("Self", {
          ccaIDs: [9001],
          holders: [
            { userID: U.holder },
            { userID: U.plain, assignedBy: U.plain },
          ],
        });
        expect(
          await errorOf(
            as(U.admin, ADMIN).setFlag({
              id,
              flag: "vetsProposals",
              value: true,
              seen: await seen(id),
            }),
          ),
        ).toBe("FORBIDDEN:SELF_ASSIGNED_HOLDER");
        expect(await positionAudit()).toEqual([]);
        // Remove the self-assigned row and it goes through.
        await as(U.admin, ADMIN).removeHolder({ id, userID: U.plain });
        expect(
          await errorOf(
            as(U.admin, ADMIN).setFlag({
              id,
              flag: "vetsProposals",
              value: true,
              seen: await seen(id),
            }),
          ),
        ).toBe("ok");
      });

      it("ignores a self-assigned row that has already ended", async () => {
        const id = await makePosition("Ended self", {
          ccaIDs: [9001],
          holders: [
            { userID: U.holder },
            {
              userID: U.plain,
              assignedBy: U.plain,
              endsAt: new Date(Date.now() - 1000),
            },
          ],
        });
        expect(
          await errorOf(
            as(U.admin, ADMIN).setFlag({
              id,
              flag: "vetsProposals",
              value: true,
              seen: await seen(id),
            }),
          ),
        ).toBe("ok");
      });

      it("clearing is not blocked by a self-assigned row", async () => {
        const id = await makePosition("Clear", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.plain, assignedBy: U.plain }],
        });
        expect(
          await errorOf(
            as(U.admin, ADMIN).setFlag({
              id,
              flag: "vetsProposals",
              value: false,
              seen: await seen(id),
            }),
          ),
        ).toBe("ok");
      });

      it("does nothing, and writes no audit row, when the flag already has that value", async () => {
        const id = await flagged();
        const result = await as(U.admin, ADMIN).setFlag({
          id,
          flag: "vetsProposals",
          value: true,
          seen: await seen(id),
        });
        expect(result.changed).toBe(false);
        expect(await positionAudit()).toEqual([]);
      });

      it("refuses both setting and clearing while directors.enabled is off", async () => {
        const id = await flagged();
        const other = await unflagged();
        await setFlag("off");
        expect(
          await errorOf(
            as(U.admin, ADMIN).setFlag({
              id: other,
              flag: "vetsProposals",
              value: true,
              seen: await seen(other),
            }),
          ),
        ).toBe("FORBIDDEN:DIRECTORS_DISABLED");
        expect(
          await errorOf(
            as(U.admin, ADMIN).setFlag({
              id,
              flag: "vetsProposals",
              value: false,
              seen: await seen(id),
            }),
          ),
        ).toBe("FORBIDDEN:DIRECTORS_DISABLED");
        await setFlag(null);
        expect(
          await errorOf(
            as(U.admin, ADMIN).setFlag({
              id: other,
              flag: "vetsProposals",
              value: true,
              seen: await seen(other),
            }),
          ),
        ).toBe("FORBIDDEN:DIRECTORS_DISABLED");
        expect(await positionAudit()).toEqual([]);
      });

      it("shows the controls only to an admin while the switch is on", async () => {
        const on = await as(U.admin, ADMIN).directorsStatus();
        expect(on).toEqual({ enabled: true, isAdmin: true, canSetFlags: true });
        const plain = await as(U.plain, JCRC).directorsStatus();
        expect(plain).toEqual({
          enabled: true,
          isAdmin: false,
          canSetFlags: false,
        });
        await setFlag("off");
        expect(await as(U.admin, ADMIN).directorsStatus()).toEqual({
          enabled: false,
          isAdmin: true,
          canSetFlags: false,
        });
        await setFlag(null);
        expect((await as(U.admin, ADMIN).directorsStatus()).enabled).toBe(
          false,
        );
      });

      it("lists the flags, a missing field as false", async () => {
        const a = await flagged();
        const b = await unflagged();
        const c = await makePosition("Social", { social: true });
        const rows = await as(U.plain, JCRC).list();
        const by = (id: string) => rows.find((r) => r.id === id)!;
        expect(by(a)).toMatchObject({
          vetsProposals: true,
          handlesDisposables: false,
        });
        expect(by(b)).toMatchObject({
          vetsProposals: false,
          handlesDisposables: false,
        });
        expect(by(c)).toMatchObject({
          vetsProposals: false,
          handlesDisposables: true,
        });
      });
    });

    // ------------------------------------------------------------ handover
    describe("handover on a flagged position", () => {
      it("is not blocked by the lock and passes the power to the successor", async () => {
        const id = await flagged();
        const stepOut = new Date(Date.now() + 60 * 60 * 1000);
        expect(
          await errorOf(
            as(U.holder, JCRC).handOver({
              positionIDs: [id],
              successorIDs: [U.successor],
              stepOutAt: stepOut,
            }),
          ),
        ).toBe("ok");
        expect(await holdersOf(id)).toEqual([U.holder, U.successor].sort());
        expect(await guard.isDirectorOf(db, U.successor, 9001)).toBe(true);
        // The outgoing holder acts until the step-out date.
        expect(await guard.isDirectorOf(db, U.holder, 9001)).toBe(true);
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.holder },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        expect(await guard.isDirectorOf(db, U.holder, 9001)).toBe(false);
        expect(await guard.isDirectorOf(db, U.successor, 9001)).toBe(true);
        // The position is still flagged.
        expect(
          (await db.jcrcPosition.findUnique({ where: { id } }))?.vetsProposals,
        ).toBe(true);
      });

      it("works while directors.enabled is off, and then grants nothing", async () => {
        const id = await flagged();
        await setFlag("off");
        expect(
          await errorOf(
            as(U.holder, JCRC).handOver({
              positionIDs: [id],
              successorIDs: [U.successor],
              stepOutAt: new Date(Date.now() + 60 * 60 * 1000),
            }),
          ),
        ).toBe("ok");
        expect(await guard.isDirectorOf(db, U.successor, 9001)).toBe(false);
        await setFlag("on");
        expect(await guard.isDirectorOf(db, U.successor, 9001)).toBe(true);
      });

      it("still refuses a holder whose row they assigned to themselves", async () => {
        const id = await makePosition("Self", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.holder, assignedBy: U.holder }],
        });
        expect(
          await errorOf(
            as(U.holder, JCRC).handOver({
              positionIDs: [id],
              successorIDs: [U.successor],
              stepOutAt: new Date(Date.now() + 60 * 60 * 1000),
            }),
          ),
        ).toBe("FORBIDDEN:SELF_ASSIGNED_POSITION");
      });
    });

    // ----------------------------------- #125: the escape routes of a handover
    describe("handover on a flagged position: one successor, no chains", () => {
      const HOUR = 60 * 60 * 1000;
      const handOver = (
        who: string,
        id: string,
        successors: string[],
        stepOutAt: Date = new Date(Date.now() + HOUR),
      ) =>
        as(who, JCRC).handOver({
          positionIDs: [id],
          successorIDs: successors,
          stepOutAt,
        });

      it("refuses more than one successor, and writes nothing", async () => {
        const id = await flagged();
        expect(
          await errorOf(handOver(U.holder, id, [U.successor, U.unplaced])),
        ).toBe("FORBIDDEN:ONE_SUCCESSOR_ONLY");
        expect(await holdersOf(id)).toEqual([U.holder]);
        const row = await db.userRole.findUnique({
          where: { userID: U.successor },
        });
        expect(row?.roles).toEqual(["resident"]);
      });

      it("still allows several successors on an unflagged position", async () => {
        const id = await unflagged();
        expect(
          await errorOf(handOver(U.holder, id, [U.successor, U.unplaced])),
        ).toBe("ok");
        expect(await holdersOf(id)).toEqual(
          [U.holder, U.successor, U.unplaced].sort(),
        );
      });

      it("marks the successor's row and refuses to hand it on until staff assign again", async () => {
        const id = await flagged();
        expect(await errorOf(handOver(U.holder, id, [U.successor]))).toBe("ok");
        const marked = await db.jcrcPositionHolder.findFirst({
          where: { positionID: id, userID: U.successor },
        });
        expect(marked?.handoverFrom).toBe(U.holder);

        // The chain: the successor hands it on at once.
        expect(await errorOf(handOver(U.successor, id, [U.unplaced]))).toBe(
          "FORBIDDEN:NEEDS_STAFF_CONFIRMATION",
        );
        expect(await holdersOf(id)).toEqual([U.holder, U.successor].sort());

        // An admin assigning the successor again confirms them.
        expect(
          await errorOf(
            as(U.admin, ADMIN).addHolder({ id, userID: U.successor }),
          ),
        ).toBe("ok");
        const confirmed = await db.jcrcPositionHolder.findFirst({
          where: { positionID: id, userID: U.successor },
        });
        expect(confirmed?.handoverFrom ?? null).toBeNull();
        expect(await errorOf(handOver(U.successor, id, [U.unplaced]))).toBe(
          "ok",
        );
      });

      it("refuses a second handover of the same row, and a cancelled or later step-out", async () => {
        const id = await flagged();
        expect(await errorOf(handOver(U.holder, id, [U.successor]))).toBe("ok");
        expect(await errorOf(handOver(U.holder, id, [U.unplaced]))).toBe(
          "FORBIDDEN:ALREADY_HANDED_OVER",
        );
        expect(
          await errorOf(as(U.holder, JCRC).setStepOut({ stepOutAt: null })),
        ).toBe("FORBIDDEN:STEP_OUT_LOCKED");
        expect(
          await errorOf(
            as(U.holder, JCRC).setStepOut({
              stepOutAt: new Date(Date.now() + 48 * HOUR),
            }),
          ),
        ).toBe("FORBIDDEN:STEP_OUT_LOCKED");
        // The outgoing holder is still on the way out.
        const outgoing = await db.jcrcPositionHolder.findFirst({
          where: { positionID: id, userID: U.holder },
        });
        expect(outgoing?.endsAt).not.toBeNull();
        // Moving the date earlier is allowed.
        expect(
          await errorOf(
            as(U.holder, JCRC).setStepOut({
              stepOutAt: new Date(Date.now() + HOUR / 2),
            }),
          ),
        ).toBe("ok");
      });

      it("refuses cancelling a step-out on an unflagged position too, with the plain message", async () => {
        // The base handover rule (only earlier, never cancelled) holds for every
        // position; the flagged one only differs in the refusal it names.
        const id = await unflagged();
        expect(await errorOf(handOver(U.holder, id, [U.successor]))).toBe("ok");
        expect(
          await errorOf(as(U.holder, JCRC).setStepOut({ stepOutAt: null })),
        ).toBe("FORBIDDEN:STEP_OUT_ONLY_EARLIER");
        expect(
          await errorOf(
            as(U.holder, JCRC).setStepOut({
              stepOutAt: new Date(Date.now() + 48 * HOUR),
            }),
          ),
        ).toBe("FORBIDDEN:STEP_OUT_ONLY_EARLIER");
        const row = await db.jcrcPositionHolder.findFirst({
          where: { positionID: id, userID: U.holder },
        });
        expect(row?.endsAt).not.toBeNull();
      });

      it("writes the same audit row as any holder added to a flagged position", async () => {
        const id = await flagged();
        expect(await errorOf(handOver(U.holder, id, [U.successor]))).toBe("ok");
        const added = (await positionAudit()).filter(
          (a) => a.action === "jcrcPosition.holder.add",
        );
        expect(added).toHaveLength(1);
        expect(added[0]?.actorUserID).toBe(U.holder);
        expect(added[0]?.targetUserID).toBe(U.successor);
        expect(added[0]?.reason).toContain(id);
      });

      it("refuses a successor who heads a CCA the position lists, and writes nothing", async () => {
        const id = await flagged();
        await db.ccaHead.create({ data: { userID: U.successor, ccaID: 9002 } });
        expect(await errorOf(handOver(U.holder, id, [U.successor]))).toBe(
          "FORBIDDEN:HEADS_LISTED_CCA",
        );
        expect(await holdersOf(id)).toEqual([U.holder]);
        const row = await db.userRole.findUnique({
          where: { userID: U.successor },
        });
        expect(row?.roles).toEqual(["resident"]);
        // Heading some other CCA does not matter.
        await db.ccaHead.deleteMany({ where: { userID: U.successor } });
        await db.ccaHead.create({ data: { userID: U.successor, ccaID: 9099 } });
        expect(await errorOf(handOver(U.holder, id, [U.successor]))).toBe("ok");
      });

      it("lets staff assign a CCA head to an unflagged position, and refuses on a flagged one", async () => {
        await db.ccaHead.create({ data: { userID: U.plain, ccaID: 9001 } });
        const open = await unflagged();
        expect(
          await errorOf(
            as(U.admin, ADMIN).addHolder({ id: open, userID: U.plain }),
          ),
        ).toBe("ok");
        const id = await flagged();
        expect(
          await errorOf(as(U.admin, ADMIN).addHolder({ id, userID: U.plain })),
        ).toBe("FORBIDDEN:HEADS_LISTED_CCA");
        expect(await holdersOf(id)).toEqual([U.holder]);
      });
    });

    // ------------------------ #125: taking jcrc away ends director positions
    describe("removing jcrc ends the person's rows on flagged positions", () => {
      it("ends the flagged row, keeps the unflagged one, and a later jcrc does not revive it", async () => {
        const { applyRoleChange } = await import("~/server/api/routers/admin");
        const hot = await flagged();
        const open = await unflagged();
        expect(await guard.isDirectorOf(db, U.holder, 9001)).toBe(true);

        await applyRoleChange({
          db,
          actorUserID: U.admin,
          actorRoles: ["admin"],
          targetUserID: U.holder,
          before: ["jcrc"],
          after: [],
          added: [],
          removed: ["jcrc"],
          reason: "test",
        });

        const flaggedRow = await db.jcrcPositionHolder.findFirst({
          where: { positionID: hot, userID: U.holder },
        });
        const openRow = await db.jcrcPositionHolder.findFirst({
          where: { positionID: open, userID: U.holder },
        });
        expect(flaggedRow?.endsAt).not.toBeNull();
        expect(flaggedRow!.endsAt!.getTime()).toBeLessThanOrEqual(Date.now());
        expect(openRow?.endsAt ?? null).toBeNull();

        // jcrc is granted again later: the old director row stays dead.
        await db.userRole.update({
          where: { userID: U.holder },
          data: { roles: ["resident", "jcrc"], role: "jcrc" },
        });
        expect(await guard.isDirectorOf(db, U.holder, 9001)).toBe(false);
      });
    });

    // ---------------------------------------------------------------- A36
    describe("A36: existing guards give the same answers with the flags set and unset", () => {
      it("assertHeadsCca and assertMayViewCcaRoster", async () => {
        const id = await makePosition("Sports", {
          ccaIDs: [9001],
          holders: [{ userID: U.holder }],
        });
        const people = [U.holder, U.unplaced, U.plain, U.resident, U.admin];
        const answers = async () => {
          const out: Record<string, string> = {};
          for (const userID of people) {
            const roles = await access.getUserRoles(db, userID);
            for (const ccaID of [9001, 9002]) {
              for (const [name, fn] of [
                ["heads", scope.assertHeadsCca],
                ["view", scope.assertMayViewCcaRoster],
              ] as const) {
                out[`${userID}/${ccaID}/${name}`] = await fn(
                  db,
                  { userID, roles },
                  ccaID,
                ).then(
                  (s) => s.via,
                  (e: Error) => `refused:${e.message}`,
                );
              }
            }
          }
          return out;
        };

        const before = await answers();
        await db.jcrcPosition.update({
          where: { id },
          data: { vetsProposals: true, handlesDisposables: true },
        });
        const after = await answers();

        expect(after).toEqual(before);
        // A jcrc member keeps every existing power over every CCA.
        expect(before[`${U.holder}/9002/heads`]).toBe("manageCcaHeads");
        expect(before[`${U.unplaced}/9001/heads`]).toBe("manageCcaHeads");
        expect(before[`${U.resident}/9001/heads`]).toMatch(/^refused/);
      });
    });
  },
);
