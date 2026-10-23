"use client";

import { api } from "~/trpc/react";
import { useCapabilities } from "~/app/admin/_components/AdminCapabilityContext";
import BundleExport from "./_components/BundleExport";
import CcaSettingsPanel from "./_components/CcaSettingsPanel";
import DefaultRangesForm from "./_components/DefaultRangesForm";
import EntrySwitchPanel from "./_components/EntrySwitchPanel";
import FlatCcasPanel from "./_components/FlatCcasPanel";
import NewYearPanel from "./_components/NewYearPanel";
import { hasSavedRanges } from "./_components/rangeForm";
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
  const { data, isLoading, isError, refetch } =
    api.ccaPoints.getConfig.useQuery(undefined, {
      enabled: cap.manageCcaPointsRanges,
    });
  // Re-read from the server after every write; nothing renders optimistically.
  // Resolves false when the re-read failed, so a panel can say its data is stale.
  const refresh = async (): Promise<boolean> => {
    try {
      await refetch({ throwOnError: true });
      return true;
    } catch {
      return false;
    }
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
          {isError && (
            <div
              className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
              role="alert"
            >
              <p className="text-sm text-amber-900">
                Couldn&rsquo;t reload the latest settings, so what is shown may
                be out of date.{" "}
                <button
                  type="button"
                  onClick={() => void refetch()}
                  className="rounded font-medium underline underline-offset-2 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  Retry
                </button>
              </p>
            </div>
          )}
          <EntrySwitchPanel entryOpen={data.entryOpen} onChanged={refresh} />
          <DefaultRangesForm
            effective={data.effectiveDefault}
            hasRow={hasSavedRanges(data.defaultRange)}
            builtIn={data.builtInDefault}
            onChanged={refresh}
          />
          <WaiversPanel
            overrides={data.overrides}
            effectiveDefault={data.effectiveDefault}
            onChanged={refresh}
          />
          <CcaSettingsPanel ccas={data.ccas} onChanged={refresh} />
          <section className="rounded-xl bg-white p-6 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="max-w-xl">
                <h3 className="text-sm font-semibold text-gray-900">
                  Sandbox bundle
                </h3>
                <p className="mt-1 text-xs text-gray-500">
                  One file for the points sandbox: the ranges and waivers, every
                  CCA with its type (and, for sports, its IHG result and cap),
                  and the flat-points members.
                </p>
              </div>
              <BundleExport />
            </div>
          </section>
          <FlatCcasPanel flatCcas={data.flatCcas} onChanged={refresh} />
          <NewYearPanel
            ihgResultCount={data.ihgResultsStored}
            entryOpen={data.entryOpen}
            onChanged={refresh}
          />
        </>
      )}
    </div>
  );
}
