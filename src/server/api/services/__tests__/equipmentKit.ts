import type { PrismaClient } from "@prisma/client";

import type { createCaller as CreateCaller } from "~/server/api/root";

/**
 * Shared set-up for the equipment integration tests (equipment*.int.test.ts),
 * which run against the LOCAL development database only. Not a test file.
 *
 * The tests own every row they touch: users E99941xx, CCAs 9041 and 9042, events
 * 99941001 to 99941003, positions named "TEST ...", every item named "TEST ..."
 * and every loan for those events, and every `equipment.*` notice and
 * rate-limit row of those users. The flag rows are put back as they were.
 */

export const U = {
  headA: "E9994101", // heads CCA 9041
  headA2: "E9994102", // also heads CCA 9041
  headB: "E9994103", // heads CCA 9042
  social: "E9994104", // the Social director (jcrc, holds the flagged position)
  jcrc: "E9994105", // jcrc, no position
  director: "E9994106", // jcrc, a CCA director (vetsProposals only)
  admin: "E9994107",
  scrc: "E9994108",
  resident: "E9994109",
  outsider: "E9994110", // heads CCA 9042 only through a stale session claim
};
export const IDS = Object.values(U);
export const CCA_A = 9041;
export const CCA_B = 9042;
export const CCAS = [CCA_A, CCA_B];
export const EV = { a: 99941001, b: 99941002, hall: 99941003 };
export const EVENT_IDS = Object.values(EV);
export const FLAGS = [
  "equipment.enabled",
  "disposables.enabled",
  "directors.enabled",
  "notifications.enabled",
];
/** Session roles that claim every power: the server must not believe them. */
export const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];

export const HOUR = 3600;
export const DAY = 24 * HOUR;
export const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A window well in the future: hours `from` to `to` after a fixed base. */
export const BASE = nowSeconds() + 20 * DAY;
export const win = (from: number, to: number) => ({
  collectAt: BASE + from * HOUR,
  returnAt: BASE + to * HOUR,
});

export const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return `${e.code}:${e.message}`;
  }
  return "ok";
};

export type Kit = Awaited<ReturnType<typeof makeKit>>;

