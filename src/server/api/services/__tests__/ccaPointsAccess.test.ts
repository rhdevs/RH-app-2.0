import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { assertIsHeadOfCca } from "~/server/api/services/ccaPointsAccess";

/**
 * The points page is for the CCA's own heads only. The decision is a CcaHead
 * row for (user, CCA) — never a role. These tests give the helper a fake db
 * whose only table is CcaHead, so a role cannot influence the answer.
 */
function dbWithHeadRows(rows: { userID: string; ccaID: number }[]) {
  const findUnique = vi.fn(
    async (args: {
      where: { userID_ccaID: { userID: string; ccaID: number } };
    }) => {
      const key = args.where.userID_ccaID;
      return (
        rows.find((r) => r.userID === key.userID && r.ccaID === key.ccaID) ??
        null
      );
    },
  );
  return {
    db: { ccaHead: { findUnique } } as unknown as PrismaClient,
    findUnique,
  };
}

describe("assertIsHeadOfCca", () => {
  it("lets a head of this CCA through", async () => {
    const { db } = dbWithHeadRows([{ userID: "head1", ccaID: 9005 }]);
    await expect(assertIsHeadOfCca(db, "head1", 9005)).resolves.toBeUndefined();
  });

  it("refuses a JCRC member who is not a head", async () => {
    const { db } = dbWithHeadRows([{ userID: "head1", ccaID: 9005 }]);
    await expect(assertIsHeadOfCca(db, "jcrc1", 9005)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_A_HEAD_OF_THIS_CCA",
    });
  });

  it("refuses an admin who is not a head", async () => {
    const { db } = dbWithHeadRows([]);
    await expect(assertIsHeadOfCca(db, "admin1", 9005)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_A_HEAD_OF_THIS_CCA",
    });
  });

  it("lets a JCRC member through when they head THIS CCA", async () => {
    const { db } = dbWithHeadRows([{ userID: "jcrc1", ccaID: 9005 }]);
    await expect(assertIsHeadOfCca(db, "jcrc1", 9005)).resolves.toBeUndefined();
  });

  it("refuses a head of a different CCA", async () => {
    const { db } = dbWithHeadRows([{ userID: "jcrc1", ccaID: 9007 }]);
    await expect(assertIsHeadOfCca(db, "jcrc1", 9005)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("looks the row up by the user and CCA together", async () => {
    const { db, findUnique } = dbWithHeadRows([]);
    await assertIsHeadOfCca(db, "u1", 12).catch(() => undefined);
    expect(findUnique).toHaveBeenCalledWith({
      where: { userID_ccaID: { userID: "u1", ccaID: 12 } },
      select: { id: true },
    });
  });
});
