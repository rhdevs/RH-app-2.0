import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of JCRC positions and the self-handover against the LOCAL
 * development database (skipped unless DATABASE_URL is the local dev database;
 * run `npm run test:db`). The tests own every row they touch: users E99900xx
 * and positions named "TEST ...", all removed before and after each test. The
 * seed's CCAs 9001 to 9014 are read, never written.
 */

const USERS = {
  outgoing: "E9990001",
  successor: "E9990002",
  second: "E9990003",
  rf: "E9990004",
  neverSignedIn: "E9990005",
  admin: "E9990006",
};
const ALL_IDS = Object.values(USERS);
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "JCRC positions (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
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

    const clean = async () => {
      const positions = await db.jcrcPosition.findMany({
        where: { name: { startsWith: "TEST " } },
        select: { id: true },
      });
      const ids = positions.map((p) => p.id);
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
    const rolesOf = async (userID: string) =>
      (await db.userRole.findUnique({ where: { userID } }))?.roles ?? [];

    const JCRC = ["resident", "jcrc"];

    /** Runs `fn` with the Staff-page switch set, then puts it back. */
    const withScrc = async (value: "on" | "off", fn: () => Promise<void>) => {
      const { resetScrcFlagCache } = await import(
        "~/server/api/services/scrcFlag"
      );
      const key = "scrc.enabled";
      const before = await db.systemFlag.findUnique({ where: { key } });
      await db.systemFlag.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
      resetScrcFlagCache();
      try {
        await fn();
      } finally {
        if (before) {
          await db.systemFlag.update({
            where: { key },
            data: { value: before.value },
          });
        } else {
          await db.systemFlag.deleteMany({ where: { key } });
        }
        resetScrcFlagCache();
      }
    };

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await setRoles(USERS.outgoing, JCRC);
      await setRoles(USERS.successor, ["resident"]);
      await setRoles(USERS.second, ["resident"]);
      await setRoles(USERS.rf, ["resident", "scrc"]);
      await setRoles(USERS.admin, ["resident", "admin"]);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        await db.$disconnect();
      }
    });

    const makePosition = async (
      name: string,
      ccaIDs: number[],
      overseesAll = false,
    ) => {
      const me = as(USERS.outgoing, JCRC);
      const { id } = await me.create({ name: `TEST ${name}`, overseesAll });
      await me.setCcas({ id, ccaIDs });
      return id;
    };

    it("supports create, read, update and delete of a position", async () => {
      const me = as(USERS.outgoing, JCRC);
      const id = await makePosition("Sports Director (Internal)", [9001, 9002]);

      let list = await me.list();
      let found = list.find((p) => p.id === id)!;
      expect(found.ccas.map((c) => c.ccaID)).toEqual(
        expect.arrayContaining([9001, 9002]),
      );

      await me.update({ id, name: "TEST Sports Director (External)" });
      await me.setCcas({ id, ccaIDs: [9002, 9003] });
      list = await me.list();
      found = list.find((p) => p.id === id)!;
      expect(found.name).toBe("TEST Sports Director (External)");
      expect(found.ccas.map((c) => c.ccaID).sort()).toEqual([9002, 9003]);

      expect(
        await errorOf(me.create({ name: "TEST Sports Director (External)" })),
      ).toBe("CONFLICT:NAME_TAKEN");

      await me.delete({ id });
      expect((await me.list()).some((p) => p.id === id)).toBe(false);
    });

    it("refuses an unknown CCA and a holder who is not JCRC", async () => {
      const me = as(USERS.outgoing, JCRC);
      const id = await makePosition("Culture", [9001]);
      expect(await errorOf(me.setCcas({ id, ccaIDs: [123456] }))).toBe(
        "BAD_REQUEST:UNKNOWN_CCA",
      );
      expect(await errorOf(me.addHolder({ id, userID: USERS.successor }))).toBe(
        "BAD_REQUEST:TARGET_NOT_JCRC",
      );
    });

    it("scopes the My positions view: none or oversees-all means every CCA", async () => {
      const me = as(USERS.outgoing, JCRC);
      expect((await me.mine()).scope).toBe("all");

      const sports = await makePosition("Sports", [9002, 9001]);
      const culture = await makePosition("Culture", [9003, 9002]);
      await as(USERS.admin, ["resident", "admin"]).addHolder({
        id: sports,
        userID: USERS.outgoing,
      });
      await as(USERS.admin, ["resident", "admin"]).addHolder({
        id: culture,
        userID: USERS.outgoing,
      });
      expect((await me.mine()).scope).toEqual([9001, 9002, 9003]);

      const president = await makePosition("President", [], true);
      await as(USERS.admin, ["resident", "admin"]).addHolder({
        id: president,
        userID: USERS.outgoing,
      });
      expect((await me.mine()).scope).toBe("all");
    });

    it("refuses residents, and lets staff set holders but nothing else", async () => {
      expect(await errorOf(as(USERS.successor, ["resident"]).list())).toBe(
        "FORBIDDEN:INSUFFICIENT_ROLE",
      );
      const rf = as(USERS.rf, ["resident", "scrc"]);
      const id = await makePosition("Staff view", [9002]);
      await withScrc("off", async () => {
        expect(await errorOf(rf.list())).toBe("FORBIDDEN:SCRC_DISABLED");
        expect(
          await errorOf(rf.addHolder({ id, userID: USERS.outgoing })),
        ).toBe("FORBIDDEN:SCRC_DISABLED");
      });
      await withScrc("on", async () => {
        expect((await rf.list()).some((p) => p.id === id)).toBe(true);
        expect((await rf.jcrcMembers()).map((m) => m.userID)).toContain(
          USERS.outgoing,
        );
        await rf.addHolder({ id, userID: USERS.outgoing });
        await rf.removeHolder({ id, userID: USERS.outgoing });
        expect(await errorOf(rf.create({ name: "TEST nope" }))).toBe(
          "FORBIDDEN:INSUFFICIENT_ROLE",
        );
        expect(await errorOf(rf.mine())).toBe("FORBIDDEN:INSUFFICIENT_ROLE");
      });
    });

    it("lists current JCRC members as holder candidates, and nobody else", async () => {
      const members = await as(USERS.outgoing, JCRC).jcrcMembers();
      const ids = members.map((m) => m.userID);
      expect(ids).toContain(USERS.outgoing);
      expect(ids).not.toContain(USERS.successor);
      expect(ids).not.toContain(USERS.rf);
      expect(ids).not.toContain(USERS.admin);
    });

    describe("handover", () => {
      // Positions are assigned by someone else: a member can't assign
      // themselves, and a self-assigned row never qualifies for a handover.
      const assign = (id: string, userID: string) =>
        as(USERS.admin, ["resident", "admin"]).addHolder({ id, userID });

      it("gives successors jcrc and the position now, and ends the outgoing term later", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("Welfare", [9004]);
        await assign(id, USERS.outgoing);
        expect((await me.mine()).positions[0]?.canHandOver).toBe(true);

        const stepOutAt = new Date(Date.now() + 7 * DAY);
        const result = await me.handOver({
          positionIDs: [id],
          successorIDs: [USERS.successor, USERS.second],
          stepOutAt,
        });
        expect(result.granted.sort()).toEqual([USERS.successor, USERS.second]);
        expect(result.termEndsAt?.getTime()).toBe(stepOutAt.getTime());

        expect(await rolesOf(USERS.successor)).toContain("jcrc");
        expect(await rolesOf(USERS.second)).toContain("jcrc");
        // Overlap: the outgoing member still holds jcrc and the position.
        expect(await rolesOf(USERS.outgoing)).toContain("jcrc");
        const holders = (await me.list()).find((p) => p.id === id)!.holders;
        expect(holders.map((h) => h.userID).sort()).toEqual(
          [USERS.outgoing, USERS.successor, USERS.second].sort(),
        );

        const audit = await db.roleAuditLog.count({
          where: { action: "jcrc.handover", actorUserID: USERS.outgoing },
        });
        expect(audit).toBe(2);
      });

      it("drops jcrc live once the step-out date passes, then sweeps it from storage", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("Media", [9005]);
        await assign(id, USERS.outgoing);
        await me.handOver({
          positionIDs: [id],
          successorIDs: [USERS.successor],
          stepOutAt: new Date(Date.now() + DAY),
        });

        // Move the term into the past without sweeping.
        const past = new Date(Date.now() - 1000);
        await db.jcrcTerm.update({
          where: { userID: USERS.outgoing },
          data: { endsAt: past },
        });
        await db.jcrcPositionHolder.updateMany({
          where: { userID: USERS.outgoing },
          data: { endsAt: past },
        });
        const { getUserRoles } = await import("~/server/api/services/access");
        expect(await getUserRoles(db, USERS.outgoing)).not.toContain("jcrc");
        expect(await rolesOf(USERS.outgoing)).toContain("jcrc");

        // Any positions read runs the sweep.
        await as(USERS.successor, JCRC).list();
        expect(await rolesOf(USERS.outgoing)).not.toContain("jcrc");
        expect(await rolesOf(USERS.outgoing)).toContain("resident");
        expect(
          await db.jcrcTerm.findUnique({ where: { userID: USERS.outgoing } }),
        ).toBeNull();
      });

      it("ends the term immediately for a step-out of now", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("Finance", [9006]);
        await assign(id, USERS.outgoing);
        await me.handOver({
          positionIDs: [id],
          successorIDs: [USERS.successor],
          stepOutAt: new Date(Date.now() - 60_000),
        });
        expect(await rolesOf(USERS.outgoing)).not.toContain("jcrc");
        expect(await rolesOf(USERS.successor)).toContain("jcrc");
      });

      it("keeps jcrc while the outgoing member still holds another position", async () => {
        const me = as(USERS.outgoing, JCRC);
        const a = await makePosition("Social", [9007]);
        const b = await makePosition("Hon Gen Sec", [9008]);
        await assign(a, USERS.outgoing);
        await assign(b, USERS.outgoing);
        const result = await me.handOver({
          positionIDs: [a],
          successorIDs: [USERS.successor],
          stepOutAt: new Date(Date.now() - 60_000),
        });
        expect(result.termEndsAt).toBeNull();
        expect(await rolesOf(USERS.outgoing)).toContain("jcrc");
        const mine = await me.mine();
        expect(mine.positions.map((p) => p.id)).toEqual([b]);
      });

      it("only brings a pending step-out forward, never cancels or delays it", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("VP Internal", [9009]);
        await assign(id, USERS.outgoing);
        await me.handOver({
          positionIDs: [id],
          successorIDs: [USERS.successor],
          stepOutAt: new Date(Date.now() + 3 * DAY),
        });
        expect(
          await errorOf(
            me.setStepOut({ stepOutAt: new Date(Date.now() + 5 * DAY) }),
          ),
        ).toBe("FORBIDDEN:STEP_OUT_ONLY_EARLIER");

        const sooner = new Date(Date.now() + DAY);
        expect((await me.setStepOut({ stepOutAt: sooner })).termEndsAt).toEqual(
          sooner,
        );
        expect(
          (await db.jcrcTerm.findUnique({ where: { userID: USERS.outgoing } }))
            ?.endsAt,
        ).toEqual(sooner);

        await me.setStepOut({ stepOutAt: new Date(Date.now() - 60_000) });
        expect(await rolesOf(USERS.outgoing)).not.toContain("jcrc");
        expect(await errorOf(me.setStepOut({ stepOutAt: new Date() }))).toMatch(
          /NO_STEP_OUT_PENDING|NOT_JCRC|UNAUTHORIZED|FORBIDDEN/,
        );
      });

      it("refuses a successor who never signed in, writing nothing", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("VP External", [9010]);
        await assign(id, USERS.outgoing);
        expect(
          await errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.successor, USERS.neverSignedIn],
              stepOutAt: new Date(Date.now() + DAY),
            }),
          ),
        ).toBe("FORBIDDEN:SUCCESSOR_NOT_SIGNED_IN");
        expect(await rolesOf(USERS.successor)).not.toContain("jcrc");
        expect(
          await db.pendingRoleGrant.findUnique({
            where: { userID: USERS.neverSignedIn },
          }),
        ).toBeNull();
      });

      it("cannot be used to mint jcrc: no self-assignment, one handover per assignment", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("Sports", [9012]);
        expect(
          await errorOf(me.addHolder({ id, userID: USERS.outgoing })),
        ).toBe("FORBIDDEN:SELF_ASSIGN");

        // A row the caller assigned themselves (only an admin can) never hands over.
        await db.jcrcPositionHolder.create({
          data: {
            positionID: id,
            userID: USERS.outgoing,
            assignedBy: USERS.outgoing,
          },
        });
        const step = new Date(Date.now() + DAY);
        expect(
          await errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.successor],
              stepOutAt: step,
            }),
          ),
        ).toBe("FORBIDDEN:SELF_ASSIGNED_POSITION");

        // Assigned by someone else: one handover only.
        await assign(id, USERS.outgoing);
        await me.handOver({
          positionIDs: [id],
          successorIDs: [USERS.successor],
          stepOutAt: step,
        });
        expect(
          await errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.second],
              stepOutAt: step,
            }),
          ),
        ).toBe("FORBIDDEN:ALREADY_HANDED_OVER");
        expect(await rolesOf(USERS.second)).not.toContain("jcrc");

        // The successor's row came from the handover, not from staff, so
        // they cannot pass it straight on.
        const successor = as(USERS.successor, JCRC);
        expect(
          await errorOf(
            successor.handOver({
              positionIDs: [id],
              successorIDs: [USERS.second],
              stepOutAt: step,
            }),
          ),
        ).toBe("FORBIDDEN:POSITION_NOT_STAFF_ASSIGNED");
        expect(await rolesOf(USERS.second)).not.toContain("jcrc");

        // Once an RF assigns it to them, they can.
        await withScrc("on", async () => {
          await as(USERS.rf, ["resident", "scrc"]).addHolder({
            id,
            userID: USERS.successor,
          });
        });
        const next = await successor.handOver({
          positionIDs: [id],
          successorIDs: [USERS.second],
          stepOutAt: step,
        });
        expect(next.granted).toEqual([USERS.second]);
      });

      it("refuses a row another JCRC member assigned", async () => {
        const id = await makePosition("Block Comm", [9014]);
        await db.userRole.update({
          where: { userID: USERS.second },
          data: { roles: JCRC },
        });
        await as(USERS.second, JCRC).addHolder({ id, userID: USERS.outgoing });
        expect(
          await errorOf(
            as(USERS.outgoing, JCRC).handOver({
              positionIDs: [id],
              successorIDs: [USERS.successor],
              stepOutAt: new Date(Date.now() + DAY),
            }),
          ),
        ).toBe("FORBIDDEN:POSITION_NOT_STAFF_ASSIGNED");
        // The page hides it from the handover list for the same reason.
        const mine = await as(USERS.outgoing, JCRC).mine();
        expect(mine.positions.find((p) => p.id === id)?.canHandOver).toBe(
          false,
        );
        expect(await rolesOf(USERS.successor)).not.toContain("jcrc");
      });

      it("lets only one of two concurrent handovers of a row through", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("Concurrent", [9003]);
        await assign(id, USERS.outgoing);
        const step = new Date(Date.now() + DAY);
        const results = await Promise.all([
          errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.successor],
              stepOutAt: step,
            }),
          ),
          errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.second],
              stepOutAt: step,
            }),
          ),
        ]);
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results).toContain("FORBIDDEN:ALREADY_HANDED_OVER");
        const granted = [
          (await rolesOf(USERS.successor)).includes("jcrc"),
          (await rolesOf(USERS.second)).includes("jcrc"),
        ];
        expect(granted.filter(Boolean)).toHaveLength(1);
      });

      it("keeps two handovers in the same millisecond from releasing each other's claim", async () => {
        const { handOverPositions } = await import(
          "~/server/api/services/jcrcHandover"
        );
        const id = await makePosition("Same instant", [9003]);
        await assign(id, USERS.outgoing);
        const now = new Date();
        const stepOutAt = new Date(now.getTime() + DAY);
        const results = await Promise.allSettled([
          handOverPositions(
            db,
            {
              actorUserID: USERS.outgoing,
              positionIDs: [id],
              successorIDs: [USERS.successor],
              stepOutAt,
            },
            now,
          ),
          handOverPositions(
            db,
            {
              actorUserID: USERS.outgoing,
              positionIDs: [id],
              successorIDs: [USERS.second],
              stepOutAt,
            },
            now,
          ),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
          1,
        );
        // The winner's claim stands, so the outgoing member still steps out.
        const row = await db.jcrcPositionHolder.findFirstOrThrow({
          where: { positionID: id, userID: USERS.outgoing },
        });
        expect(row.handedOverAt?.getTime()).toBe(now.getTime());
        expect(row.endsAt?.getTime()).toBe(stepOutAt.getTime());
        expect(
          (await db.jcrcTerm.findUnique({ where: { userID: USERS.outgoing } }))
            ?.endsAt.getTime(),
        ).toBe(stepOutAt.getTime());
      });

      it("releases the claim if the step-out can't be recorded, so a retry works", async () => {
        const { handOverPositions } = await import(
          "~/server/api/services/jcrcHandover"
        );
        const id = await makePosition("Retry", [9006]);
        await assign(id, USERS.outgoing);
        const input = {
          actorUserID: USERS.outgoing,
          positionIDs: [id],
          successorIDs: [USERS.successor],
          stepOutAt: new Date(Date.now() + DAY),
        };
        const failingTerm = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop !== "jcrcTerm") return Reflect.get(target, prop, receiver);
            return {
              ...target.jcrcTerm,
              upsert: () => Promise.reject(new Error("write failed")),
            };
          },
        });
        await expect(handOverPositions(failingTerm, input)).rejects.toThrow(
          "write failed",
        );
        const row = await db.jcrcPositionHolder.findFirstOrThrow({
          where: { positionID: id, userID: USERS.outgoing },
        });
        expect([row.handedOverAt, row.endsAt]).toEqual([null, null]);

        const retried = await handOverPositions(db, input);
        expect(retried.termEndsAt?.getTime()).toBe(input.stepOutAt.getTime());
      });

      it("still ends jcrc when a sweep runs in the middle of a step-out of now", async () => {
        const { handOverPositions, sweepEndedJcrcTerms } = await import(
          "~/server/api/services/jcrcHandover"
        );
        const id = await makePosition("Mid-sweep", [9010]);
        await assign(id, USERS.outgoing);
        const now = new Date();
        // A positions read elsewhere sweeps just as the successor is given
        // the position: the outgoing member's claimed rows are already gone.
        const sweepFirst = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop !== "jcrcPositionHolder") {
              return Reflect.get(target, prop, receiver);
            }
            return new Proxy(target.jcrcPositionHolder, {
              get(holder, key, r) {
                if (key !== "upsert") return Reflect.get(holder, key, r);
                return async (args: never) => {
                  await sweepEndedJcrcTerms(db, now);
                  return holder.upsert(args);
                };
              },
            });
          },
        });
        await handOverPositions(
          sweepFirst,
          {
            actorUserID: USERS.outgoing,
            positionIDs: [id],
            successorIDs: [USERS.successor],
            stepOutAt: now,
          },
          now,
        );
        await sweepEndedJcrcTerms(db, new Date(now.getTime() + 1));
        expect(await rolesOf(USERS.outgoing)).not.toContain("jcrc");
        expect(await rolesOf(USERS.successor)).toContain("jcrc");
      });

      it("releases rows already claimed when a later claim write fails", async () => {
        const { handOverPositions } = await import(
          "~/server/api/services/jcrcHandover"
        );
        const first = await makePosition("Claim one", [9011]);
        const second = await makePosition("Claim two", [9012]);
        await assign(first, USERS.outgoing);
        await assign(second, USERS.outgoing);
        let claimWrites = 0;
        const failSecondClaim = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop !== "jcrcPositionHolder") {
              return Reflect.get(target, prop, receiver);
            }
            return new Proxy(target.jcrcPositionHolder, {
              get(holder, key, r) {
                if (key !== "updateMany") return Reflect.get(holder, key, r);
                return (args: { data: { handedOverAt?: Date | null } }) => {
                  if (args.data.handedOverAt && ++claimWrites === 2) {
                    return Promise.reject(new Error("network"));
                  }
                  return holder.updateMany(args as never);
                };
              },
            });
          },
        });
        await expect(
          handOverPositions(failSecondClaim, {
            actorUserID: USERS.outgoing,
            positionIDs: [first, second],
            successorIDs: [USERS.successor],
            stepOutAt: new Date(Date.now() + DAY),
          }),
        ).rejects.toThrow("network");
        const rows = await db.jcrcPositionHolder.findMany({
          where: { userID: USERS.outgoing },
        });
        expect(rows.map((r) => [r.handedOverAt, r.endsAt])).toEqual([
          [null, null],
          [null, null],
        ]);
        expect(await rolesOf(USERS.successor)).not.toContain("jcrc");
      });

      it("keeps JCRC members from undoing a handover or changing staff-assigned rows", async () => {
        const id = await makePosition("Guarded", [9007]);
        const other = await makePosition("Other", [9008]);
        const free = await makePosition("Free", [9009]);
        await assign(id, USERS.outgoing);
        await as(USERS.outgoing, JCRC).handOver({
          positionIDs: [id],
          successorIDs: [USERS.successor],
          stepOutAt: new Date(Date.now() + 7 * DAY),
        });
        await db.userRole.update({
          where: { userID: USERS.second },
          data: { roles: JCRC },
        });
        const successor = as(USERS.successor, JCRC);

        // Re-adding the outgoing member, to the same position or another
        // one, would cancel their step-out and keep them on the JCRC.
        expect(
          await errorOf(successor.addHolder({ id, userID: USERS.outgoing })),
        ).toBe("FORBIDDEN:HOLDER_STEPPING_OUT");
        expect(
          await errorOf(
            successor.addHolder({ id: other, userID: USERS.outgoing }),
          ),
        ).toBe("FORBIDDEN:HOLDER_STEPPING_OUT");
        // Removing a staff-assigned row is staff's call too.
        expect(
          await errorOf(successor.removeHolder({ id, userID: USERS.outgoing })),
        ).toBe("FORBIDDEN:STAFF_ASSIGNED_ROW");
        expect(
          await db.jcrcTerm.findUnique({ where: { userID: USERS.outgoing } }),
        ).not.toBeNull();

        // Re-assigning a staff-assigned row would strip its handover right.
        await assign(free, USERS.second);
        expect(
          await errorOf(successor.addHolder({ id: free, userID: USERS.second })),
        ).toBe("FORBIDDEN:STAFF_ASSIGNED_ROW");

        // Rows the JCRC set up themselves stay theirs to change.
        await successor.addHolder({ id: other, userID: USERS.second });
        await successor.removeHolder({ id: other, userID: USERS.second });

        // Staff still can, which is how a mistaken handover is undone.
        await assign(other, USERS.outgoing);
        expect(
          await db.jcrcTerm.findUnique({ where: { userID: USERS.outgoing } }),
        ).toBeNull();
      });

      it("a re-assigned position clears a step-out left over from a handover", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("Arts", [9013]);
        await assign(id, USERS.outgoing);
        await me.handOver({
          positionIDs: [id],
          successorIDs: [USERS.successor],
          stepOutAt: new Date(Date.now() + DAY),
        });
        expect(
          await db.jcrcTerm.findUnique({ where: { userID: USERS.outgoing } }),
        ).not.toBeNull();
        await assign(id, USERS.outgoing);
        expect(
          await db.jcrcTerm.findUnique({ where: { userID: USERS.outgoing } }),
        ).toBeNull();
      });

      it("refuses positions the caller does not hold, staff successors and self", async () => {
        const me = as(USERS.outgoing, JCRC);
        const id = await makePosition("Culture", [9011]);
        const step = new Date(Date.now() + DAY);
        expect(
          await errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.successor],
              stepOutAt: step,
            }),
          ),
        ).toBe("FORBIDDEN:NOT_YOUR_POSITION");

        await assign(id, USERS.outgoing);
        expect(
          await errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.rf],
              stepOutAt: step,
            }),
          ),
        ).toBe("FORBIDDEN:SUCCESSOR_IS_STAFF");
        expect(
          await errorOf(
            me.handOver({
              positionIDs: [id],
              successorIDs: [USERS.outgoing],
              stepOutAt: step,
            }),
          ),
        ).toBe("FORBIDDEN:SUCCESSOR_IS_YOU");
        // Nothing was written by the refusals.
        expect(await rolesOf(USERS.rf)).not.toContain("jcrc");
      });

      it("refuses an admin who holds no jcrc", async () => {
        const adminCaller = as(USERS.admin, ["resident", "admin"]);
        const id = await makePosition("President", [], true);
        expect(
          await errorOf(
            adminCaller.handOver({
              positionIDs: [id],
              successorIDs: [USERS.successor],
              stepOutAt: new Date(Date.now() + DAY),
            }),
          ),
        ).toBe("FORBIDDEN:NOT_JCRC");
      });
    });
  },
);
