import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DATABASE-FREE (so CI runs it): the live permission guards, against a fake db
 * that holds roles, headships, year periods and unlocks. NOW is April 2027, so
 * the current academic year is AY2026/27.
 */
vi.stubEnv("SKIP_ENV_VALIDATION", "1");

const { requireManager, requireJcrcSelf, requireCcaAccess } = await import(
  "../manageAccess"
);
const { assertCanEditCcaYear } = await import("../editRights");
const { assertCanEditForResidents } = await import("../residentRecords");

const THIS_YEAR = "AY2026/27";
const LAST_YEAR = "AY2025/26";
const NEXT_YEAR = "AY2027/28";

interface World {
  roles?: Record<string, string[]>;
  heads?: Array<{ userID: string; ccaID: number }>;
  published?: string[];
  unlocked?: Array<{ userID: string; academicYear: string }>;
}

function fakeDb(w: World = {}) {
  return {
    userRole: {
      findUnique: async ({ where }: { where: { userID: string } }) => {
        const roles = w.roles?.[where.userID];
        return roles ? { userID: where.userID, roles } : null;
      },
    },
    ccaHead: {
      findUnique: async ({
        where,
      }: {
        where: { userID_ccaID: { userID: string; ccaID: number } };
      }) =>
        w.heads?.find(
          (h) =>
            h.userID === where.userID_ccaID.userID &&
            h.ccaID === where.userID_ccaID.ccaID,
        )
          ? { id: "h" }
          : null,
      count: async ({ where }: { where: { userID: string } }) =>
        w.heads?.filter((h) => h.userID === where.userID).length ?? 0,
    },
    transcriptPeriod: {
      findUnique: async ({ where }: { where: { academicYear: string } }) =>
        w.published?.includes(where.academicYear)
          ? { academicYear: where.academicYear, status: "published" }
          : null,
    },
    residentUnlock: {
      findMany: async ({
        where,
      }: {
        where: { academicYear: string; userID: { in: string[] } };
      }) =>
        (w.unlocked ?? []).filter(
          (u) =>
            u.academicYear === where.academicYear &&
            where.userID.in.includes(u.userID),
        ),
    },
  } as unknown as PrismaClient;
}

const message = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-04-15T04:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("requireManager / requireJcrcSelf", () => {
  const db = fakeDb({
    roles: {
      res: ["resident"],
      scrc: ["scrc"],
      admin: ["admin"],
      jcrc: ["jcrc"],
    },
  });

  it("refuses a plain resident and scrc, and lets admin and jcrc through", async () => {
    expect(await message(() => requireManager(db, "res"))).toBe(
      "INSUFFICIENT_ROLE",
    );
    expect(await message(() => requireManager(db, "scrc"))).toBe(
      "INSUFFICIENT_ROLE",
    );
    expect(await message(() => requireManager(db, "nobody"))).toBe(
      "INSUFFICIENT_ROLE",
    );
    expect(await message(() => requireManager(db, "admin"))).toBe("ok");
    expect(await message(() => requireManager(db, "jcrc"))).toBe("ok");
  });

  it("requires the jcrc role itself: an admin without it is refused", async () => {
    expect(await message(() => requireJcrcSelf(db, "admin"))).toBe(
      "JCRC_MEMBER_REQUIRED",
    );
    expect(await message(() => requireJcrcSelf(db, "res"))).toBe(
      "JCRC_MEMBER_REQUIRED",
    );
    expect(await message(() => requireJcrcSelf(db, "jcrc"))).toBe("ok");
  });
});

describe("requireCcaAccess", () => {
  const db = fakeDb({
    roles: {
      scrcOnly: ["scrc"],
      headA: ["cca_head", "resident"],
      admin: ["admin"],
    },
    heads: [{ userID: "headA", ccaID: 1 }],
  });

  it("refuses a user with only scrc", async () => {
    expect(await message(() => requireCcaAccess(db, "scrcOnly", 1))).toBe(
      "NOT_A_HEAD_OF_THIS_CCA",
    );
  });

  it("lets the head in for their own CCA only, whatever the role string says", async () => {
    expect(await message(() => requireCcaAccess(db, "headA", 1))).toBe("ok");
    expect(await message(() => requireCcaAccess(db, "headA", 2))).toBe(
      "NOT_A_HEAD_OF_THIS_CCA",
    );
  });

  it("lets a manager into any CCA", async () => {
    expect(await message(() => requireCcaAccess(db, "admin", 2))).toBe("ok");
  });
});

describe("assertCanEditCcaYear", () => {
  const db = fakeDb({
    roles: { headA: ["cca_head"], jcrc: ["jcrc"], other: ["resident"] },
    heads: [{ userID: "headA", ccaID: 1 }],
    published: ["AY2024/25"],
  });
  const edit = (user: string, ccaID: number, year: string) =>
    message(() => assertCanEditCcaYear(db, { userID: user }, ccaID, year));

  it("keeps a head to the current year", async () => {
    expect(await edit("headA", 1, THIS_YEAR)).toBe("ok");
    expect(await edit("headA", 1, LAST_YEAR)).toBe("NOT_THE_TERM_YEAR");
  });

  it("refuses everyone, a manager included, for a year that has not started", async () => {
    expect(await edit("jcrc", 1, NEXT_YEAR)).toBe("YEAR_NOT_STARTED");
    expect(await edit("headA", 1, NEXT_YEAR)).toBe("YEAR_NOT_STARTED");
  });

  it("lets a manager write an earlier year that is still collecting, and nobody write a published one", async () => {
    expect(await edit("jcrc", 2, LAST_YEAR)).toBe("ok");
    expect(await edit("jcrc", 1, "AY2024/25")).toBe("PERIOD_PUBLISHED");
  });

  it("refuses a non-head and the head of another CCA", async () => {
    expect(await edit("other", 1, THIS_YEAR)).toBe("NOT_A_HEAD_OF_THIS_CCA");
    expect(await edit("headA", 2, THIS_YEAR)).toBe("NOT_A_HEAD_OF_THIS_CCA");
  });
});

describe("assertCanEditForResidents in a published year", () => {
  const world = (unlocked: string[]) =>
    fakeDb({
      roles: { jcrc: ["jcrc"], headA: ["cca_head"] },
      heads: [{ userID: "headA", ccaID: 1 }],
      published: [THIS_YEAR],
      unlocked: unlocked.map((userID) => ({ userID, academicYear: THIS_YEAR })),
    });
  const scope = { academicYear: THIS_YEAR, affectedUserIDs: ["R1", "R2"] };

  it("is a correction when every affected resident is unlocked", async () => {
    const guard = await assertCanEditForResidents(
      world(["R1", "R2"]),
      { userID: "jcrc" },
      scope,
    );
    expect(guard.correction).toBe(true);
    expect([...guard.residents].sort()).toEqual(["R1", "R2"]);
  });

  it("throws ONLY_UNLOCKED_RESIDENTS when one resident is still locked", async () => {
    expect(
      await message(() =>
        assertCanEditForResidents(world(["R1"]), { userID: "jcrc" }, scope),
      ),
    ).toBe("ONLY_UNLOCKED_RESIDENTS");
  });

  it("never lets a head through, unlocked or not", async () => {
    expect(
      await message(() =>
        assertCanEditForResidents(
          world(["R1", "R2"]),
          { userID: "headA" },
          { ...scope, ccaID: 1 },
        ),
      ),
    ).toBe("PERIOD_PUBLISHED");
  });
});
