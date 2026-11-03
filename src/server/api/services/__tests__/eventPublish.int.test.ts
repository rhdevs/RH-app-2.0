import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";
import { resetEventsFlagCache } from "../events";
import { resetEventReviewFlagCache } from "../eventPublish";

/**
 * INTEGRATION TESTS of direct publish, live edits, cancel reasons, draft
 * deletion and the JCRC all-events view, against the LOCAL development
 * database (skipped unless DATABASE_URL is the local dev database; run
 * `npm run test:db`).
 *
 * The tests own every row they touch: users E99920xx, events 99920xx, the
 * facility 99920 and its bookings, and the two events flags (whose previous
 * values are restored afterwards). The seed's CCA 9001 is read, never written.
 */

const USERS = {
  head: "E9992001",
  jcrc: "E9992002",
  resident: "E9992003",
  second: "E9992004",
  neverSignedIn: "E9992005",
};
const ALL_IDS = Object.values(USERS);
const FACILITY = 99920;
const OTHER_FACILITY = 99921;
const CCA = 9001;
const FLAGS = ["events.enabled", "events.review.required"];
// Inside Int32: Prisma's Int is 32-bit, and 2033 is far from any real booking.
const T = 2_000_000_000;
const HOUR = 3600;
let nextEventID = 9992001;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "Event direct publish (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let ipCounter = 0;
    let savedFlags: { key: string; value: string }[] = [];

    const caller = (userID: string, roles: string[]) =>
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
          "x-forwarded-for": `203.0.113.${(ipCounter += 1) % 250}`,
        }),
      });
    const as = (userID: string, roles: string[]) => caller(userID, roles).event;

    const HEAD = ["resident"];
    const JCRC = ["resident", "jcrc"];

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
      Array.from({ length: nextEventID - 9992001 }, (_, i) => 9992001 + i);

    const clean = async () => {
      const ids = eventIDs();
      await db.eventSignup.deleteMany({
        where: { OR: [{ eventID: { in: ids } }, { userID: { in: ALL_IDS } }] },
      });
      await db.eventQuestion.deleteMany({ where: { eventID: { in: ids } } });
      await db.event.deleteMany({
        where: {
          OR: [{ eventID: { in: ids } }, { createdBy: { in: ALL_IDS } }],
        },
      });
      await db.bookings.deleteMany({
        where: { facilityID: { in: [FACILITY, OTHER_FACILITY] } },
      });
      await db.ccaHead.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.userRole.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.roleAuditLog.deleteMany({
        where: { actorUserID: { in: ALL_IDS } },
      });
    };

    const setFlag = async (key: string, value: string) => {
      await db.systemFlag.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
      resetEventsFlagCache();
      resetEventReviewFlagCache();
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

    /** A complete event, ready to publish unless overridden. */
    const makeEvent = async (over: Record<string, unknown> = {}) => {
      const eventID = nextEventID++;
      await db.event.create({
        data: {
          eventID,
          ccaID: CCA,
          createdBy: USERS.head,
          title: "TEST event",
          description: "Internal description",
          startTime: T,
          endTime: T + 2 * HOUR,
          location: "Somewhere",
          facilityID: null,
          capacity: null,
          status: "draft",
          publicDescription: "Come along",
          bannerUrl: `https://example.public.blob.vercel-storage.com/event/${eventID}/banner-x.webp`,
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

    const signUp = (eventID: number, userID: string) =>
      db.eventSignup.create({ data: { eventID, userID } });

    const eventRow = (eventID: number) =>
      db.event.findUniqueOrThrow({ where: { eventID } });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      savedFlags = await db.systemFlag.findMany({
        where: { key: { in: FLAGS } },
        select: { key: true, value: true },
      });
      await db.facilities.deleteMany({
        where: { facilityID: { in: [FACILITY, OTHER_FACILITY] } },
      });
      await db.facilities.createMany({
        data: [
          {
            facilityID: FACILITY,
            facilityName: "TEST Room",
            facilityLocation: "Test block",
          },
          {
            facilityID: OTHER_FACILITY,
            facilityName: "TEST Other Room",
            facilityLocation: "Test block",
          },
        ],
      });
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await setFlag("events.enabled", "on");
      await setFlag("events.review.required", "off");
      await setRoles(USERS.head, HEAD);
      await setRoles(USERS.jcrc, JCRC);
      await setRoles(USERS.resident, ["resident"]);
      await setRoles(USERS.second, ["resident"]);
      await db.ccaHead.create({ data: { userID: USERS.head, ccaID: CCA } });
    });

    afterAll(async () => {
      if (!db) return;
      await clean();
      await db.facilities.deleteMany({
        where: { facilityID: { in: [FACILITY, OTHER_FACILITY] } },
      });
      await db.systemFlag.deleteMany({ where: { key: { in: FLAGS } } });
      for (const f of savedFlags) {
        await db.systemFlag.create({ data: f });
      }
      resetEventsFlagCache();
      resetEventReviewFlagCache();
      await db.$disconnect();
    });

    /* ---------------------------------------------------------------- */
    /* Publish                                                           */
    /* ---------------------------------------------------------------- */

    it("lets a head publish directly while review is off", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).publish({ eventID: id });
      const row = await eventRow(id);
      expect(row.status).toBe("published");
      expect(row.publishedAt).not.toBeNull();
      const audit = await db.roleAuditLog.findFirst({
        where: { actorUserID: USERS.head, action: "event.publish" },
      });
      expect(audit).not.toBeNull();
    });

    it("refuses publish while review is on, and submit while it is off", async () => {
      const id = await makeEvent();
      expect(
        await errorOf(as(USERS.head, HEAD).submitForReview({ eventID: id })),
      ).toBe("PRECONDITION_FAILED:REVIEW_OFF");
      await setFlag("events.review.required", "on");
      expect(await errorOf(as(USERS.head, HEAD).publish({ eventID: id }))).toBe(
        "PRECONDITION_FAILED:REVIEW_REQUIRED",
      );
    });

    it("refuses an incomplete event, naming what is missing", async () => {
      const id = await makeEvent({ bannerUrl: null, publicDescription: null });
      expect(await errorOf(as(USERS.head, HEAD).publish({ eventID: id }))).toBe(
        "BAD_REQUEST:INCOMPLETE:banner,publicDescription",
      );
      expect((await eventRow(id)).status).toBe("draft");
    });

    it("books the facility on publish and refuses a clash, writing nothing", async () => {
      const first = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
      });
      await as(USERS.head, HEAD).publish({ eventID: first });
      const booked = await eventRow(first);
      expect(booked.bookingID).not.toBeNull();

      const second = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
        title: "TEST overlapping",
        startTime: T + HOUR,
        endTime: T + 3 * HOUR,
      });
      const err = await errorOf(
        as(USERS.head, HEAD).publish({ eventID: second }),
      );
      expect(err).toMatch(/^CONFLICT:FACILITY_CLASH:/);
      expect(JSON.parse(err.slice("CONFLICT:FACILITY_CLASH:".length))).toEqual({
        eventName: "TEST event",
        startTime: T,
        endTime: T + 2 * HOUR,
      });
      const row = await eventRow(second);
      expect(row.status).toBe("draft");
      expect(row.bookingID).toBeNull();
      expect(await db.bookings.count({ where: { facilityID: FACILITY } })).toBe(
        1,
      );
    });

    it("keeps an event's room out of its author's personal bookings", async () => {
      const id = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
      });
      await as(USERS.head, HEAD).publish({ eventID: id });
      const mine = await caller(USERS.head, HEAD).bookings.getUserBookings();
      expect(mine.some((b) => b.facilityID === FACILITY)).toBe(false);
    });

    /* ---------------------------------------------------------------- */
    /* Live edits                                                        */
    /* ---------------------------------------------------------------- */

    it("moves the booking with a live time change and flags the change", async () => {
      const id = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
      });
      await as(USERS.head, HEAD).publish({ eventID: id });
      await as(USERS.head, HEAD).update({
        eventID: id,
        startTime: T + 5 * HOUR,
        endTime: T + 6 * HOUR,
      });
      const row = await eventRow(id);
      expect(row.startTime).toBe(T + 5 * HOUR);
      expect(row.scheduleChangedAt).not.toBeNull();
      const booking = await db.bookings.findFirstOrThrow({
        where: { bookingID: row.bookingID! },
      });
      expect([booking.startTime, booking.endTime]).toEqual([
        T + 5 * HOUR,
        T + 6 * HOUR,
      ]);
    });

    it("frees the room when a live event moves to a free-text place", async () => {
      const id = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
      });
      await as(USERS.head, HEAD).publish({ eventID: id });
      await as(USERS.head, HEAD).update({
        eventID: id,
        facilityID: null,
        location: "The lawn",
      });
      const row = await eventRow(id);
      expect(row.bookingID).toBeNull();
      expect(row.location).toBe("The lawn");
      expect(await db.bookings.count({ where: { facilityID: FACILITY } })).toBe(
        0,
      );
    });

    it("refuses a changed title on a live event but accepts the same one", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).publish({ eventID: id });
      expect(
        await errorOf(
          as(USERS.head, HEAD).update({ eventID: id, title: "Renamed" }),
        ),
      ).toBe("BAD_REQUEST:FIELD_LOCKED:title");
      expect(
        await errorOf(
          as(USERS.head, HEAD).update({
            eventID: id,
            title: "TEST event",
            capacity: 50,
          }),
        ),
      ).toBe("ok");
      expect((await eventRow(id)).capacity).toBe(50);
    });

    it("refuses a capacity below the signups already in", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).publish({ eventID: id });
      await signUp(id, USERS.resident);
      await signUp(id, USERS.second);
      expect(
        await errorOf(
          as(USERS.head, HEAD).update({ eventID: id, capacity: 1 }),
        ),
      ).toBe("BAD_REQUEST:CAPACITY_BELOW_SIGNUPS:2");
      expect(
        await errorOf(
          as(USERS.head, HEAD).update({ eventID: id, capacity: 2 }),
        ),
      ).toBe("ok");
    });

    it("keeps the old room when a move is refused for capacity", async () => {
      const id = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
      });
      await as(USERS.head, HEAD).publish({ eventID: id });
      await signUp(id, USERS.resident);
      await signUp(id, USERS.second);
      const before = await eventRow(id);

      expect(
        await errorOf(
          as(USERS.head, HEAD).update({
            eventID: id,
            facilityID: OTHER_FACILITY,
            capacity: 1,
          }),
        ),
      ).toBe("BAD_REQUEST:CAPACITY_BELOW_SIGNUPS:2");
      expect((await eventRow(id)).bookingID).toBe(before.bookingID);
      expect(await db.bookings.count({ where: { facilityID: FACILITY } })).toBe(
        1,
      );
      expect(
        await db.bookings.count({ where: { facilityID: OTHER_FACILITY } }),
      ).toBe(0);

      // A retry with a valid capacity moves cleanly, not into its own clash.
      await as(USERS.head, HEAD).update({
        eventID: id,
        facilityID: OTHER_FACILITY,
        capacity: 2,
      });
      const after = await eventRow(id);
      expect(after.facilityID).toBe(OTHER_FACILITY);
      expect(await db.bookings.count({ where: { facilityID: FACILITY } })).toBe(
        0,
      );
      expect(
        await db.bookings.count({ where: { facilityID: OTHER_FACILITY } }),
      ).toBe(1);
    });

    it("leaves the booking's time alone when a same-room edit is refused", async () => {
      const id = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
      });
      await as(USERS.head, HEAD).publish({ eventID: id });
      await signUp(id, USERS.resident);
      await signUp(id, USERS.second);
      await errorOf(
        as(USERS.head, HEAD).update({
          eventID: id,
          startTime: T + 5 * HOUR,
          endTime: T + 6 * HOUR,
          capacity: 1,
        }),
      );
      const booking = await db.bookings.findFirstOrThrow({
        where: { facilityID: FACILITY },
      });
      expect([booking.startTime, booking.endTime]).toEqual([T, T + 2 * HOUR]);
    });

    /* ---------------------------------------------------------------- */
    /* Cancel and delete                                                 */
    /* ---------------------------------------------------------------- */

    it("needs a reason to cancel a live event and shows it to signups", async () => {
      const id = await makeEvent({
        facilityID: FACILITY,
        location: "TEST Room",
      });
      await as(USERS.head, HEAD).publish({ eventID: id });
      await signUp(id, USERS.resident);

      expect(
        await errorOf(as(USERS.head, HEAD).cancelEvent({ eventID: id })),
      ).toBe("BAD_REQUEST:REASON_REQUIRED");
      await as(USERS.head, HEAD).cancelEvent({
        eventID: id,
        reason: "The venue flooded",
      });

      const row = await eventRow(id);
      expect(row.status).toBe("canceled");
      expect(row.decisionReason).toBe("The venue flooded");
      expect(await db.bookings.count({ where: { facilityID: FACILITY } })).toBe(
        0,
      );

      const mine = await as(USERS.resident, ["resident"]).listMySignups();
      const card = mine.events.find((e) => e.eventID === id);
      expect(card?.cancelReason).toBe("The venue flooded");
    });

    it("deletes a never-published draft and refuses anything else", async () => {
      const draft = await makeEvent();
      await as(USERS.head, HEAD).deleteDraft({ eventID: draft });
      expect(await db.event.count({ where: { eventID: draft } })).toBe(0);

      const live = await makeEvent();
      await as(USERS.head, HEAD).publish({ eventID: live });
      expect(
        await errorOf(as(USERS.head, HEAD).deleteDraft({ eventID: live })),
      ).toBe("PRECONDITION_FAILED:NOT_DELETABLE");

      const withdrawn = await makeEvent({ publishedAt: new Date() });
      expect(
        await errorOf(as(USERS.head, HEAD).deleteDraft({ eventID: withdrawn })),
      ).toBe("PRECONDITION_FAILED:NOT_DELETABLE");
    });

    it("refuses deletion by someone who does not head the CCA", async () => {
      const draft = await makeEvent();
      expect(
        await errorOf(
          as(USERS.resident, ["resident"]).deleteDraft({ eventID: draft }),
        ),
      ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
    });

    /* ---------------------------------------------------------------- */
    /* JCRC all-events view                                              */
    /* ---------------------------------------------------------------- */

    it("lists every CCA's events for the JCRC, with a New badge until opened", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).publish({ eventID: id });

      const before = await as(USERS.jcrc, JCRC).listAll({
        filter: "published",
      });
      expect(before.events.find((e) => e.eventID === id)?.isNew).toBe(true);

      // The author opening their own event does not clear it.
      await as(USERS.head, HEAD).getForOwner({ eventID: id });
      expect((await eventRow(id)).jcrcSeenAt).toBeNull();

      await as(USERS.jcrc, JCRC).getForOwner({ eventID: id });
      const after = await as(USERS.jcrc, JCRC).listAll({ filter: "published" });
      expect(after.events.find((e) => e.eventID === id)?.isNew).toBe(false);

      const drafts = await as(USERS.jcrc, JCRC).listAll({ filter: "draft" });
      expect(drafts.events.some((e) => e.eventID === id)).toBe(false);
    });

    it("files an ended event under past, not upcoming", async () => {
      const now = Math.floor(Date.now() / 1000);
      const id = await makeEvent({
        status: "published",
        publishedAt: new Date(),
        startTime: now - 3 * HOUR,
        endTime: now - HOUR,
      });
      const jcrc = as(USERS.jcrc, JCRC);
      expect(
        (await jcrc.listAll({ filter: "published" })).events.some(
          (e) => e.eventID === id,
        ),
      ).toBe(false);
      expect(
        (await jcrc.listAll({ filter: "past" })).events.some(
          (e) => e.eventID === id,
        ),
      ).toBe(true);
    });

    it("keeps the all-events view from CCA heads", async () => {
      expect(
        await errorOf(as(USERS.head, HEAD).listAll({ filter: "published" })),
      ).toMatch(/^FORBIDDEN:/);
    });

    /* ---------------------------------------------------------------- */
    /* Questions and hall scanners                                       */
    /* ---------------------------------------------------------------- */

    it("keeps questions editable on a live event until someone signs up", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).publish({ eventID: id });
      const head = as(USERS.head, HEAD);
      expect((await head.getQuestionsForOwner({ eventID: id })).frozen).toBe(
        false,
      );

      await setFlag("events.review.required", "on");
      expect((await head.getQuestionsForOwner({ eventID: id })).frozen).toBe(
        true,
      );

      await setFlag("events.review.required", "off");
      await signUp(id, USERS.resident);
      expect((await head.getQuestionsForOwner({ eventID: id })).frozen).toBe(
        true,
      );
    });

    it("lets any signed-in resident scan a hall event, and only them", async () => {
      const id = await makeEvent({ ccaID: null, createdBy: USERS.jcrc });
      const jcrc = as(USERS.jcrc, JCRC);
      expect(
        await errorOf(
          jcrc.saveScanners({
            eventID: id,
            scannerUserIDs: [USERS.neverSignedIn],
          }),
        ),
      ).toBe(`BAD_REQUEST:NOT_SIGNED_IN:${USERS.neverSignedIn}`);
      await jcrc.saveScanners({
        eventID: id,
        scannerUserIDs: [USERS.resident],
      });
      expect((await eventRow(id)).scannerUserIDs).toEqual([USERS.resident]);
    });
  },
);
