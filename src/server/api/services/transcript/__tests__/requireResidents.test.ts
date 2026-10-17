import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { requireResidents } from "../residents";

/** A database that only knows these users, and counts how often it is asked. */
function dbWith(
  users: Array<{
    id: string;
    email: string;
    userID: string | null;
    displayName: string | null;
  }>,
) {
  const findMany = vi.fn(async () => users);
  const findFirst = vi.fn();
  const findUnique = vi.fn();
  const db = {
    user: { findMany, findFirst, findUnique },
  } as unknown as PrismaClient;
  return { db, findMany, findFirst, findUnique };
}

const user = (n: number) => ({
  id: `oid${n}`,
  email: `e${String(n).padStart(7, "0")}@u.nus.edu`,
  userID: `E${String(n).padStart(7, "0")}`,
  displayName: `Resident ${n}`,
});

describe("requireResidents (F25b)", () => {
  it("resolves 500 keys with ONE query", async () => {
    const people = Array.from({ length: 500 }, (_, i) => user(i + 1));
    const { db, findMany, findFirst, findUnique } = dbWith(people);

    const found = await requireResidents(
      db,
      people.map((p) => p.userID!),
    );

    expect(found.size).toBe(500);
    expect(found.get("E0000007")).toEqual({
      key: "E0000007",
      displayName: "Resident 7",
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("matches a key by the guessed email too, case-insensitively", async () => {
    const { db } = dbWith([user(7)]);

    const found = await requireResidents(db, ["e0000007"]);

    expect(found.get("e0000007")?.displayName).toBe("Resident 7");
  });

  it("reports an unknown key as RESIDENT_NOT_FOUND, as requireResident does", async () => {
    const { db } = dbWith([user(1)]);

    await expect(
      requireResidents(db, ["E0000001", "E9999999"]),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "RESIDENT_NOT_FOUND",
    });
  });

  it("asks nothing for no keys", async () => {
    const { db, findMany } = dbWith([]);
    expect((await requireResidents(db, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
