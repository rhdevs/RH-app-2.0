import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { canMove, type LoanStatus } from "~/lib/equipment/status";
import {
  isWriteConflict,
  retryWriteConflicts,
} from "~/lib/transcript/writeConflict";

/**
 * THE ONLY CODE THAT WRITES `EquipmentLoan.status`, apart from the schema
 * default, "requested", applied when a loan is filed; equipmentSourceScans.test.ts
 * scans the source to keep it so. It is also the one place a write conflict is
 * turned into CONFLICT (a stale caller) or EQUIPMENT_TRY_AGAIN (a busy item).
 *
 * One call is one transaction:
 *  1. the loan is read INSIDE the transaction and must still be in the status,
 *     version and CCA the caller saw (else CONFLICT, nothing written);
 *  2. the caller's `guard`, run on the transaction client. Approval uses it to
 *     check the stock and to bump every involved EquipmentItem row;
 *  3. a COMPARE-AND-SET on the loan (`updateMany` on id, status, version, CCA),
 *     so exactly one of two people pressing the same button wins.
 *
 * WHY THE ITEMS ARE BUMPED. MongoDB gives a transaction snapshot isolation, so
 * two approvals of DIFFERENT loans that share an item would each read the
 * other as not yet approved, both pass the stock check and both commit. They
 * conflict only if they write a document in common. The guard therefore writes
 * every item the loan names (version + 1), and the loser of the race is aborted
 * with a write conflict (Prisma P2034). `retryConflicts` runs the whole
 * transaction again, from fresh reads, at most twice more (three tries in
 * all), then refuses with EQUIPMENT_TRY_AGAIN.
 *
 * A director note after the return (`amend`) is the same transaction and the
 * same compare-and-set, with the status left as it is.
 *
 * Whether the actor MAY make the move is the caller's job, done before this
 * call. This function checks only that the move exists in the table.
 */

export const EQUIPMENT_CONFLICT = "EQUIPMENT_CONFLICT";
export const EQUIPMENT_BAD_MOVE = "EQUIPMENT_BAD_MOVE";
export const EQUIPMENT_TRY_AGAIN = "EQUIPMENT_TRY_AGAIN";
export const EQUIPMENT_LOAN_GONE = "EQUIPMENT_NOT_FOUND";

/** What the guard and the notices are handed: the loan as it stood before the move. */
export type LoanRow = {
  id: string;
  eventID: number;
  ccaID: number | null;
  requestedBy: string | null;
  status: LoanStatus;
  version: number;
  collectAt: number;
  returnAt: number;
  lines: { itemID: string; quantity: number }[];
};

const ROW_SELECT = {
  id: true,
  eventID: true,
  ccaID: true,
  requestedBy: true,
  status: true,
  version: true,
  collectAt: true,
  returnAt: true,
  lines: { select: { itemID: true, quantity: true } },
} as const;

export type MoveInput = {
  id: string;
  /** The version the caller saw. The write applies only if it is still this. */
  expectedVersion: number;
  /** The CCA the caller checked access for (null is hall-wide). */
  expectedCcaID: number | null;
  from: LoanStatus;
  to: LoanStatus;
  actorID: string;
  /**
   * Approve and reject record who decided and why (decidedBy, decidedAt,
   * reason). A director's cancel records into its own fields (canceledBy,
   * canceledAt, cancelReason), so the approval it follows is kept as it was.
   */
  decision?: { reason: string | null; directorNote?: string | null };
  /**
   * Set or replace the director note on a returned loan. The one move that
   * keeps the status (from and to are both "returned"); it bumps the version
   * like every write, so it is the same compare-and-set.
   */
  amend?: { directorNote: string };
  /** Returning with a photo: the checked pathname, type and size. */
  photo?: { pathname: string; contentType: string; size: number } | null;
};

type Guard = (tx: Prisma.TransactionClient, loan: LoanRow) => Promise<void>;

const conflict = () =>
  new TRPCError({ code: "CONFLICT", message: EQUIPMENT_CONFLICT });

function dataFor(
  input: MoveInput,
  now: Date,
): Prisma.EquipmentLoanUpdateManyMutationInput {
  const data: Prisma.EquipmentLoanUpdateManyMutationInput = {
    status: input.to,
    version: { increment: 1 },
  };
  if (input.amend) data.directorNote = input.amend.directorNote;
  if (input.decision && input.to === "canceled") {
    data.canceledBy = input.actorID;
    data.canceledAt = now;
    data.cancelReason = input.decision.reason;
  } else if (input.decision) {
    data.decidedBy = input.actorID;
    data.decidedAt = now;
    data.reason = input.decision.reason;
    if (input.decision.directorNote !== undefined) {
      data.directorNote = input.decision.directorNote;
    }
  }
  if (input.to === "collected") data.collectedAt = now;
  if (input.to === "returned" && !input.amend) {
    data.returnedAt = now;
    data.returnedBy = input.actorID;
    data.returnPhoto = input.photo?.pathname ?? null;
    data.returnPhotoType = input.photo?.contentType ?? null;
    data.returnPhotoSize = input.photo?.size ?? null;
  }
  return data;
}

async function moveOnce(
  db: PrismaClient,
  input: MoveInput,
  guard: Guard | undefined,
): Promise<LoanRow> {
  return db.$transaction(async (tx) => {
    const loan = await tx.equipmentLoan.findUnique({
      where: { id: input.id },
      select: ROW_SELECT,
    });
    if (!loan) {
      throw new TRPCError({ code: "NOT_FOUND", message: EQUIPMENT_LOAN_GONE });
    }
    if (
      loan.status !== input.from ||
      loan.version !== input.expectedVersion ||
      loan.ccaID !== input.expectedCcaID
    ) {
      throw conflict();
    }
    const row: LoanRow = { ...loan, status: input.from };
    await guard?.(tx, row);
    const changed = await tx.equipmentLoan.updateMany({
      where: {
        id: input.id,
        status: input.from,
        version: input.expectedVersion,
        ccaID: input.expectedCcaID,
      },
      data: dataFor(input, new Date()),
    });
    if (changed.count !== 1) throw conflict();
    return row;
  });
}

/**
 * Move a loan from one status to the next. Returns the loan as it stood before
 * the move (its status is `from`), for the notices. `retryConflicts` is for
 * moves whose guard bumps items: a lost race is run again instead of being
 * reported as a stale page.
 */
export async function moveLoan(
  db: PrismaClient,
  input: MoveInput,
  options: { guard?: Guard; retryConflicts?: boolean } = {},
): Promise<LoanRow> {
  const allowed = input.amend
    ? input.from === "returned" && input.to === "returned"
    : canMove(input.from, input.to);
  if (!allowed) {
    throw new TRPCError({ code: "BAD_REQUEST", message: EQUIPMENT_BAD_MOVE });
  }
  try {
    const run = () => moveOnce(db, input, options.guard);
    return options.retryConflicts
      ? await retryWriteConflicts(run)
      : await run();
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    if (isWriteConflict(err)) {
      throw options.retryConflicts
        ? new TRPCError({ code: "CONFLICT", message: EQUIPMENT_TRY_AGAIN })
        : conflict();
    }
    throw err;
  }
}
