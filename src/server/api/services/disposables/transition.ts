import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { canMove, type DisposableStatus } from "~/lib/disposables/status";
import { isWriteConflict } from "~/lib/transcript/writeConflict";

/**
 * THE ONLY CODE THAT WRITES `DisposableRequest.status` (merge proposal 4.9),
 * apart from the schema default, "pending", applied when a request is created;
 * proposalSourceScans.test.ts scans the source to keep it so. It is also the
 * one place that changes or removes a request after it exists, and the one
 * place a write conflict is turned into CONFLICT.
 *
 * One call is one transaction:
 *  1. a COMPARE-AND-SET on the request: `updateMany` whose filter names the
 *     status and the version the caller saw, and the CCA the caller checked
 *     access for. Zero rows changed means a stale caller: CONFLICT, nothing
 *     written. This is what makes two people pressing approve at once safe:
 *     exactly one wins;
 *  2. the caller's `inTransaction`, run on the transaction client, which
 *     writes the notices. If it throws, the change is rolled back with it.
 *
 * MongoDB gives a transaction snapshot isolation. Two overlapping transactions
 * that both write the same request do not both commit: the loser is aborted
 * with a write conflict (Prisma P2034), mapped to the same CONFLICT.
 *
 * Whether the actor MAY make the change is the caller's job, done before this
 * call. This function checks only that the move exists in the table
 * (lib/disposables/status.ts).
 */

export const DISPOSABLE_CONFLICT = "DISPOSABLE_CONFLICT";
export const DISPOSABLE_BAD_MOVE = "DISPOSABLE_BAD_MOVE";
export const DISPOSABLE_GONE = "DISPOSABLE_NOT_FOUND";

/** The fields an edit replaces. */
export type RequestContent = {
  title: string;
  description: string;
  proposalID: string | null;
  plates: number;
  cups: number;
  bowls: number;
  forks: number;
  spoons: number;
  collectionDay: string;
  collectionTime: string;
};

export type ChangeInput = {
  id: string;
  /** The version the caller saw. The write applies only if it is still this. */
  expectedVersion: number;
  /** The CCA the caller checked access for; the write needs it unchanged. */
  expectedCcaID: number;
  /** The status the caller saw. */
  from: DisposableStatus;
  /** Equal to `from` for an edit that keeps the status. */
  to: DisposableStatus;
  actorID: string;
  /** An edit replaces these. */
  content?: RequestContent;
  /** A decision records who decided and why. */
  decision?: { note: string | null };
};

export type ChangedRequest = {
  id: string;
  ccaID: number;
  /** The requester, or null once their account is deleted. */
  createdBy: string | null;
  title: string;
  status: DisposableStatus;
  version: number;
};

type InTransaction<T> = (tx: Prisma.TransactionClient, row: T) => Promise<void>;

const conflict = () =>
  new TRPCError({ code: "CONFLICT", message: DISPOSABLE_CONFLICT });

export async function changeRequest(
  db: PrismaClient,
  input: ChangeInput,
  options: { inTransaction?: InTransaction<ChangedRequest> } = {},
): Promise<ChangedRequest> {
  const moves = input.from !== input.to;
  if (moves && !canMove(input.from, input.to)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: DISPOSABLE_BAD_MOVE });
  }
  if (input.decision && !moves) {
    throw new TRPCError({ code: "BAD_REQUEST", message: DISPOSABLE_BAD_MOVE });
  }
  const decided = input.to === "approved" || input.to === "rejected";
  try {
    return await db.$transaction(async (tx) => {
      const changed = await tx.disposableRequest.updateMany({
        where: {
          id: input.id,
          status: input.from,
          version: input.expectedVersion,
          ccaID: input.expectedCcaID,
        },
        data: {
          ...input.content,
          status: input.to,
          version: { increment: 1 },
          ...(input.decision && {
            decidedBy: input.actorID,
            decidedAt: new Date(),
            decisionNote: input.decision.note,
          }),
          // Back to pending (an edit of an approved request): the old
          // decision no longer stands, so it is not shown against the new one.
          ...(moves &&
            !decided && {
              decidedBy: null,
              decidedAt: null,
              decisionNote: null,
            }),
        },
      });
      if (changed.count !== 1) throw conflict();

      const row = await tx.disposableRequest.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          ccaID: true,
          createdBy: true,
          title: true,
          status: true,
          version: true,
        },
      });
      if (!row) throw conflict();
      const result: ChangedRequest = {
        ...row,
        status: input.to,
      };
      await options.inTransaction?.(tx, result);
      return result;
    });
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    if (isWriteConflict(err)) throw conflict();
    throw err;
  }
}

export type RemovedRequest = {
  id: string;
  ccaID: number;
  createdBy: string | null;
  title: string;
};

/** Delete one request, with the notices in the same transaction. */
export async function removeRequest(
  db: PrismaClient,
  input: { id: string; expectedCcaID: number },
  options: { inTransaction?: InTransaction<RemovedRequest> } = {},
): Promise<RemovedRequest> {
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.disposableRequest.findUnique({
        where: { id: input.id },
        select: { id: true, ccaID: true, createdBy: true, title: true },
      });
      if (!row || row.ccaID !== input.expectedCcaID) {
        throw new TRPCError({ code: "NOT_FOUND", message: DISPOSABLE_GONE });
      }
      const gone = await tx.disposableRequest.deleteMany({
        where: { id: input.id, ccaID: input.expectedCcaID },
      });
      if (gone.count !== 1) throw conflict();
      await options.inTransaction?.(tx, row);
      return row;
    });
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    if (isWriteConflict(err)) throw conflict();
    throw err;
  }
}
