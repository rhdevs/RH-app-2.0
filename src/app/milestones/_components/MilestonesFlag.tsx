"use client";

import { api } from "~/trpc/react";

/**
 * Renders its children only while `milestones.enabled` is on, and says so
 * plainly when it is off or cannot be checked. NOT a guard: every procedure
 * checks the flag itself.
 */
export default function MilestonesFlag({
  children,
}: {
  children: React.ReactNode;
}) {
  const enabled = api.milestone.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  if (enabled.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (enabled.isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not check whether milestones are switched on. Try again shortly.
      </p>
    );
  }
  if (enabled.data?.enabled !== true) {
    return (
      <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
        Milestones are not switched on yet.
      </p>
    );
  }
  return <>{children}</>;
}
