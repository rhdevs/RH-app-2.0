import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type * as GuardModule from "../directorGuard";
import type * as AccessModule from "../access";
import type * as PositionsModule from "../jcrcPositions";
import type * as HandoverModule from "../jcrcHandover";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of the strict director guard against the LOCAL development
 * database (skipped unless DATABASE_URL is the local dev database; run
 * `npm run test:db`). The tests own every row they touch: users E99903xx and
 * positions named "TEST ...", all removed before and after each test, and the
 * `directors.enabled` row is put back as it was. The seed's CCAs 9001 to 9014
 * are read, never written.
 */

const U = {
  director: "E9990301",
  other: "E9990302",
  third: "E9990303",
  successor: "E9990304",
  admin: "E9990305",
  unplaced: "E9990306",
  noJcrc: "E9990307",
};
const ALL_IDS = Object.values(U);
const FLAG = "directors.enabled";
const HOUR = 60 * 60 * 1000;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "director guard (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let guard: typeof GuardModule;
    let access: typeof AccessModule;
    let positions: typeof PositionsModule;
    let handover: typeof HandoverModule;
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

    type Holder = {
      userID: string;
      endsAt?: Date | null;
      assignedBy?: string;
    };
    const makePosition = async (
      name: string,
      opts: {
        vets?: boolean;
        social?: boolean;
        overseesAll?: boolean;
        ccaIDs?: number[];
        holders?: Holder[];
      } = {},
    ) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          overseesAll: opts.overseesAll ?? false,
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

    const director = (userID: string, ccaID: number) =>
      guard.isDirectorOf(db, userID, ccaID);

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      guard = await import("../directorGuard");
      access = await import("../access");
      positions = await import("../jcrcPositions");
      handover = await import("../jcrcHandover");
      originalFlag =
        (await db.systemFlag.findUnique({ where: { key: FLAG } }))?.value ??
        null;
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await setFlag("on");
      for (const id of [U.director, U.other, U.third, U.unplaced]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      await setRoles(U.successor, ["resident"]);
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.noJcrc, ["resident"]);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        await setFlag(originalFlag);
        await db.$disconnect();
      }
    });

    describe("who is a director", () => {
      it("is a current holder of a vetsProposals position that lists the CCA, and only for those CCAs", async () => {
        await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001, 9002],
          holders: [{ userID: U.director }],
        });
        expect(await director(U.director, 9001)).toBe(true);
        expect(await director(U.director, 9002)).toBe(true);
        expect(await director(U.director, 9003)).toBe(false);
        expect(await director(U.other, 9001)).toBe(false);
        // The list is the same set, and nothing else.
        expect(await guard.directedCcaIDs(db, U.director)).toEqual([
          9001, 9002,
        ]);
        expect(await guard.directedCcaIDs(db, U.other)).toEqual([]);
        await expect(
          guard.assertDirectorOf(db, U.director, 9003),
        ).rejects.toMatchObject({ message: "NOT_DIRECTOR" });
      });

      it("merges the CCAs of several flagged positions one person holds, without duplicates", async () => {
        await makePosition("A", {
          vets: true,
          ccaIDs: [9003, 9001],
          holders: [{ userID: U.director }],
        });
        await makePosition("B", {
          vets: true,
          ccaIDs: [9001, 9002],
          holders: [{ userID: U.director }],
        });
        await makePosition("C unflagged", {
          ccaIDs: [9004],
          holders: [{ userID: U.director }],
        });
        expect(await guard.directedCcaIDs(db, U.director)).toEqual([
          9001, 9002, 9003,
        ]);
      });

      it("is refused on an unflagged position, whether the field is missing or false", async () => {
        await makePosition("Missing", {
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        await makePosition("False", {
          vets: false,
          social: false,
          ccaIDs: [9002],
          holders: [{ userID: U.director }],
        });
        expect(await director(U.director, 9001)).toBe(false);
        expect(await director(U.director, 9002)).toBe(false);
      });

      it("reads the flag from the stored row at each call", async () => {
        const id = await makePosition("Toggle", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        expect(await director(U.director, 9001)).toBe(true);
        await db.jcrcPosition.update({
          where: { id },
          data: { vetsProposals: false },
        });
        expect(await director(U.director, 9001)).toBe(false);
        await db.jcrcPosition.update({
          where: { id },
          data: { vetsProposals: true },
        });
        expect(await director(U.director, 9001)).toBe(true);
      });

      it("gives an admin, a non-JCRC holder and a stored lookalike role nothing", async () => {
        await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.admin }, { userID: U.noJcrc }],
        });
        // An admin who is not also a director holder is refused too.
        await makePosition("Other", { vets: true, ccaIDs: [9002] });
        expect(await director(U.admin, 9001)).toBe(false);
        expect(await director(U.admin, 9002)).toBe(false);
        expect(await director(U.noJcrc, 9001)).toBe(false);
        // A stored string that is not a role grants nothing.
        await db.userRole.update({
          where: { userID: U.noJcrc },
          data: { roles: ["resident", "director", "cca_head"] },
        });
        expect(await director(U.noJcrc, 9001)).toBe(false);
      });
    });

    describe("directors.enabled", () => {
      it.each([["off"], [null], ["ON"], [""]] as const)(
        "grants nothing when the row is %j",
        async (value) => {
          await makePosition("Sports", {
            vets: true,
            social: true,
            ccaIDs: [9001],
            holders: [{ userID: U.director }],
          });
          expect(await director(U.director, 9001)).toBe(true);
          await setFlag(value);
          expect(await director(U.director, 9001)).toBe(false);
          expect(await guard.directedCcaIDs(db, U.director)).toEqual([]);
          expect(await guard.isSocialDirector(db, U.director)).toBe(false);
          expect(await guard.isDirectorsEnabled(db)).toBe(false);
        },
      );
    });

    describe("A18 and A48: rows are read on every call", () => {
      it("refuses at once when the holder row is removed", async () => {
        await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        expect(await director(U.director, 9001)).toBe(true);
        await db.jcrcPositionHolder.deleteMany({
          where: { userID: U.director },
        });
        expect(await director(U.director, 9001)).toBe(false);
      });

      it("refuses at once when jcrc is removed, with the holder row untouched, and restores when jcrc returns", async () => {
        await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        await db.userRole.update({
          where: { userID: U.director },
          data: { roles: ["resident"] },
        });
        expect(await director(U.director, 9001)).toBe(false);
        expect(
          await db.jcrcPositionHolder.count({ where: { userID: U.director } }),
        ).toBe(1);
        await db.userRole.update({
          where: { userID: U.director },
          data: { roles: ["resident", "jcrc"] },
        });
        expect(await director(U.director, 9001)).toBe(true);
      });

      it("reads a legacy singular role when the roles array is empty", async () => {
        await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        await db.userRole.update({
          where: { userID: U.director },
          data: { roles: [], role: "jcrc" },
        });
        expect(await director(U.director, 9001)).toBe(true);
      });

      it("refuses once the JcrcTerm has ended, before the sweep, with the holder row untouched", async () => {
        await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        await db.jcrcTerm.create({
          data: { userID: U.director, endsAt: new Date(Date.now() + HOUR) },
        });
        expect(await director(U.director, 9001)).toBe(true);
        await db.jcrcTerm.update({
          where: { userID: U.director },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        expect(await director(U.director, 9001)).toBe(false);
        expect(
          await db.jcrcPositionHolder.count({ where: { userID: U.director } }),
        ).toBe(1);
        // The same rule getUserRoles applies.
        expect(await access.getUserRoles(db, U.director)).not.toContain("jcrc");
        // A term that ends exactly now has ended: dropEndedJcrcRole uses <=.
        const edge = new Date();
        await db.jcrcTerm.update({
          where: { userID: U.director },
          data: { endsAt: edge },
        });
        expect(await guard.isDirectorOf(db, U.director, 9001, edge)).toBe(
          false,
        );
      });

      it("still refuses after the lazy sweep has removed the role and the ended row", async () => {
        await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001],
          holders: [
            { userID: U.director, endsAt: new Date(Date.now() - 1000) },
          ],
        });
        await db.jcrcTerm.create({
          data: { userID: U.director, endsAt: new Date(Date.now() - 1000) },
        });
        await handover.sweepEndedJcrcTerms(db, new Date());
        expect(
          (await db.userRole.findUnique({ where: { userID: U.director } }))
            ?.roles,
        ).not.toContain("jcrc");
        expect(await director(U.director, 9001)).toBe(false);
      });

      it("gives no power from a holder row past its end date even though jcrc survives", async () => {
        // X holds a flagged position and hands it over with a step-out date.
        const flagged = await makePosition("Sports", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        const other = await makePosition("Culture", { ccaIDs: [9002] });
        await as(U.director, ["resident", "jcrc"]).handOver({
          positionIDs: [flagged],
          successorIDs: [U.successor],
          stepOutAt: new Date(Date.now() + HOUR),
        });
        expect(await db.jcrcTerm.count({ where: { userID: U.director } })).toBe(
          1,
        );
        // Someone adds X to a different position: that deletes X's JcrcTerm.
        await as(U.admin, ["resident", "admin"]).addHolder({
          id: other,
          userID: U.director,
        });
        expect(await db.jcrcTerm.count({ where: { userID: U.director } })).toBe(
          0,
        );
        // Both still act during the overlap.
        expect(await director(U.director, 9001)).toBe(true);
        expect(await director(U.successor, 9001)).toBe(true);
        // Time passes: the step-out date arrives.
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.director, positionID: flagged },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        // jcrc survives, but the ended row gives no power.
        expect(await access.getUserRoles(db, U.director)).toContain("jcrc");
        expect(await director(U.director, 9001)).toBe(false);
        // The successor, who was handed the position, keeps it.
        expect(await director(U.successor, 9001)).toBe(true);
      });
    });

    describe("A64: overseesAll and an empty position list grant nothing", () => {
      it("refuses a President whose overseesAll position lists no CCA", async () => {
        await makePosition("President", {
          overseesAll: true,
          vets: true,
          holders: [{ userID: U.director }],
        });
        for (const ccaID of [9001, 9002, 9003, 9014]) {
          expect(await director(U.director, ccaID)).toBe(false);
        }
        expect(await guard.directedCcaIDs(db, U.director)).toEqual([]);
      });

      it("lets a flagged overseesAll position act only on the CCAs it lists", async () => {
        await makePosition("President", {
          overseesAll: true,
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        expect(await director(U.director, 9001)).toBe(true);
        expect(await director(U.director, 9002)).toBe(false);
      });

      it("refuses an unflagged overseesAll holder even though the view shows every CCA", async () => {
        await makePosition("President", {
          overseesAll: true,
          holders: [{ userID: U.director }],
        });
        expect(await positions.myPositionCcas(db, U.director)).toBe("all");
        expect(await director(U.director, 9001)).toBe(false);
      });

      it("refuses a JCRC member with no position, for whom myPositionCcas returns every CCA", async () => {
        expect(await positions.myPositionCcas(db, U.unplaced)).toBe("all");
        for (const ccaID of [9001, 9002, 9003]) {
          expect(await director(U.unplaced, ccaID)).toBe(false);
        }
      });

      it("lets either holder of two flagged positions over one CCA act, and refuses one on a CCA only the other lists", async () => {
        await makePosition("Sports Director (Internal)", {
          vets: true,
          ccaIDs: [9001, 9002],
          holders: [{ userID: U.director }],
        });
        await makePosition("Sports Director (External)", {
          vets: true,
          ccaIDs: [9001, 9003],
          holders: [{ userID: U.other }],
        });
        expect(await director(U.director, 9001)).toBe(true);
        expect(await director(U.other, 9001)).toBe(true);
        expect(await director(U.director, 9003)).toBe(false);
        expect(await director(U.other, 9002)).toBe(false);
      });
    });

    describe("the Social director", () => {
      it("is the current holder of the one handlesDisposables position, for every CCA", async () => {
        await makePosition("Social", {
          social: true,
          holders: [{ userID: U.director }],
        });
        expect(await guard.isSocialDirector(db, U.director)).toBe(true);
        expect(await guard.isSocialDirector(db, U.other)).toBe(false);
        await expect(
          guard.assertSocialDirector(db, U.other),
        ).rejects.toMatchObject({ message: "NOT_SOCIAL_DIRECTOR" });
      });

      it("is nobody when no position carries the flag", async () => {
        await makePosition("Plain", { holders: [{ userID: U.director }] });
        await makePosition("Vets only", {
          vets: true,
          ccaIDs: [9001],
          holders: [{ userID: U.other }],
        });
        expect(await guard.isSocialDirector(db, U.director)).toBe(false);
        // vetsProposals is not the Social director's flag, and the reverse.
        expect(await guard.isSocialDirector(db, U.other)).toBe(false);
      });

      it("is nobody when two positions carry the flag", async () => {
        await makePosition("Social A", {
          social: true,
          holders: [{ userID: U.director }],
        });
        await makePosition("Social B", {
          social: true,
          holders: [{ userID: U.other }],
        });
        expect(await guard.isSocialDirector(db, U.director)).toBe(false);
        expect(await guard.isSocialDirector(db, U.other)).toBe(false);
      });

      it("needs a live jcrc and an unended holder row", async () => {
        await makePosition("Social", {
          social: true,
          holders: [
            { userID: U.director },
            { userID: U.other, endsAt: new Date(Date.now() - 1000) },
            { userID: U.noJcrc },
          ],
        });
        expect(await guard.isSocialDirector(db, U.director)).toBe(true);
        expect(await guard.isSocialDirector(db, U.other)).toBe(false);
        expect(await guard.isSocialDirector(db, U.noJcrc)).toBe(false);
        await db.jcrcTerm.create({
          data: { userID: U.director, endsAt: new Date(Date.now() - 1000) },
        });
        expect(await guard.isSocialDirector(db, U.director)).toBe(false);
      });

      it("can sit on the same position as vetsProposals", async () => {
        await makePosition("Both", {
          vets: true,
          social: true,
          ccaIDs: [9001],
          holders: [{ userID: U.director }],
        });
        expect(await director(U.director, 9001)).toBe(true);
        expect(await guard.isSocialDirector(db, U.director)).toBe(true);
      });
    });

    describe("vacancy", () => {
      it("marks a flagged position with no holder, only ended rows, or holders without jcrc as vacant", async () => {
        const none = await makePosition("None", { vets: true });
        const ended = await makePosition("Ended", {
          vets: true,
          holders: [
            { userID: U.director, endsAt: new Date(Date.now() - 1000) },
          ],
        });
        const noJcrc = await makePosition("No jcrc", {
          vets: true,
          holders: [{ userID: U.noJcrc }],
        });
        const filled = await makePosition("Filled", {
          vets: true,
          holders: [{ userID: U.other }],
        });
        expect(await guard.isPositionVacant(db, none)).toBe(true);
        expect(await guard.isPositionVacant(db, ended)).toBe(true);
        expect(await guard.isPositionVacant(db, noJcrc)).toBe(true);
        expect(await guard.isPositionVacant(db, filled)).toBe(false);
        await db.jcrcTerm.create({
          data: { userID: U.other, endsAt: new Date(Date.now() - 1000) },
        });
        expect(await guard.isPositionVacant(db, filled)).toBe(true);
      });

      it("marks a CCA vacant only when every flagged position listing it is vacant", async () => {
        await makePosition("Empty", { vets: true, ccaIDs: [9001] });
        await makePosition("Filled", {
          vets: true,
          ccaIDs: [9001, 9002],
          holders: [{ userID: U.director }],
        });
        await makePosition("Unflagged", {
          ccaIDs: [9003],
          holders: [{ userID: U.other }],
        });
        expect(await guard.isCcaVacant(db, 9001)).toBe(false);
        expect(await guard.isCcaVacant(db, 9002)).toBe(false);
        // Only an unflagged position lists 9003, and nothing lists 9004.
        expect(await guard.isCcaVacant(db, 9003)).toBe(true);
        expect(await guard.isCcaVacant(db, 9004)).toBe(true);
      });
    });

    describe("a failed read never grants (real driver, one model at a time)", () => {
      const failing = (model: string) =>
        new Proxy(db, {
          get: (target, prop, receiver) => {
            if (prop === model) {
              return new Proxy(
                {},
                {
                  get: () => () => {
                    const err = new Error("boom: secret value");
                    err.name = "MongoNetworkError";
                    return Promise.reject(err);
                  },
                },
              );
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });

      it.each([
        "systemFlag",
        "userRole",
        "jcrcTerm",
        "jcrcPositionHolder",
        "jcrcPosition",
        "jcrcPositionCca",
      ])(
        "refuses a person who would otherwise pass when the %s read fails",
        async (model) => {
          await makePosition("Sports", {
            vets: true,
            ccaIDs: [9001],
            holders: [{ userID: U.director }],
          });
          const broken = failing(model) as unknown as PrismaClient;
          await expect(
            guard.assertDirectorOf(broken, U.director, 9001),
          ).rejects.toMatchObject({ message: "DIRECTOR_CHECK_FAILED" });
          // Sanity: the healthy client lets the same person through.
          await expect(
            guard.assertDirectorOf(db, U.director, 9001),
          ).resolves.toBeUndefined();
        },
      );
    });
  },
);
