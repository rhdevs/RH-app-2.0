import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * INTEGRATION TEST (local database only, `npm run test:db`) of how Open
 * transcripts counts people (F26): one person reached through two accounts
 * is saved once, and the extra account is counted as not matched.
 */

const REQUIRED_DB = "rhapp_transcript_dev";

function isLocalDevDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      ["localhost", "127.0.0.1"].includes(u.hostname) &&
      u.pathname === `/${REQUIRED_DB}`
    );
  } catch {
    return false;
  }
}

const AY = "AY2026/27";
const SOCCER = 9005;
const SOCCER_MEMBERS = 5;

// The live roster gains a second account that resolves to the same person.
vi.mock("../liveRoster", async (importOriginal) => {
  const real = await importOriginal<typeof import("../liveRoster")>();
  return {
    ...real,
    liveMembers: async (db: PrismaClient, ccaID: number) => {
      const live = await real.liveMembers(db, ccaID);
      const first = live.members[0];
      if (!first) return live;
      const twin = {
        ...first,
        entry: { ...first.entry, userId: `${first.entry.userId}-second` },
      };
      return { ...live, members: [...live.members, twin] };
    },
  };
});

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "Open transcripts counts each person once (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let freeze: typeof import("../freeze");

    const reseed = () =>
      execFileSync(process.execPath, ["scripts/dev/seed-transcript.mjs"], {
        stdio: "pipe",
      });

    beforeAll(async () => {
      reseed();
      ({ db } = await import("~/server/db"));
      freeze = await import("../freeze");
    }, 120_000);

    afterAll(async () => {
      if (db) {
        reseed();
        await db.$disconnect();
      }
    }, 120_000);

    it("saves a person with two accounts once and counts the extra account as not matched", async () => {
      const result = await freeze.freezeCca(db, {
        ccaID: SOCCER,
        academicYear: AY,
        actorUserID: "SEED-R02",
      });

      expect(result).toMatchObject({
        kind: "frozen",
        memberCount: SOCCER_MEMBERS,
        unresolvedCount: 1,
      });
      expect(
        await db.transcriptRosterEntry.count({
          where: { ccaID: SOCCER, academicYear: AY, frozen: true },
        }),
      ).toBe(SOCCER_MEMBERS);
      const lock = await db.ccaYearFreeze.findFirstOrThrow({
        where: { ccaID: SOCCER, academicYear: AY },
      });
      expect(lock).toMatchObject({
        memberCount: SOCCER_MEMBERS,
        unresolvedCount: 1,
        reason: "open",
      });
    });
  },
);
