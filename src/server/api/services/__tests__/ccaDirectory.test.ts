import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/server/api/services/ccaRoster", () => ({ resolveRoster: vi.fn() }));

import { buildDirectoryEntries } from "~/server/api/services/ccaDirectory";
import {
  resolveRoster,
  type Roster,
  type RosterEntry,
} from "~/server/api/services/ccaRoster";

const mockedRoster = vi.mocked(resolveRoster);

const CCA = { ccaID: 9001, ccaName: "Test Choir", category: null };

const resolved = (patch: Partial<RosterEntry> = {}): RosterEntry =>
  ({
    kind: "resolved",
    userId: "obj1",
    email: "e0000001@u.nus.edu",
    displayName: "Test Member 1",
    storedUserID: "E0000001",
    isHead: false,
    grantedAt: null,
    sources: ["userCCA"],
    membershipKeys: ["E0000001"],
    userCcaRowCount: 1,
    ...patch,
  }) as RosterEntry;

const unresolved = (patch: Partial<RosterEntry> = {}): RosterEntry =>
  ({
    kind: "unresolved",
    key: "E0000099",
    isHead: false,
    grantedAt: null,
    sources: ["userCCA"],
    userCcaRowCount: 2,
    reason: "NO_USER_ROW",
    candidateUserIds: [],
    ...patch,
  }) as RosterEntry;

const roster = (heads: RosterEntry[], members: RosterEntry[]): Roster => ({
  cca: CCA,
  heads,
  members,
  counts: {
    heads: heads.length,
    members: members.length,
    total: heads.length + members.length,
  },
  drift: {
    unresolvedCount: 0,
    ambiguousCount: 0,
    duplicateUserCcaRows: 0,
    headsUnresolved: 0,
    ccaMissing: false,
  },
});

