"use client";

import Link from "next/link";
import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { equipmentErrorMessage } from "~/lib/equipment/errors";
import { EQUIPMENT_HREF } from "~/lib/equipment/links";
import { parseShortMessage } from "~/lib/equipment/stock";
import {
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  ITEM_QUANTITY_MAX,
} from "~/lib/schemas/equipment";
import ShortNotice from "./ShortNotice";

const fieldClass =
  "rounded-md border border-gray-300 dark:border-border bg-white dark:bg-card px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

/**
 * The equipment list. Everyone who may read the board sees it; only the Social
 * director sees the editing controls, and every change is checked again on the
 * server (the strict director guard, not admins). An item that a loan names can
 * be retired but not deleted, and the quantity cannot be lowered below what the
 * loans still to come already hold.
 */
export default function ItemsScreen() {
  const utils = api.useUtils();
  const enabled = api.equipment.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const data = api.equipment.items.useQuery(undefined, {
    retry: false,
    enabled: on,
  });
  const [error, setError] = useState<string | null>(null);
  const failed = (e: { message: string }) => {
    setError(e.message);
    void utils.equipment.items.invalidate();
  };
  const refresh = () => {
    setError(null);
    void utils.equipment.items.invalidate();
  };
  const create = api.equipment.createItem.useMutation({
    onSuccess: refresh,
    onError: failed,
  });
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [quantity, setQuantity] = useState("1");

  const muted = "text-sm text-gray-500 dark:text-muted-foreground";
  if (enabled.isLoading) return <p className={muted}>Loading…</p>;
  if (!on)
    return <p className={muted}>Equipment loans are not switched on yet.</p>;
  if (data.isLoading) return <p className={muted}>Loading the list…</p>;
  if (data.isError || !data.data) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {data.error?.message.includes("NOT_EQUIPMENT_READER")
          ? "You do not have access to the equipment list."
          : "Could not load the list. Try again shortly."}
      </p>
    );
  }
  const { items, isDirector } = data.data;
  const short = error ? parseShortMessage(error) : null;
  const quantityNumber = Number(quantity);
  const canAdd =
    name.trim() !== "" &&
    Number.isInteger(quantityNumber) &&
    quantityNumber >= 0 &&
    quantityNumber <= ITEM_QUANTITY_MAX;

  return (
    <section className="space-y-4">
      <Link
        href={EQUIPMENT_HREF}
        className="text-sm text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
      >
        All loans
      </Link>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground">
        Equipment list
      </h2>
      {!isDirector && (
        <p className="text-xs text-gray-500 dark:text-muted-foreground">
          Only the Social director can change this list.
        </p>
      )}
      {short ? <ShortNotice detail={short} /> : null}
      {error && !short && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {equipmentErrorMessage(error)}
        </p>
      )}

      {isDirector && (
        <form
          aria-label="Add an item"
          className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-border dark:bg-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canAdd) return;
            setError(null);
            create.mutate(
              { name, note, quantity: quantityNumber },
              {
                onSuccess: () => {
                  setName("");
                  setNote("");
                  setQuantity("1");
                },
              },
            );
          }}
        >
          <label className="text-xs text-gray-600 dark:text-muted-foreground">
            Name
            <input
              className={`${fieldClass} mt-1 block`}
              maxLength={ITEM_NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="text-xs text-gray-600 dark:text-muted-foreground">
            Note
            <input
              className={`${fieldClass} mt-1 block`}
              maxLength={ITEM_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label className="text-xs text-gray-600 dark:text-muted-foreground">
            Owned
            <input
              type="number"
              min={0}
              max={ITEM_QUANTITY_MAX}
              className={`${fieldClass} mt-1 block w-24`}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            disabled={!canAdd || create.isPending}
          >
            Add item
          </Button>
        </form>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 dark:border-border dark:bg-card dark:text-muted-foreground">
          No equipment has been listed yet.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white dark:divide-border dark:border-border dark:bg-card">
          {items.map((item) =>
            isDirector ? (
              <ItemEditor
                key={`${item.id}:${item.version}`}
                item={item}
                onDone={refresh}
                onFail={failed}
              />
            ) : (
              <li
                key={item.id}
                className="flex justify-between px-4 py-2 text-sm"
              >
                <span className="text-gray-900 dark:text-foreground">
                  {item.name}
                  {item.retired ? " (retired)" : ""}
                </span>
                <span className="text-gray-600 dark:text-muted-foreground">
                  {item.quantity}
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

type Item = {
  id: string;
  name: string;
  note: string;
  quantity: number;
  retired: boolean;
  version: number;
};

function ItemEditor({
  item,
  onDone,
  onFail,
}: {
  item: Item;
  onDone: () => void;
  onFail: (e: { message: string }) => void;
}) {
  const [name, setName] = useState(item.name);
  const [note, setNote] = useState(item.note);
  const [quantity, setQuantity] = useState(String(item.quantity));
  const update = api.equipment.updateItem.useMutation({
    onSuccess: onDone,
    onError: onFail,
  });
  const retire = api.equipment.retireItem.useMutation({
    onSuccess: onDone,
    onError: onFail,
  });
  const remove = api.equipment.deleteItem.useMutation({
    onSuccess: onDone,
    onError: onFail,
  });
  const busy = update.isPending || retire.isPending || remove.isPending;
  const quantityNumber = Number(quantity);
  const valid =
    name.trim() !== "" &&
    Number.isInteger(quantityNumber) &&
    quantityNumber >= 0 &&
    quantityNumber <= ITEM_QUANTITY_MAX;
  const changed =
    name !== item.name ||
    note !== item.note ||
    quantityNumber !== item.quantity;

  return (
    <li
      className={`flex flex-wrap items-end gap-3 px-4 py-3 ${item.retired ? "opacity-60" : ""}`}
    >
      <label className="text-xs text-gray-600 dark:text-muted-foreground">
        Name
        <input
          className={`${fieldClass} mt-1 block`}
          maxLength={ITEM_NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="text-xs text-gray-600 dark:text-muted-foreground">
        Note
        <input
          className={`${fieldClass} mt-1 block`}
          maxLength={ITEM_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="text-xs text-gray-600 dark:text-muted-foreground">
        Owned
        <input
          type="number"
          min={0}
          max={ITEM_QUANTITY_MAX}
          className={`${fieldClass} mt-1 block w-24`}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </label>
      <Button
        size="sm"
        disabled={busy || !valid || !changed}
        onClick={() =>
          update.mutate({
            id: item.id,
            version: item.version,
            name,
            note,
            quantity: quantityNumber,
          })
        }
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          retire.mutate({
            id: item.id,
            version: item.version,
            retired: !item.retired,
          })
        }
      >
        {item.retired ? "Bring back" : "Retire"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => remove.mutate({ id: item.id })}
      >
        Delete
      </Button>
    </li>
  );
}
