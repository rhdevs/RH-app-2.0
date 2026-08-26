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

/**
 * IS THIS PERSON A MEMBER OF THIS CCA, RIGHT NOW?
 *
 * READ-ONLY, and it must agree with `removeCcaMember` about where membership
 * lives — ALL THREE PLACES, not just the obvious one:
 *   1. UserCCA rows under the CANONICAL key
 *   2. UserCCA rows under the LEGACY A-format key (same person, other key)
 *   3. the undeclared User.userCCA Int[] embedded array
 *
 * A `UserCCA`-ONLY CHECK IS THE BUG THIS FUNCTION EXISTS TO PREVENT. A
 * measurement during planning found 37 of 116 sampled users are embedded-array
 * ONLY — roughly a third of every CCA. Checking (1) alone tells those people
 * they are not members of a CCA they are plainly in, and the place that would
 * surface is a door, with a queue behind them, while a committee member reads
 * an error that says the opposite of what everyone present can see.
 *
 * Used by `assertMayScan` to re-validate a NOMINATED SCANNER at scan time (I-5)
 * rather than trusting the stored `Event.scannerUserIDs` list, which was
 * written when the event was created and may name someone who has since left.
 */
/**
 * Find the `User` row behind a key that may be EITHER a canonical id OR the
 * legacy A-format value stored in `User.userID`.
 *
 * A `findFirst({ where: { userID } })` IS THE BUG THIS EXISTS TO PREVENT.
 * `schema.prisma` says it outright above `UserMatric`: *"NEVER key on
 * User.userID: ~515 users have an A-format matric there (invariant I-1)."*
 * `session.user.userID` is `canonicalUserID(email)`, so for every one of those
 * rows a lookup by the canonical key on the `userID` COLUMN matches nothing —
 * and a caller that then gives up has silently skipped the embedded
 * `User.userCCA` array, which is the ONLY membership source for ~37 of 116
 * measured users.
 *
 * So this matches the way `resolveAttendees` (routers/event.ts) already does:
 * the guessed `@u.nus.edu` address OR the stored column, whichever lands.
 */
export async function findUserByAnyKey(
  db: PrismaClient,
  key: string,
): Promise<{ id: string; email: string; userID: string | null } | null> {
  // Never a bare read: passwordHash must not be selected (a Google-adapter row
  // lacking it throws on deserialization — I-2), so the select is explicit.
  const select = { id: true, email: true, userID: true } as const;
  return await db.user.findFirst({
    where: {
      OR: [
        { email: { equals: `${key.toLowerCase()}@u.nus.edu`, mode: "insensitive" } },
        { userID: key },
      ],
    },
    select,
  });
}

/**
 * EVERY KEY THAT NAMES THIS PERSON, from any one of them.
 *
 * `membershipKeysFor` needs a `{ email, userID }` pair; this is the lookup that
 * gets there from a bare key, and it is what any caller comparing a
 * client-supplied or stored identity against a session identity must use. The
 * two are NOT interchangeable strings: one is `canonicalUserID(email)` and the
 * other is whatever `User.userID` happens to hold.
 *
 * Falls back to the key itself when no `User` row resolves, so an orphaned
 * membership row is still checkable rather than being treated as absent.
 */
export async function membershipKeysForKey(
  db: PrismaClient,
  key: string,
): Promise<string[]> {
  const u = await findUserByAnyKey(db, key);
  return u ? membershipKeysFor(u) : [key];
}

export async function isLiveCcaMember(
  db: PrismaClient,
  ccaID: number,
  userID: string,
): Promise<boolean> {
  // Resolve the person first, so (2) and (3) are reachable at all — and resolve
  // them by EITHER key, because `userID` here may be the canonical session id
  // while the row stores an A-format matric, or the exact reverse.
  const u = await findUserByAnyKey(db, userID);

  // (1) + (2). With a User row we can check BOTH keys; without one, the given
  // key is all there is — an unresolved key is still worth checking directly
  // rather than refusing outright, because a UserCCA row can outlive its User.
  const keys = u ? membershipKeysFor(u) : [userID];
  const rows = await db.userCCA.count({
    where: { ccaID, userID: { in: keys } },
  });
  if (rows > 0) return true;

  // (3) the embedded array. Not declared in `model User`, so Prisma cannot
  // express it and this has to be a raw command — the same reason
  // removeCcaMember reaches for $runCommandRaw to clean it.
  if (!u) return false;
  const reply = (await db.$runCommandRaw({
    count: "User",
    query: { _id: { $oid: u.id }, userCCA: ccaID },
  })) as { n?: number; ok?: number } | null;

  // A FAILED READ IS NOT A ZERO. `ok` is inspected because treating an errored
  // reply as "not a member" would fail OPEN in the wrong direction here: it
  // would deny a real member at a door and look identical to a correct refusal.
  if (!reply || reply.ok !== 1) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "MEMBERSHIP_READ_FAILED",
    });
  }
  return (reply.n ?? 0) > 0;
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
 * THE single writer that ADDS a CCA membership — one canonical `UserCCA` row.
 *
 * MUST go through `$runCommandRaw`, NOT `db.userCCA.create`. `UserCCA` carries a
 * DB-level `$jsonSchema` validator that declares `ccaID` as bsonType **"int"**
 * (int32). Prisma's Mongo connector serializes an `Int` field as a 64-bit
 * `long`, which the validator REJECTS with code 121 ("Document failed
 * validation") — so `userCCA.create({ data: { ccaID, userID } })` throws for
 * EVERY add, silently taking down application-acceptance and admin add-member.
 * The extended-JSON `{ $numberInt }` forces a true int32 that passes.
 *
 * The write reply is INSPECTED (I-8f) rather than trusting a throw: a validation
 * failure comes back as `ok:1` with a `writeErrors` array, not an exception.
 *
 * Caller supplies the CANONICAL userID and has already deduped against both key
 * formats (UserCCA has no compound unique, so a check-then-insert can still race
 * — the roster surfaces any duplicate rather than hiding it).
 */
export async function addCcaMember(
  db: PrismaClient,
  ccaID: number,
  userID: string,
): Promise<void> {
  const reply = (await db.$runCommandRaw({
    insert: "UserCCA",
    documents: [{ ccaID: { $numberInt: String(ccaID) }, userID }],
  })) as { ok?: number; n?: number; writeErrors?: unknown[] };

  const writeErrors = reply?.writeErrors ?? [];
  if (writeErrors.length > 0 || reply?.n !== 1) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "MEMBERSHIP_WRITE_FAILED",
    });
  }
}

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
