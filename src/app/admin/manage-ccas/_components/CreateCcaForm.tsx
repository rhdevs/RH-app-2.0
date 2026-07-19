"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

/**
 * Create a CCA.
 *
 * The ccaID is allocated SERVER-SIDE (max + 1) and is deliberately not an input
 * — it is the join key for Bookings, UserCCA and CcaHead, and letting an
 * operator type it invites a collision with a live one.
 */
export default function CreateCcaForm({ enabled }: { enabled: boolean }) {
  const [ccaName, setCcaName] = useState("");
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState(false);

  const utils = api.useUtils();
  const create = api.ccaAdmin.create.useMutation({
    onSuccess: async () => {
      setCcaName("");
      setCategory("");
      setOpen(false);
      await utils.ccaAdmin.listAll.invalidate();
    },
  });

  const message =
    create.error?.message === "CCA_NAME_ALREADY_EXISTS"
      ? "A CCA with that name already exists."
      : create.error?.message === "CCA_MANAGEMENT_DISABLED"
        ? "CCA management is turned off."
        : create.error
          ? "That didn't save. Try again."
          : null;

  if (!open) {
    return (
      <Button
        variant="outline"
        disabled={!enabled}
        onClick={() => setOpen(true)}
      >
        Add a CCA
      </Button>
    );
  }

  return (
    <form
      className="space-y-4 rounded-lg border border-gray-200 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ ccaName: ccaName.trim(), category: category.trim() });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cca-name">Name</Label>
          <Input
            id="cca-name"
            value={ccaName}
            onChange={(e) => setCcaName(e.target.value)}
            placeholder="Photography Club"
            maxLength={120}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cca-category">Category</Label>
          <Input
            id="cca-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Interest Group"
            maxLength={120}
            required
          />
        </div>
      </div>

      {message && <p className="text-sm text-red-600">{message}</p>}

      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={
            !enabled ||
            create.isPending ||
            !ccaName.trim() ||
            !category.trim()
          }
        >
          {create.isPending ? "Adding…" : "Add CCA"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            create.reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
