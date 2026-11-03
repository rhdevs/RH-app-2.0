import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";
import type * as AuxWrites from "../auxPoints/writes";
import type * as AuxTotals from "../auxPoints/totals";

/**
 * INTEGRATION TESTS of AUX: flagging events, JCRC's manual attendance edits,
 * record-only events, awards and the per-resident totals, against the LOCAL
 * development database (skipped unless DATABASE_URL is the local dev
 * database; run `npm run test:db`).
 *
 * The tests own every row they touch: users E99930xx with matrics A99930xxX,
 * events 99930xx, and AUX rows filed under those users or created by them.
 * The points year is read, never written: the tests use whatever year the
 * local database is on, and "AY2000/01" as a past year.
 */

const USERS = {
  jcrc: "E9993001",
  ann: "E9993002",
  ben: "E9993003",
  cat: "E9993004",
  dup1: "E9993005",
  dup2: "E9993006",
};
const ALL_IDS = Object.values(USERS);
const MATRIC = {
  ann: "A9993002X",
  ben: "A9993003X",
  shared: "A9993099X",
};
const CCA = 9001;
const PAST = "AY2000/01";
const T = 2_000_000_000;
let nextEventID = 9993001;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "AUX (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let w: typeof AuxWrites;
    let totals: typeof AuxTotals;
    let year: string;

    const actor = () => ({
      userID: USERS.jcrc,
      roles: ["resident", "jcrc"],
      now: new Date(),
    });

    const errorOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return `${e.code}:${e.message}`;
      }
      return "ok";
    };

    const eventIDs = () =>
      Array.from({ length: nextEventID - 9993001 }, (_, i) => 9993001 + i);

    const clean = async () => {
      const ids = eventIDs();
      await db.eventAttendance.deleteMany({
        where: { OR: [{ eventID: { in: ids } }, { userID: { in: ALL_IDS } }] },
      });
      await db.eventSignup.deleteMany({
        where: { OR: [{ eventID: { in: ids } }, { userID: { in: ALL_IDS } }] },
      });
      await db.event.deleteMany({ where: { eventID: { in: ids } } });
      await db.auxRecordAttendee.deleteMany({
        where: {
          OR: [{ userID: { in: ALL_IDS } }, { addedBy: { in: ALL_IDS } }],
        },
      });
      await db.auxRecord.deleteMany({
        where: { createdBy: { in: ALL_IDS } },
      });
      await db.auxAward.deleteMany({
        where: {
          OR: [{ userID: { in: ALL_IDS } }, { createdBy: { in: ALL_IDS } }],
        },
      });
      await db.roleAuditLog.deleteMany({
        where: { actorUserID: { in: ALL_IDS } },
      });
      await db.userMatric.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.user.deleteMany({ where: { userID: { in: ALL_IDS } } });
    };

    const makeEvent = async (over: Record<string, unknown> = {}) => {
      const eventID = nextEventID++;
      await db.event.create({
        data: {
          eventID,
          ccaID: CCA,
          createdBy: USERS.jcrc,
          title: `TEST AUX event ${eventID}`,
          description: "Internal description",
          startTime: T,
          endTime: T + 3600,
          location: "Somewhere",
          facilityID: null,
          capacity: null,
          status: "published",
          publicDescription: "Come along",
          photoUrls: [],
          scannerUserIDs: [],
          attendanceOpensAt: null,
          attendanceClosesAt: null,
          answersPurgedAt: null,
          createdAt: new Date(),
          ...over,
        },
      });
      return eventID;
    };

    const auditCount = (action: string) =>
      db.roleAuditLog.count({ where: { actorUserID: USERS.jcrc, action } });

    const totalOf = async (userID: string) =>
      (await totals.auxTotals(db, year)).find((t) => t.userID === userID);

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      w = await import("../auxPoints/writes");
      totals = await import("../auxPoints/totals");
      const { readAuxYear } = await import("../auxPoints/year");
      year = await readAuxYear(db, new Date());
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await db.user.createMany({
        data: ALL_IDS.map((userID, i) => ({
          email: `${userID.toLowerCase()}@u.nus.edu`,
          passwordHash: "not-a-real-hash",
          userID,
          displayName: `TEST Aux ${i + 1}`,
        })),
      });
      await db.userMatric.createMany({
        data: [
          { userID: USERS.ann, matric: MATRIC.ann },
          { userID: USERS.ben, matric: MATRIC.ben },
          { userID: USERS.dup1, matric: MATRIC.shared },
          { userID: USERS.dup2, matric: MATRIC.shared },
        ],
      });
    });

    afterAll(async () => {
      if (!db) return;
      await clean();
      await db.$disconnect();
    });

    /* ---------------------------------------------------------- events */

    it("flags an event for the current year once, and unflags it", async () => {
      const id = await makeEvent();
      await expect(w.setEventAux(db, actor(), id, true)).resolves.toEqual({
        auxYear: year,
      });
      await w.setEventAux(db, actor(), id, true);
      const row = await db.event.findUniqueOrThrow({ where: { eventID: id } });
      expect(row.auxYear).toBe(year);
      expect(row.auxSetBy).toBe(USERS.jcrc);
      expect(await auditCount("aux.event.flag")).toBe(1);

      await w.setEventAux(db, actor(), id, false);
      const off = await db.event.findUniqueOrThrow({ where: { eventID: id } });
      expect(off.auxYear).toBeNull();
      expect(await auditCount("aux.event.unflag")).toBe(1);
    });

    it("refuses to flag a cancelled event", async () => {
      const id = await makeEvent({ status: "canceled" });
      expect(await errorOf(w.setEventAux(db, actor(), id, true))).toBe(
        "PRECONDITION_FAILED:AUX_EVENT_CLOSED",
      );
    });

    it("leaves a past year's AUX event alone", async () => {
      const id = await makeEvent({ auxYear: PAST });
      expect(await errorOf(w.setEventAux(db, actor(), id, false))).toBe(
        "PRECONDITION_FAILED:AUX_YEAR_READ_ONLY",
      );
      expect(
        await errorOf(w.addEventAttendees(db, actor(), id, MATRIC.ann)),
      ).toBe("PRECONDITION_FAILED:AUX_YEAR_READ_ONLY");
    });

    it("moves an event flagged for an earlier year but held in this one", async () => {
      const { readAuxYearStartedAt } = await import("../auxPoints/year");
      const startedAt = await readAuxYearStartedAt(db);
      const later = await makeEvent({ auxYear: PAST });
      const moved = await errorOf(w.setEventAux(db, actor(), later, true));
      if (startedAt === null) {
        expect(moved).toBe("PRECONDITION_FAILED:AUX_YEAR_READ_ONLY");
      } else {
        expect(moved).toBe("ok");
        const row = await db.event.findUniqueOrThrow({
          where: { eventID: later },
        });
        expect(row.auxYear).toBe(year);
        expect(await auditCount("aux.event.flag")).toBe(1);
      }

      const earlier = await makeEvent({ auxYear: PAST, startTime: 1 });
      expect(await errorOf(w.setEventAux(db, actor(), earlier, true))).toBe(
        "PRECONDITION_FAILED:AUX_YEAR_READ_ONLY",
      );
      const kept = await db.event.findUniqueOrThrow({
        where: { eventID: earlier },
      });
      expect(kept.auxYear).toBe(PAST);
    });

    it("refuses attendance edits on an event that is not AUX", async () => {
      const id = await makeEvent();
      expect(
        await errorOf(w.addEventAttendees(db, actor(), id, MATRIC.ann)),
      ).toBe("PRECONDITION_FAILED:NOT_AN_AUX_EVENT");
    });

    it("adds pasted people as manual check-ins and lists the rest back", async () => {
      const id = await makeEvent();
      await w.setEventAux(db, actor(), id, true);
      await db.eventSignup.create({ data: { eventID: id, userID: USERS.ben } });
      const text = [
        "matric,name",
        MATRIC.ann,
        `${USERS.ben.toLowerCase()}@u.nus.edu`,
        MATRIC.shared,
        "A0000000Z",
        USERS.ann,
      ].join("\n");
      const result = await w.addEventAttendees(db, actor(), id, text);
      expect(result.added.map((a) => a.userID)).toEqual([USERS.ann, USERS.ben]);
      expect(result.unknown.map((u) => [u.raw, u.reason])).toEqual([
        [MATRIC.shared, "AMBIGUOUS"],
        ["A0000000Z", "NOT_FOUND"],
        [USERS.ann, "REPEATED"],
      ]);
      const rows = await db.eventAttendance.findMany({
        where: { eventID: id },
        orderBy: { userID: "asc" },
      });
      expect(
        rows.map((r) => [r.userID, r.method, r.checkedInBy, r.wasSignedUp]),
      ).toEqual([
        [USERS.ann, "manual", USERS.jcrc, false],
        [USERS.ben, "manual", USERS.jcrc, true],
      ]);

      const again = await w.addEventAttendees(db, actor(), id, MATRIC.ann);
      expect(again.added).toEqual([]);
      expect(again.already.map((a) => a.userID)).toEqual([USERS.ann]);
      expect(await auditCount("aux.attendee.add")).toBe(1);

      await w.removeEventAttendee(db, actor(), id, USERS.ann);
      expect(await db.eventAttendance.count({ where: { eventID: id } })).toBe(
        1,
      );
      expect(
        await errorOf(w.removeEventAttendee(db, actor(), id, USERS.ann)),
      ).toBe("NOT_FOUND:ATTENDEE_NOT_FOUND");
    });

    /* --------------------------------------------------------- records */

    it("creates, edits and deletes a record-only event with its list", async () => {
      const made = await w.createRecord(db, actor(), {
        title: "TEST Block clean-up",
        heldOn: "2026-09-12",
        text: `${MATRIC.ann}\nnobody@example.com`,
      });
      expect(made.added.map((a) => a.userID)).toEqual([USERS.ann]);
      expect(made.unknown.map((u) => u.reason)).toEqual(["NOT_FOUND"]);

      const more = await w.addRecordAttendees(
        db,
        actor(),
        made.id,
        `${MATRIC.ann}\n${MATRIC.ben}`,
      );
      expect(more.added.map((a) => a.userID)).toEqual([USERS.ben]);
      expect(more.already.map((a) => a.userID)).toEqual([USERS.ann]);

      await w.updateRecord(db, actor(), {
        id: made.id,
        title: "TEST Block clean-up (renamed)",
        heldOn: "2026-09-13",
      });
      const record = await db.auxRecord.findUniqueOrThrow({
        where: { id: made.id },
      });
      expect(record.title).toBe("TEST Block clean-up (renamed)");
      expect(record.academicYear).toBe(year);
      expect(record.updatedBy).toBe(USERS.jcrc);

      await w.removeRecordAttendee(db, actor(), made.id, USERS.ben);
      expect(
        await db.auxRecordAttendee.count({ where: { recordID: made.id } }),
      ).toBe(1);

      await w.deleteRecord(db, actor(), made.id);
      expect(await db.auxRecord.count({ where: { id: made.id } })).toBe(0);
      expect(
        await db.auxRecordAttendee.count({ where: { recordID: made.id } }),
      ).toBe(0);
      expect(await auditCount("aux.record.create")).toBe(1);
      expect(await auditCount("aux.record.edit")).toBe(1);
      expect(await auditCount("aux.record.delete")).toBe(1);
    });

    it("leaves a past year's record alone", async () => {
      const old = await db.auxRecord.create({
        data: {
          academicYear: PAST,
          title: "TEST old",
          heldOn: new Date("2000-09-01T00:00:00Z"),
          createdBy: USERS.jcrc,
        },
      });
      expect(await errorOf(w.deleteRecord(db, actor(), old.id))).toBe(
        "PRECONDITION_FAILED:AUX_YEAR_READ_ONLY",
      );
    });

    /* ---------------------------------------------------------- awards */

    it("creates, edits and deletes an award", async () => {
      const { id } = await w.createAward(db, actor(), {
        userID: MATRIC.ann,
        amount: 1,
        reason: "Fire warden (Sem 1)",
        awardedOn: "2026-10-01",
      });
      const award = await db.auxAward.findUniqueOrThrow({ where: { id } });
      expect([award.userID, award.amount, award.academicYear]).toEqual([
        USERS.ann,
        1,
        year,
      ]);

      await w.updateAward(db, actor(), {
        id,
        amount: 2,
        reason: "Fire warden (Sem 1)",
        awardedOn: "2026-10-02",
      });
      expect(
        (await db.auxAward.findUniqueOrThrow({ where: { id } })).amount,
      ).toBe(2);

      await w.deleteAward(db, actor(), id);
      expect(await db.auxAward.count({ where: { id } })).toBe(0);
      expect(await auditCount("aux.award.create")).toBe(1);
      expect(await auditCount("aux.award.edit")).toBe(1);
      expect(await auditCount("aux.award.delete")).toBe(1);
    });

    it("refuses an award for nobody, or of a bad amount", async () => {
      const award = { amount: 1, reason: "x", awardedOn: "2026-10-01" };
      expect(
        await errorOf(
          w.createAward(db, actor(), { ...award, userID: "A0000000Z" }),
        ),
      ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND");
      expect(
        await errorOf(
          w.createAward(db, actor(), {
            ...award,
            userID: MATRIC.ann,
            amount: 0,
          }),
        ),
      ).toBe("BAD_REQUEST:AUX_BAD_AMOUNT");
      expect(await db.auxAward.count({ where: { userID: USERS.ann } })).toBe(0);
    });

    it("imports carried-over totals and lists bad lines back", async () => {
      const result = await w.importAwards(db, actor(), {
        text: [
          "matric,aux",
          `${MATRIC.ann},3`,
          `${MATRIC.ben},x`,
          "A0000000Z,2",
        ].join("\n"),
        reason: "Carried over",
        awardedOn: "2026-08-15",
      });
      expect(result.added.map((a) => [a.userID, a.amount])).toEqual([
        [USERS.ann, 3],
      ]);
      expect(result.badAmount.map((b) => b.raw)).toEqual([MATRIC.ben]);
      expect(result.unknown.map((u) => u.raw)).toEqual(["A0000000Z"]);
      expect(await db.auxAward.count({ where: { userID: USERS.ann } })).toBe(1);
    });

    it("refuses the same award twice, and skips it on a second import", async () => {
      const award = {
        userID: MATRIC.ann,
        amount: 1,
        reason: "Fire warden (Sem 1)",
        awardedOn: "2026-10-01",
      };
      await w.createAward(db, actor(), award);
      expect(await errorOf(w.createAward(db, actor(), award))).toBe(
        "CONFLICT:AUX_AWARD_DUPLICATE",
      );
      await w.createAward(db, actor(), { ...award, awardedOn: "2027-02-01" });

      const paste = {
        text: `${MATRIC.ann},1
${MATRIC.ben},1`,
        reason: "Fire warden (Sem 1)",
        awardedOn: "2026-10-01",
      };
      const first = await w.importAwards(db, actor(), paste);
      expect(first.added.map((a) => a.userID)).toEqual([USERS.ben]);
      expect(first.already.map((a) => a.userID)).toEqual([USERS.ann]);
      const again = await w.importAwards(db, actor(), paste);
      expect(again.added).toEqual([]);
      expect(again.already.map((a) => a.userID).sort()).toEqual(
        [USERS.ann, USERS.ben].sort(),
      );
      expect(await db.auxAward.count({ where: { userID: USERS.ann } })).toBe(2);
      expect(await db.auxAward.count({ where: { userID: USERS.ben } })).toBe(1);
    });

    it("leaves a past year's award alone", async () => {
      const old = await db.auxAward.create({
        data: {
          academicYear: PAST,
          userID: USERS.ann,
          amount: 1,
          reason: "old",
          awardedOn: new Date("2000-09-01T00:00:00Z"),
          createdBy: USERS.jcrc,
        },
      });
      expect(await errorOf(w.deleteAward(db, actor(), old.id))).toBe(
        "PRECONDITION_FAILED:AUX_YEAR_READ_ONLY",
      );
    });

    /* ---------------------------------------------------------- totals */

    it("totals each source and explains where it came from", async () => {
      const id = await makeEvent();
      await w.setEventAux(db, actor(), id, true);
      await w.addEventAttendees(db, actor(), id, MATRIC.ann);
      await w.createRecord(db, actor(), {
        title: "TEST record",
        heldOn: "2026-09-12",
        text: MATRIC.ann,
      });
      await w.createAward(db, actor(), {
        userID: MATRIC.ann,
        amount: 2,
        reason: "Fire warden (Sem 1)",
        awardedOn: "2026-10-01",
      });
      // A past year's award never counts towards this year.
      await db.auxAward.create({
        data: {
          academicYear: PAST,
          userID: USERS.ann,
          amount: 5,
          reason: "old",
          awardedOn: new Date("2000-09-01T00:00:00Z"),
          createdBy: USERS.jcrc,
        },
      });

      expect(await totalOf(USERS.ann)).toMatchObject({
        fromEvents: 2,
        fromAwards: 2,
        total: 4,
        matric: MATRIC.ann,
        name: "TEST Aux 2",
      });
      expect(await totalOf(USERS.ben)).toBeUndefined();

      const detail = await totals.auxDetail(db, year, USERS.ann);
      expect(detail.events.map((e) => [e.eventID, e.method])).toEqual([
        [id, "manual"],
      ]);
      expect(detail.records.map((r) => r.title)).toEqual(["TEST record"]);
      expect(detail.awards.map((a) => [a.amount, a.reason])).toEqual([
        [2, "Fire warden (Sem 1)"],
      ]);

      // Unflagging the event takes its check-ins out of the total.
      await w.setEventAux(db, actor(), id, false);
      expect((await totalOf(USERS.ann))?.total).toBe(3);

      expect(await totals.auxYears(db, year)).toEqual(
        expect.arrayContaining([year, PAST]),
      );
    });
  },
);