function stubDb(
  profiles: unknown[] = [],
  matrics: { userID: string; matric: string }[] = [],
) {
  const user = { findMany: vi.fn(async () => profiles) };
  // Honours `where.userID.in`, so a test sees only the keys the code asked for.
  const userMatric = {
    findMany: vi.fn(async (args: { where: { userID: { in: string[] } } }) =>
      matrics.filter((m) => args.where.userID.in.includes(m.userID)),
    ),
  };
  return {
    db: { user, userMatric } as unknown as PrismaClient,
    user,
    userMatric,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("buildDirectoryEntries", () => {
  it("makes no database calls for an empty roster", async () => {
    mockedRoster.mockResolvedValue(roster([], []));
    const { db, user, userMatric } = stubDb();
    expect(await buildDirectoryEntries(db, 9001)).toEqual({
      cca: CCA,
      entries: [],
    });
    expect(user.findMany).not.toHaveBeenCalled();
    expect(userMatric.findMany).not.toHaveBeenCalled();
  });

  it("finds a matric filed under a non-first key (membership key, then stored id, then email)", async () => {
    // Keys tried in order: membershipKeys..., storedUserID, canonical email id.
    mockedRoster.mockResolvedValue(
      roster(
        [],
        [
          resolved({
            membershipKeys: ["first-key", "second-key"],
            storedUserID: "E0000001",
            email: "e0000001@u.nus.edu",
          }),
        ],
      ),
    );
    const { db, userMatric } = stubDb(
      [{ id: "obj1", telegramHandle: "@t", block: 4, bio: "hello" }],
      [{ userID: "second-key", matric: "A9900001Z" }],
    );
    const { entries } = await buildDirectoryEntries(db, 9001);
    expect(entries).toEqual([
      {
        rowKey: "u:obj1",
        resolved: true,
        role: "Member",
        name: "Test Member 1",
        email: "e0000001@u.nus.edu",
        userID: "E0000001",
        matric: "A9900001Z",
        block: 4,
        telegramHandle: "@t",
        bio: "hello",
        membershipRecords: 1,
        joinedAt: null,
        note: null,
      },
    ]);
    const asked = (
      userMatric.findMany.mock.calls[0] as unknown as [
        { where: { userID: { in: string[] } } },
      ]
    )[0].where.userID.in;
    expect(asked).toEqual(
      expect.arrayContaining(["first-key", "second-key", "E0000001"]),
    );
  });

  it("falls back to the stored id when the membership keys have no matric", async () => {
    mockedRoster.mockResolvedValue(
      roster([], [resolved({ membershipKeys: ["nope"] })]),
    );
    const { db } = stubDb([], [{ userID: "E0000001", matric: "A9900002Z" }]);
    const { entries } = await buildDirectoryEntries(db, 9001);
    expect(entries[0]).toMatchObject({ matric: "A9900002Z", block: null });
  });

  it("prefers a membership key's matric over the stored userID's", async () => {
    mockedRoster.mockResolvedValue(
      roster(
        [],
        [
          resolved({
            membershipKeys: ["E0000001"],
            storedUserID: "E0000002",
            email: "e0000003@u.nus.edu",
          }),
        ],
      ),
    );
    const { db } = stubDb(
      [],
      [
        { userID: "E0000001", matric: "A9900011Z" },
        { userID: "E0000002", matric: "A9900012Z" },
        { userID: "E0000003", matric: "A9900013Z" },
      ],
    );
    const { entries } = await buildDirectoryEntries(db, 9001);
    expect(entries[0]).toMatchObject({ matric: "A9900011Z" });
  });

  it("prefers the stored userID's matric over the email-derived id's", async () => {
    mockedRoster.mockResolvedValue(
      roster(
        [],
        [
          resolved({
            membershipKeys: [],
            storedUserID: "E0000002",
            email: "e0000003@u.nus.edu",
          }),
        ],
      ),
    );
    const { db } = stubDb(
      [],
      [
        { userID: "E0000002", matric: "A9900012Z" },
        { userID: "E0000003", matric: "A9900013Z" },
      ],
    );
    const { entries } = await buildDirectoryEntries(db, 9001);
    expect(entries[0]).toMatchObject({ matric: "A9900012Z" });
  });

  it("keeps unresolved rows with a k: key and the right note for each reason", async () => {
    mockedRoster.mockResolvedValue(
      roster(
        [],
        [
          unresolved({ key: "E0000050", reason: "AMBIGUOUS_KEY" }),
          unresolved({
            key: "E0000051",
            reason: "NO_USER_ROW",
            grantedAt: new Date("2027-01-02T03:04:05.000Z"),
          }),
        ],
      ),
    );
    const { db, user, userMatric } = stubDb();
    const { entries } = await buildDirectoryEntries(db, 9001);
    expect(entries).toEqual([
      {
        rowKey: "k:E0000050",
        resolved: false,
        role: "Member",
        name: null,
        email: null,
        userID: "E0000050",
        matric: null,
        block: null,
        telegramHandle: null,
        bio: null,
        membershipRecords: 2,
        joinedAt: null,
        note: "Ambiguous record — more than one account claims this membership.",
      },
      {
        rowKey: "k:E0000051",
        resolved: false,
        role: "Member",
        name: null,
        email: null,
        userID: "E0000051",
        matric: null,
        block: null,
        telegramHandle: null,
        bio: null,
        membershipRecords: 2,
        joinedAt: "2027-01-02T03:04:05.000Z",
        note: "Unmatched record — no account matches this membership key.",
      },
    ]);
    // Nothing resolved, so no profile or matric lookups at all.
    expect(user.findMany).not.toHaveBeenCalled();
    expect(userMatric.findMany).not.toHaveBeenCalled();
  });

  it("marks heads as Head and lists them before members", async () => {
    mockedRoster.mockResolvedValue(
      roster(
        [resolved({ userId: "h1", displayName: "Test Head", isHead: true })],
        [resolved({ userId: "m1", displayName: "Test Member" })],
      ),
    );
    const { db } = stubDb();
    const { entries } = await buildDirectoryEntries(db, 9001);
    expect(entries.map((e) => [e.rowKey, e.role, e.name])).toEqual([
      ["u:h1", "Head", "Test Head"],
      ["u:m1", "Member", "Test Member"],
    ]);
  });
});
