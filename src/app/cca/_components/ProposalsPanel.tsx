"use client";

import Link from "next/link";
import { Plus } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  isProposalCategory,
  PROPOSAL_CATEGORY_LABELS,
} from "~/lib/proposals/categories";
import {
  isProposalStatus,
  PROPOSAL_STATUS_LABELS,
} from "~/lib/proposals/status";
import { unreadLabel } from "~/lib/proposals/unreadText";

/**
 * A CCA's proposals, newest edit first. NOT a guard: the list procedure checks
 * the flag and that the caller heads (or directs) THIS CCA. Everything the
 * server sends is rendered as React text.
 *
 * While the flag is off, or until it is known to be on, the screen says so in
 * one line and asks for nothing else.
 */
export default function ProposalsPanel({ ccaID }: { ccaID: number }) {
  const enabled = api.proposal.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const list = api.proposal.list.useQuery(
    { ccaID },
    { retry: false, enabled: on },
  );

  if (enabled.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Proposals are not switched on yet.
      </p>
    );
  }
  if (list.isLoading) {
    return <p className="text-sm text-gray-500">Loading proposals…</p>;
  }
  if (list.isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load the proposals. Try again shortly.
      </p>
    );
  }

  const items = list.data?.items ?? [];
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Proposals</h2>
        <Button asChild size="sm">
          <Link href={`/cca/${ccaID}/proposals/new`}>
            <Plus /> New proposal
          </Link>
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
          No proposals yet. Start one when your CCA plans something.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
          {items.map((p) => (
            <li key={p.id}>
              <Link
                href={`/cca/${ccaID}/proposals/${p.id}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900">
                    {p.title}
                  </span>
                  <span className="block text-xs text-gray-500">
                    {isProposalCategory(p.category)
                      ? PROPOSAL_CATEGORY_LABELS[p.category]
                      : "Proposal"}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {unreadLabel(p.unread) && (
                    <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
                      {unreadLabel(p.unread)}
                    </span>
                  )}
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                    {isProposalStatus(p.status)
                      ? PROPOSAL_STATUS_LABELS[p.status]
                      : "Unknown"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
