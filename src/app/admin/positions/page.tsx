"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import HandoverPanel from "./_components/HandoverPanel";
import PositionCard from "./_components/PositionCard";
import { positionsErrorCopy } from "./_components/errorCopy";

/**
 * JCRC positions: who looks after which CCAs, and the self-handover.
 *
 * VIEWS ONLY. A position sets the default "My positions" filter on JCRC lists
 * (CCAs, Points, Event insights); every JCRC member keeps every power over
 * every CCA. Any JCRC member or admin may edit any position.
 */
export default function AdminPositionsPage() {
  const utils = api.useUtils();
  const list = api.jcrcPositions.list.useQuery(undefined, { retry: false });
  const members = api.jcrcPositions.jcrcMembers.useQuery(undefined, {
    retry: false,
  });
  const mine = api.jcrcPositions.mine.useQuery(undefined, { retry: false });

  const [name, setName] = useState("");
  const [overseesAll, setOverseesAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = api.jcrcPositions.create.useMutation({
    onSuccess: async () => {
      setName("");
      setOverseesAll(false);
      setError(null);
      await utils.jcrcPositions.list.invalidate();
    },
    onError: (e) => setError(positionsErrorCopy(e.message)),
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">JCRC positions</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Who looks after which CCAs. A position only sets what &ldquo;My
          positions&rdquo; shows on the CCAs, Points and Events pages; it never
          limits what anyone on the JCRC can do. Someone with no position sees
          every CCA.
        </p>
      </header>

      {mine.data && mine.data.positions.length > 0 && (
        <HandoverPanel mine={mine.data} />
      )}

      <section className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">Add a position</h2>
        <form
          className="mt-2 flex flex-wrap items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() === "") return;
            create.mutate({ name: name.trim(), overseesAll });
          }}
        >
          <Input
            aria-label="New position name"
            placeholder="e.g. Sports Director (Internal)"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-72"
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="new-oversees-all"
              checked={overseesAll}
              onCheckedChange={(v) => setOverseesAll(v === true)}
            />
            <label htmlFor="new-oversees-all" className="text-sm text-gray-700">
              Oversees every CCA
            </label>
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={create.isPending || name.trim() === ""}
          >
            Add
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>

      {list.isPending ? (
        <div className="h-48 animate-pulse rounded-xl bg-gray-100" />
      ) : list.error ? (
        <p className="text-sm text-red-700">
          Couldn&rsquo;t load the positions. Reload the page.
        </p>
      ) : list.data.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">
          No positions yet. Until there are, everyone on the JCRC sees every
          CCA.
        </p>
      ) : (
        <ul className="space-y-4">
          {list.data.map((p) => (
            <PositionCard
              key={p.id}
              position={p}
              members={members.data ?? []}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
