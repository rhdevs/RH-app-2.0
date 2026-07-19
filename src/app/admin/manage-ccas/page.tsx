"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import CreateCcaForm from "./_components/CreateCcaForm";
import ManageCcaDetail from "./_components/ManageCcaDetail";

/**
 * CCA management. Admin only (enforced by ./layout.tsx and again in every
 * procedure), and behind the `cca.management.enabled` kill switch.
 *
 * THERE IS NO DELETE AFFORDANCE ANYWHERE ON THIS PAGE, and no delete procedure
 * behind it. Deleting a CCA cascades into Bookings by ccaID — see the guards in
 * services/cascade.ts before you consider adding one.
 */
export default function ManageCcasPage() {
  const [selected, setSelected] = useState<number | null>(null);
  const { data, isPending, error } = api.ccaAdmin.listAll.useQuery(undefined, {
    retry: false,
  });

  if (isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded bg-gray-200" />
        <div className="h-64 animate-pulse rounded-lg bg-gray-200" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6">
        <p className="text-sm font-medium text-red-900">
          The CCA list couldn&rsquo;t be loaded
        </p>
        <p className="mt-1 text-sm text-red-700">Reload the page.</p>
      </div>
    );
  }

  const { ccas, enabled } = data;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Manage CCAs</h1>
        <p className="mt-1 text-sm text-gray-500">
          Create and rename CCAs, manage their heads, and add or remove members.
        </p>
      </header>

      {/* The switch state is shown, not hidden: an admin who finds every button
          disabled deserves to know why and what to do about it. */}
      {!enabled && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            CCA management is turned off
          </p>
          <p className="mt-1 text-sm text-amber-800">
            You can look, but nothing can be changed yet. To turn it on, set the{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">
              cca.management.enabled
            </code>{" "}
            system flag to{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">on</code>.
          </p>
        </div>
      )}

      <CreateCcaForm enabled={enabled} />

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          All CCAs
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
            {ccas.length}
          </span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Heads</TableHead>
                <TableHead
                  className="text-right"
                  title="Membership records, not distinct people — duplicates are possible and are named in the roster."
                >
                  Records
                </TableHead>
                <TableHead className="text-right">ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ccas.map((c) => (
                <TableRow
                  key={c.ccaID}
                  onClick={() =>
                    setSelected(selected === c.ccaID ? null : c.ccaID)
                  }
                  className={`cursor-pointer ${
                    selected === c.ccaID ? "bg-emerald-50" : ""
                  }`}
                >
                  <TableCell className="font-medium text-gray-900">
                    {c.ccaName}
                  </TableCell>
                  <TableCell className="text-gray-600">{c.category}</TableCell>
                  <TableCell className="text-right text-gray-600">
                    {c.headCount === 0 ? (
                      <span
                        className="text-amber-700"
                        title="This CCA has no head. Members can still be listed, but nobody can view its roster from /cca."
                      >
                        0
                      </span>
                    ) : (
                      c.headCount
                    )}
                  </TableCell>
                  <TableCell className="text-right text-gray-600">
                    {c.membershipRows}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-gray-400">
                    {c.ccaID}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Select a CCA to manage its heads and members.
        </p>
      </section>

      {selected !== null && (
        <ManageCcaDetail
          key={selected}
          ccaID={selected}
          enabled={enabled}
          cca={ccas.find((c) => c.ccaID === selected)!}
        />
      )}
    </div>
  );
}