export async function makeKit() {
  const { db } = await import("~/server/db");
  const { createCaller } = (await import("~/server/api/root")) as {
    createCaller: typeof CreateCaller;
  };
  const { resetNotificationsFlagCache } = await import(
    "~/server/api/services/notifications"
  );
  const { resetDisposablesFlagCache } = await import(
    "~/server/api/services/disposables/flag"
  );
  const { resetEquipmentFlagCache } = await import(
    "~/server/api/services/equipment/flag"
  );
  const original: Record<string, string | null> = {};
  let ipCounter = 0;

  const as = (
    userID: string,
    roles: string[] = EVERYTHING,
    client: PrismaClient = db,
  ) =>
    createCaller({
      db: client as never,
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
        "x-forwarded-for": `198.51.100.${(ipCounter += 1)}`,
      }),
    }).equipment;

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
    resetNotificationsFlagCache();
    resetDisposablesFlagCache();
    resetEquipmentFlagCache();
  };

  const clean = async () => {
    await db.rateLimit.deleteMany({
      where: { key: { startsWith: "equipment." } },
    });
    await db.equipmentLoan.deleteMany({
      where: {
        OR: [{ eventID: { in: EVENT_IDS } }, { requestedBy: { in: IDS } }],
      },
    });
    await db.equipmentItem.deleteMany({
      where: { name: { startsWith: "TEST " } },
    });
    await db.event.deleteMany({
      where: { OR: [{ eventID: { in: EVENT_IDS } }, { ccaID: { in: CCAS } }] },
    });
    await db.ccaHead.deleteMany({ where: { userID: { in: IDS } } });
    const positions = await db.jcrcPosition.findMany({
      where: { name: { startsWith: "TEST " } },
      select: { id: true },
    });
    const pids = positions.map((p) => p.id);
    await db.jcrcPositionCca.deleteMany({
      where: { positionID: { in: pids } },
    });
    await db.jcrcPositionHolder.deleteMany({
      where: { OR: [{ positionID: { in: pids } }, { userID: { in: IDS } }] },
    });
    await db.jcrcPosition.deleteMany({ where: { id: { in: pids } } });
    await db.jcrcTerm.deleteMany({ where: { userID: { in: IDS } } });
    await db.userRole.deleteMany({ where: { userID: { in: IDS } } });
    await db.notification.deleteMany({ where: { userID: { in: IDS } } });
    await db.cCA.deleteMany({ where: { ccaID: { in: CCAS } } });
  };

  const setRoles = (userID: string, roles: string[]) =>
    db.userRole.create({
      data: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
    });

  const makePosition = async (
    name: string,
    holder: string,
    opts: { vets?: boolean; social?: boolean; ccaIDs?: number[] } = {},
  ) => {
    const p = await db.jcrcPosition.create({
      data: {
        name: `TEST ${name}`,
        createdBy: "test",
        vetsProposals: opts.vets ?? false,
        handlesDisposables: opts.social ?? false,
      },
    });
    for (const ccaID of opts.ccaIDs ?? []) {
      await db.jcrcPositionCca.create({
        data: { positionID: p.id, ccaID, addedBy: "test" },
      });
    }
    await db.jcrcPositionHolder.create({
      data: {
        positionID: p.id,
        userID: holder,
        assignedBy: U.admin,
        endsAt: null,
      },
    });
    return p.id;
  };

  /** An event the tests own, written directly (published, in a month). */
  const makeEvent = (
    eventID: number,
    ccaID: number | null,
    over: Record<string, unknown> = {},
  ) =>
    db.event.create({
      data: {
        eventID,
        ccaID,
        createdBy: U.headA,
        title: `TEST event ${eventID}`,
        startTime: nowSeconds() + 30 * DAY,
        endTime: nowSeconds() + 30 * DAY + 2 * HOUR,
        status: "published",
        updatedAt: new Date(),
        ...over,
      },
    });

  /** An equipment item, written directly. */
  const makeItem = (name: string, quantity: number) =>
    db.equipmentItem.create({
      data: {
        name: `TEST ${name}`,
        note: "",
        quantity,
        retired: false,
        version: 0,
      },
    });

  /** A loan filed through the real procedure (headA, CCA A's event by default). */
  const file = async (
    lines: { itemID: string; quantity: number }[],
    window: { collectAt: number; returnAt: number },
    opts: { eventID?: number; by?: string } = {},
  ) =>
    as(opts.by ?? U.headA).create({
      eventID: opts.eventID ?? EV.a,
      lines,
      ...window,
    });

  const stored = (id: string) =>
    db.equipmentLoan.findUniqueOrThrow({ where: { id } });

  const noticesFor = (userID: string, kind?: string) =>
    db.notification.findMany({
      where: { userID, kind: kind ?? { startsWith: "equipment." } },
    });

  const begin = async () => {
    for (const key of FLAGS) {
      original[key] =
        (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
    }
  };

  /** Fresh rows and every flag on, before each test. */
  const reset = async () => {
    await clean();
    for (const key of FLAGS) await setFlag(key, "on");
    for (const id of [U.social, U.jcrc, U.director]) {
      await setRoles(id, ["resident", "jcrc"]);
    }
    for (const id of [U.headA, U.headA2, U.headB]) {
      await setRoles(id, ["resident", "cca_head"]);
    }
    await setRoles(U.admin, ["resident", "admin"]);
    await setRoles(U.scrc, ["resident", "scrc"]);
    await setRoles(U.resident, ["resident"]);
    await setRoles(U.outsider, ["resident"]);
    for (const [userID, ccaID] of [
      [U.headA, CCA_A],
      [U.headA2, CCA_A],
      [U.headB, CCA_B],
    ] as const) {
      await db.ccaHead.create({ data: { userID, ccaID } });
    }
    await db.cCA.createMany({
      data: CCAS.map((ccaID) => ({
        ccaID,
        ccaName: `Test CCA ${ccaID}`,
        category: "Test",
      })),
    });
    await makePosition("Social", U.social, { social: true });
    await makePosition("Director A", U.director, {
      vets: true,
      ccaIDs: [CCA_A],
    });
    await makeEvent(EV.a, CCA_A);
    await makeEvent(EV.b, CCA_B);
    await makeEvent(EV.hall, null);
  };

  const finish = async () => {
    await clean();
    for (const key of FLAGS) await setFlag(key, original[key] ?? null);
    await db.$disconnect();
  };

  return {
    db,
    as,
    setFlag,
    resetEquipmentFlagCache,
    clean,
    reset,
    begin,
    finish,
    setRoles,
    makePosition,
    makeEvent,
    makeItem,
    file,
    stored,
    noticesFor,
  };
}
