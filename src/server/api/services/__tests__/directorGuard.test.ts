import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { getUserRoles } from "../access";
import {
  assertDirectorOf,
  assertSocialDirector,
  directedCcaIDs,
  isCcaVacant,
  isDirectorOf,
  isDirectorsEnabled,
  isPositionVacant,
  isSocialDirector,
} from "../directorGuard";

/**
 * The strict guard against a scripted database. The real-database claims
 * (what it reads, and what the rows mean) live in directorGuard.int.test.ts;
 * this file proves that EACH read, taken on its own, refuses when it throws.
 *
 * The fake answers every read with a row that lets the person through, so the
 * only reason for a refusal is the read that was made to throw. Every method
 * that is not a read is recorded, and each test checks none was called.
 */

const READ_METHODS = new Set(["findUnique", "findFirst", "findMany", "count"]);
const SECRET = "mongodb://user:SECRET-PASSWORD@host/db";

type ModelName =
  | "systemFlag"
  | "userRole"
  | "jcrcTerm"
  | "jcrcPositionHolder"
  | "jcrcPosition"
  | "jcrcPositionCca";

type Script = Partial<Record<ModelName, unknown[]>>;

function scriptedDb(script: Script, failing?: ModelName) {
  const reads: string[] = [];
  const writes: string[] = [];
  const model = (name: ModelName) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          if (!READ_METHODS.has(method)) {
            writes.push(`${name}.${method}`);
            return undefined;
          }
          reads.push(`${name}.${method}`);
          if (name === failing) {
            const err = new Error(SECRET);
            err.name = "MongoServerError";
            throw err;
          }
          const rows = script[name] ?? [];
          if (method === "findMany") return rows;
          return rows[0] ?? null;
        },
      },
    );
  const names: ModelName[] = [
    "systemFlag",
    "userRole",
    "jcrcTerm",
    "jcrcPositionHolder",
    "jcrcPosition",
    "jcrcPositionCca",
  ];
  const db = Object.fromEntries(names.map((n) => [n, model(n)]));
  return { db: db as unknown as PrismaClient, reads, writes };
}

/** Every read answers "yes" for user E1 on CCA 9001. */
const ALLOWING: Script = {
  systemFlag: [{ key: "directors.enabled", value: "on" }],
  userRole: [{ userID: "E1", roles: ["resident", "jcrc"], role: null }],
  jcrcTerm: [],
  jcrcPositionHolder: [{ id: "h1", positionID: "p1", userID: "E1" }],
  jcrcPosition: [{ id: "p1" }],
  jcrcPositionCca: [{ id: "c1", positionID: "p1", ccaID: 9001 }],
};

const READS: ModelName[] = [
  "systemFlag",
  "userRole",
  "jcrcTerm",
  "jcrcPositionHolder",
  "jcrcPosition",
  "jcrcPositionCca",
];
/** The Social director's check makes no per-CCA read. */
const SOCIAL_READS = READS.filter((r) => r !== "jcrcPositionCca");

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorSpy.mockRestore());

const logged = () => errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));

describe("the scripted database lets the allowed person through", () => {
  it("director of the CCA", async () => {
    const { db, reads } = scriptedDb(ALLOWING);
    expect(await isDirectorOf(db, "E1", 9001)).toBe(true);
    // Every read the guard is documented to make really happened.
    expect(reads.map((r) => r.split(".")[0])).toEqual(
      expect.arrayContaining(READS),
    );
  });

  it("the Social director", async () => {
    const { db } = scriptedDb(ALLOWING);
    expect(await isSocialDirector(db, "E1")).toBe(true);
  });
});

describe("each read throwing refuses a director action", () => {
  it.each(READS)("isDirectorOf rejects when the %s read throws", async (m) => {
    const { db, writes } = scriptedDb(ALLOWING, m);
    await expect(isDirectorOf(db, "E1", 9001)).rejects.toMatchObject({
      name: "MongoServerError",
    });
    expect(writes).toEqual([]);
  });

  it.each(READS)(
    "assertDirectorOf refuses, writes nothing and logs only the name when the %s read throws",
    async (m) => {
      const { db, writes } = scriptedDb(ALLOWING, m);
      await expect(assertDirectorOf(db, "E1", 9001)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "DIRECTOR_CHECK_FAILED",
      });
      expect(writes).toEqual([]);
      const lines = logged();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("MongoServerError");
      expect(lines[0]).not.toContain("SECRET");
    },
  );

  it.each(READS)(
    "directedCcaIDs rejects when the %s read throws",
    async (m) => {
      const { db, writes } = scriptedDb(ALLOWING, m);
      await expect(directedCcaIDs(db, "E1")).rejects.toMatchObject({
        name: "MongoServerError",
      });
      expect(writes).toEqual([]);
    },
  );

  it.each(SOCIAL_READS)(
    "assertSocialDirector refuses, writes nothing and logs only the name when the %s read throws",
    async (m) => {
      const { db, writes } = scriptedDb(ALLOWING, m);
      await expect(assertSocialDirector(db, "E1")).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "DIRECTOR_CHECK_FAILED",
      });
      expect(writes).toEqual([]);
      const lines = logged();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("SECRET");
    },
  );

  it.each(SOCIAL_READS)(
    "isSocialDirector rejects when the %s read throws",
    async (m) => {
      const { db } = scriptedDb(ALLOWING, m);
      await expect(isSocialDirector(db, "E1")).rejects.toMatchObject({
        name: "MongoServerError",
      });
    },
  );

  it("the guard never turns a failed read into a grant", async () => {
    for (const m of READS) {
      const { db } = scriptedDb(ALLOWING, m);
      const result = await isDirectorOf(db, "E1", 9001).then(
        () => "answered",
        () => "threw",
      );
      expect(result, `${m} must not be swallowed`).toBe("threw");
    }
  });
});

