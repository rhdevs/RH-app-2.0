import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { canonicalUserID } from "~/lib/identity";

/**
 * The single writer that REMOVES a CCA membership.
 *
 * Extracted here because two call sites need identical behaviour and must never
 * drift apart: `ccaAdmin.removeMember` (admin, behind the management kill
 * switch) and `cca.removeMember` (a CCA head managing their own roster). A
 * second copy of the three-target delete is exactly how one of them ends up
 * cleaning two of the three places and silently leaving members on the roster.
 *
 * Authorisation is the CALLER'S job — this function trusts that its caller has
 * already run assertHeadsCca (heads) or requireManageCcas (admin). It performs
 * no permission check of its own, deliberately, so the guard lives with the
 * procedure boundary rather than being duplicated here.
 */

/**
 * How a member is named for removal. Never a client-supplied membership KEY for
 * a resolved user — the caller hands us the User.id the roster deduped on, and
 * we recompute the key set from the User document. The raw `key` branch exists
 * only for UNRESOLVED roster rows (amber records matching no account), which
 * have no User document to recompute from and would otherwise be uncleanable.
 */
export const removeMemberTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userObjectId: z.string().min(1) }),
  z.object({ kind: z.literal("key"), key: z.string().trim().min(1) }),
]);

export type RemoveMemberTarget = z.infer<typeof removeMemberTargetSchema>;

/**
 * Every membership key that resolves to one person.
 *
 * REMOVAL MUST USE ALL OF THEM. UserCCA.userID is mixed-format: a person can
 * hold a legacy A-format row AND a canonical row for the same CCA. Deleting
 * only the canonical one "removes" them while their legacy row keeps them on
 * the roster — a bug that looks like the delete silently failed.
 */
export function membershipKeysFor(u: {
  email: string;
  userID: string | null;
}): string[] {
  const keys = new Set<string>();
  const cid = canonicalUserID(u.email);
  if (cid) keys.add(cid);
  if (u.userID && u.userID.length > 0) keys.add(u.userID);
  return [...keys];
}

export type RemoveMemberResult = {
  removedRows: number;
  /** Human label for the audit reason: an email, or the raw key. */
  label: string;
  /** The key stored on the audit row's targetUserID. */
  targetKey: string;
  /** Whether the embedded User.userCCA array was also cleaned. */
  touchedEmbedded: boolean;
};

/**
 * MEMBERSHIP LIVES IN THREE PLACES AND THIS CLEANS ALL OF THEM:
 *   1. UserCCA rows under the CANONICAL key
 *   2. UserCCA rows under the LEGACY A-format key (same person, other key)
 *   3. the undeclared User.userCCA Int[] — a roster SOURCE, so a member left
 *      in the array simply reappears after a "successful" removal
 *
 * Adding a member writes only (1). The asymmetry is deliberate: do not grow the
 * legacy embedded array, but do clean it.
 */
export async function removeCcaMember(
  db: PrismaClient,
  ccaID: number,
  target: RemoveMemberTarget,
): Promise<RemoveMemberResult> {
  let keys: string[];
  let userObjectId: string | null = null;
  let label: string;

  if (target.kind === "user") {
    const u = await db.user.findUnique({
      where: { id: target.userObjectId },
      // Never a bare findMany/findUnique on User: passwordHash must not be read
      // (a Google-adapter row lacking it throws on deserialization — I-2).
      select: { id: true, email: true, userID: true },
    });
    if (!u) {
      throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_USER" });
    }
    keys = membershipKeysFor(u);
    userObjectId = u.id;
    label = u.email;
  } else {
    // An unresolved key matches no User row by definition, so there is no
    // embedded array to clean — (3) does not apply on this branch.
    keys = [target.key];
    label = target.key;
  }

  const removed = await db.userCCA.deleteMany({
    where: { ccaID, userID: { in: keys } },
  });

  // (3) the embedded array. Not declared in `model User`, so Prisma cannot
  // express this — it has to be a raw command.
  if (userObjectId) {
    await db.$runCommandRaw({
      update: "User",
      updates: [
        {
          q: { _id: { $oid: userObjectId } },
          u: { $pull: { userCCA: ccaID } },
        },
      ],
    });
  }

  return {
    removedRows: removed.count,
    label,
    targetKey: keys[0] ?? "",
    touchedEmbedded: userObjectId !== null,
  };
}
