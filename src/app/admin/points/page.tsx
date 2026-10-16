"use client";

import { api } from "~/trpc/react";
import { useCapabilities } from "~/app/admin/_components/AdminCapabilityContext";
import DefaultRangesForm from "./_components/DefaultRangesForm";
import EntrySwitchPanel from "./_components/EntrySwitchPanel";
import WaiversPanel from "./_components/WaiversPanel";

/**
 * JCRC's CCA points-entry configuration: the open/closed switch, the default
 * allowed mean/SD ranges and per-CCA waivers.
 *
 * CONFIG ONLY. No score, matric or roster passes through this page or the
 * procedures behind it — leaders enter points in their own browser. The
 * capability gate below is cosmetic (the layout guards the route and every
 * ccaPoints procedure re-checks `manageCcaPointsRanges`); hiding UI is never a
 * guard. No toasts: the Toaster is not mounted, so results are stated inline.
 */
export default function AdminPointsPage() {
  const cap = useCapabilities();
  const { data, isLoading, refetch } = api.ccaPoints.getConfig.useQuery(
    undefined,
    { enabled: cap.manageCcaPointsRanges },
  );
  const utils = api.useUtils();
  // Re-read from the server after every write; nothing renders optimistically.
  const refresh = async () => {
    await utils.ccaPoints.getConfig.invalidate();
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Points</h1>
        <p className="mt-1 text-sm text-gray-500">
          Control when CCA heads can export their points, and how tightly their
          scores must be spread. Scores themselves never come to the server.
        </p>
      </header>

      {!cap.manageCcaPointsRanges ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
          You don&rsquo;t have access to the points settings.
        </p>
      ) : isLoading ? (
        <div
          className="space-y-6"
          role="status"
          aria-label="Loading the points settings"
        >
          <div className="h-40 animate-pulse rounded-xl bg-white shadow-lg" />
          <div className="h-56 animate-pulse rounded-xl bg-white shadow-lg" />
        </div>
      ) : !data ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3"
          role="alert"
        >
          <p className="text-sm text-red-800">
            Couldn&rsquo;t read the points settings.{" "}
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded font-medium underline underline-offset-2 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              Retry
            </button>
          </p>
        </div>
      ) : (
        <>
          <EntrySwitchPanel entryOpen={data.entryOpen} onChanged={refresh} />
          <DefaultRangesForm
            effective={data.effectiveDefault}
            hasRow={data.defaultRange !== null}
            builtIn={data.builtInDefault}
            onChanged={refresh}
          />
          <WaiversPanel
            overrides={data.overrides}
            effectiveDefault={data.effectiveDefault}
            onChanged={refresh}
          />
        </>
      )}
    </div>
  );
}
