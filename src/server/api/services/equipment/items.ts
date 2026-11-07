import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";

import type {
  itemCreateInput,
  itemRetireInput,
  itemUpdateInput,
} from "~/lib/schemas/equipment";
import { shortMessage } from "~/lib/equipment/stock";
import {
  isWriteConflict,
  retryWriteConflicts,
} from "~/lib/transcript/writeConflict";
import { assertDirector, type EquipmentAccessDb } from "./access";
import { assertWithinLimit } from "./limits";
import { overbookedBy } from "./stock";
import { EQUIPMENT_CONFLICT, EQUIPMENT_TRY_AGAIN } from "./transition";

/**
 * The equipment list. Only the Social director edits it (the strict guard,
 * checked before anything is read or counted). An item is never deleted once
 * any loan names it: retire it instead, and it stays on the old loans.
 *
 * Lowering a quantity uses the same pattern as an approval: the holding loans
 * are read inside a transaction and the item row is written in it, so an
 * approval that lands at the same time (which also writes the item row)
 * conflicts with it, and the loser is run again from fresh reads, at most
 * twice more, then refused with EQUIPMENT_TRY_AGAIN.
 */

export const EQUIPMENT_ITEM_NOT_FOUND = "EQUIPMENT_ITEM_NOT_FOUND";
export const EQUIPMENT_ITEM_IN_USE = "EQUIPMENT_ITEM_IN_USE";

export type ItemsDb = EquipmentAccessDb & PrismaClient;

export type ItemView = {
  id: string;
  name: string;
  note: string;
  quantity: number;
  retired: boolean;
  version: number;
};

const SELECT = {
  id: true,
  name: true,
  note: true,
  quantity: true,
  retired: true,
  version: true,
} as const;

const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: EQUIPMENT_ITEM_NOT_FOUND });
const conflict = () =>
  new TRPCError({ code: "CONFLICT", message: EQUIPMENT_CONFLICT });

/** Every item, retired ones last. Readers are checked by the caller. */
export async function listItems(
  db: Pick<PrismaClient, "equipmentItem">,
): Promise<ItemView[]> {
  const rows = await db.equipmentItem.findMany({
    select: SELECT,
    orderBy: [{ retired: "asc" }, { name: "asc" }],
    take: 500,
  });
  return rows;
}

export async function createItem(
  db: ItemsDb,
  userID: string,
  input: z.infer<typeof itemCreateInput>,
): Promise<ItemView> {
  await assertDirector(db, userID);
  await assertWithinLimit("item", userID);
  // Always written explicitly: a missing key never matches a false filter.
  return db.equipmentItem.create({
    data: {
      name: input.name,
      note: input.note,
      quantity: input.quantity,
      retired: false,
      version: 0,
    },
    select: SELECT,
  });
}

/** Run a write that may lose a race with an approval; refuse after three tries. */
async function raced<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await retryWriteConflicts(write);
  } catch (err) {
    if (isWriteConflict(err)) {
      throw new TRPCError({ code: "CONFLICT", message: EQUIPMENT_TRY_AGAIN });
    }
    throw err;
  }
}

export async function updateItem(
  db: ItemsDb,
  userID: string,
  input: z.infer<typeof itemUpdateInput>,
  now: Date = new Date(),
): Promise<ItemView> {
  await assertDirector(db, userID);
  await assertWithinLimit("item", userID);
  return raced(() =>
    db.$transaction(async (tx) => {
      const item = await tx.equipmentItem.findUnique({
        where: { id: input.id },
        select: SELECT,
      });
      if (!item) throw notFound();
      if (item.version !== input.version) throw conflict();
      if (input.quantity < item.quantity) {
        const over = await overbookedBy(
          tx,
          { id: item.id, name: input.name },
          input.quantity,
          Math.floor(now.getTime() / 1000),
        );
        if (over) {
          throw new TRPCError({
            code: "CONFLICT",
            message: shortMessage(over),
          });
        }
      }
      const changed = await tx.equipmentItem.updateMany({
        where: { id: input.id, version: input.version },
        data: {
          name: input.name,
          note: input.note,
          quantity: input.quantity,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw conflict();
      return {
        ...item,
        name: input.name,
        note: input.note,
        quantity: input.quantity,
        version: item.version + 1,
      };
    }),
  );
}

/** Retire (or bring back) an item. Retiring holds nothing back: old loans keep it. */
export async function retireItem(
  db: ItemsDb,
  userID: string,
  input: z.infer<typeof itemRetireInput>,
): Promise<ItemView> {
  await assertDirector(db, userID);
  await assertWithinLimit("item", userID);
  return raced(() =>
    db.$transaction(async (tx) => {
      const item = await tx.equipmentItem.findUnique({
        where: { id: input.id },
        select: SELECT,
      });
      if (!item) throw notFound();
      if (item.version !== input.version) throw conflict();
      const changed = await tx.equipmentItem.updateMany({
        where: { id: input.id, version: input.version },
        data: { retired: input.retired, version: { increment: 1 } },
      });
      if (changed.count !== 1) throw conflict();
      return { ...item, retired: input.retired, version: item.version + 1 };
    }),
  );
}

/** Delete an item no loan has ever named. */
export async function deleteItem(
  db: ItemsDb,
  userID: string,
  id: string,
): Promise<{ removed: true }> {
  await assertDirector(db, userID);
  await assertWithinLimit("item", userID);
  return raced(() =>
    db.$transaction(async (tx) => {
      const item = await tx.equipmentItem.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!item) throw notFound();
      const named = await tx.equipmentLoan.count({
        where: { lines: { some: { itemID: id } } },
      });
      if (named > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: EQUIPMENT_ITEM_IN_USE,
        });
      }
      const gone = await tx.equipmentItem.deleteMany({ where: { id } });
      if (gone.count !== 1) throw conflict();
      return { removed: true as const };
    }),
  );
}
