"use client";

import { useMemo } from "react";
import { useSession } from "next-auth/react";

import { api } from "~/trpc/react";
import { TooltipProvider } from "~/components/ui/tooltip";
import type { RosterMember } from "~/lib/points/draft";
import Workbench from "./Workbench";

/**
 * Loads the two head-gated READS this page needs and nothing else:
 * ccaPoints.getEntryContext (open/closed + allowed range) and
 * cca.memberDirectory (who is on the roster, with matrics). Scores never travel
 * in either direction — they are typed, checked and exported in this browser.
 *
 * No background refetch: a refetched roster would re-run the draft merge, and
 * the page must never swap rows out from under someone mid-typing.
 */
const QUERY_OPTS = { retry: false, refetchOnWindowFocus: false } as const;

function Skeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading points entry">
      <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
      <div className="h-4 w-80 max-w-full animate-pulse rounded bg-gray-100" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="h-96 animate-pulse rounded-lg bg-white shadow" />
        <div className="hidden h-96 animate-pulse rounded-xl bg-white shadow lg:block" />
      </div>
    </div>
  );
}

function Problem({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {message}{" "}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export default function PointsWorkbench({ ccaID }: { ccaID: number }) {
  const { data: session, status } = useSession();
  const context = api.ccaPoints.getEntryContext.useQuery({ ccaID }, QUERY_OPTS);
  const directory = api.cca.memberDirectory.useQuery({ ccaID }, QUERY_OPTS);

  // Stable roster identity, keyed on content, so the draft merge runs once per
  // real roster change and not on every render.
  const rosterKey = JSON.stringify(
    directory.data?.entries.map((e) => [
      e.rowKey,
      e.matric,
      e.name,
      e.resolved,
      e.role,
    ]) ?? [],
  );
  const roster = useMemo<RosterMember[]>(
    () =>
      (
        JSON.parse(rosterKey) as [
          string,
          string | null,
          string | null,
          boolean,
          "Head" | "Member",
        ][]
      ).map(([rowKey, matric, name, resolved, role]) => ({
        rowKey,
        matric,
        name,
        resolved,
        role,
      })),
    [rosterKey],
  );

  const failed = context.error ?? directory.error;
  if (failed) {
    if (failed.data?.code === "FORBIDDEN") {
      return <Problem message="Only this CCA's heads can enter points." />;
    }
    return (
      <Problem
        message="Couldn't load points entry."
        onRetry={() => {
          void context.refetch();
          void directory.refetch();
        }}
      />
    );
  }
  if (!context.data || !directory.data || status === "loading")
    return <Skeleton />;

  return (
    <TooltipProvider delayDuration={200}>
      <Workbench
        ccaID={ccaID}
        ccaName={directory.data.cca.ccaName ?? `CCA ${ccaID}`}
        roster={roster}
        userID={session?.user?.userID ?? null}
        context={context.data}
      />
    </TooltipProvider>
  );
}