describe("refusals that are not read failures", () => {
  it("assertDirectorOf says NOT_DIRECTOR when the answer is no", async () => {
    const { db } = scriptedDb({ ...ALLOWING, jcrcPositionCca: [] });
    await expect(assertDirectorOf(db, "E1", 9001)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_DIRECTOR",
    });
    expect(logged()).toEqual([]);
  });

  it("assertSocialDirector says NOT_SOCIAL_DIRECTOR when the answer is no", async () => {
    const { db } = scriptedDb({ ...ALLOWING, jcrcPosition: [] });
    await expect(assertSocialDirector(db, "E1")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_SOCIAL_DIRECTOR",
    });
  });

  it("a person without jcrc in storage is refused and no later read is made", async () => {
    const { db, reads } = scriptedDb({
      ...ALLOWING,
      userRole: [{ userID: "E1", roles: ["resident"], role: null }],
    });
    expect(await isDirectorOf(db, "E1", 9001)).toBe(false);
    expect(reads.some((r) => r.startsWith("jcrcPositionHolder"))).toBe(false);
  });

  it("an ended term refuses", async () => {
    const { db } = scriptedDb({
      ...ALLOWING,
      jcrcTerm: [{ userID: "E1" }],
    });
    expect(await isDirectorOf(db, "E1", 9001)).toBe(false);
  });

  it("flag off: nothing is read after the flag", async () => {
    const { db, reads } = scriptedDb({
      ...ALLOWING,
      systemFlag: [{ key: "directors.enabled", value: "off" }],
    });
    expect(await isDirectorOf(db, "E1", 9001)).toBe(false);
    expect(await isSocialDirector(db, "E1")).toBe(false);
    expect(await directedCcaIDs(db, "E1")).toEqual([]);
    expect(reads.every((r) => r.startsWith("systemFlag"))).toBe(true);
  });

  it("flag row absent: off", async () => {
    const { db } = scriptedDb({ ...ALLOWING, systemFlag: [] });
    expect(await isDirectorOf(db, "E1", 9001)).toBe(false);
  });

  it("a ccaID that is not a whole number is refused without a read", async () => {
    const { db, reads } = scriptedDb(ALLOWING);
    expect(await isDirectorOf(db, "E1", Number.NaN)).toBe(false);
    expect(reads).toEqual([]);
  });
});

describe("isDirectorsEnabled is the forgiving display read", () => {
  it("is false when the flag read throws", async () => {
    const { db } = scriptedDb(ALLOWING, "systemFlag");
    expect(await isDirectorsEnabled(db)).toBe(false);
  });
  it("is true only for the exact value on", async () => {
    expect(await isDirectorsEnabled(scriptedDb(ALLOWING).db)).toBe(true);
    expect(
      await isDirectorsEnabled(
        scriptedDb({ systemFlag: [{ value: "ON " }] }).db,
      ),
    ).toBe(false);
  });
});

describe("vacancy reads also fail loudly", () => {
  it.each(["jcrcPositionHolder", "userRole", "jcrcTerm"] as const)(
    "isPositionVacant rejects when the %s read throws",
    async (m) => {
      const { db } = scriptedDb(ALLOWING, m);
      await expect(isPositionVacant(db, "p1")).rejects.toMatchObject({
        name: "MongoServerError",
      });
    },
  );

  it.each([
    "jcrcPositionCca",
    "jcrcPosition",
    "jcrcPositionHolder",
    "userRole",
    "jcrcTerm",
  ] as const)("isCcaVacant rejects when the %s read throws", async (m) => {
    const { db } = scriptedDb(ALLOWING, m);
    await expect(isCcaVacant(db, 9001)).rejects.toMatchObject({
      name: "MongoServerError",
    });
  });
});

describe("getUserRoles stays forgiving (the guard is the only strict reader)", () => {
  it("still returns jcrc when the JcrcTerm read throws, while the guard refuses", async () => {
    const scripted = scriptedDb(ALLOWING, "jcrcTerm");
    const withRoleRow = {
      ...scripted.db,
      userRole: {
        findUnique: async () => ({
          userID: "E1",
          roles: ["resident", "jcrc"],
          role: null,
        }),
      },
    } as unknown as PrismaClient;

    expect(await getUserRoles(withRoleRow, "E1")).toContain("jcrc");
    await expect(
      assertDirectorOf(scripted.db, "E1", 9001),
    ).rejects.toMatchObject({ message: "DIRECTOR_CHECK_FAILED" });
  });
});
