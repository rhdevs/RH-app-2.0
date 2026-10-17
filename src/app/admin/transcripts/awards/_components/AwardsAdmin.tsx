"use client";

import { useCallback, useState } from "react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import {
  WRITES_LOCKED_NOTE,
  errorText,
  isWritable,
  yearOptions,
} from "~/lib/transcript/adminView";
import { useUnsavedChangesGuard } from "~/lib/transcript/useUnsavedChangesGuard";
import { api } from "~/trpc/react";
import { ErrorLine, SectionCard, YearSelect } from "../../_components/Bits";
import AssignAward from "./AssignAward";
import AwardCatalogue from "./AwardCatalogue";
import AwardHistory from "./AwardHistory";
import AwardImport from "./AwardImport";
import AwardsList from "./AwardsList";

export const AWARD_TABS = [
  { value: "awards", label: "Awards" },
  { value: "catalogue", label: "Catalogue" },
  { value: "import", label: "Import" },
  { value: "history", label: "History" },
] as const;
export type AwardTab = (typeof AWARD_TABS)[number]["value"];

/**
 * /admin/transcripts/awards: awards by year, the catalogue, and the history of
 * uploads. The year and the tab can only change after unsaved typing is
 * confirmed away (and a reload asks too).
 */
export default function AwardsAdmin() {
  const periods = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<AwardTab>("awards");
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const isDirty = Object.values(dirty).some(Boolean);
  const confirmLeave = useUnsavedChangesGuard(isDirty);

  const mark = useCallback(
    (name: string) => (value: boolean) =>
      setDirty((d) => (d[name] === value ? d : { ...d, [name]: value })),
    [],
  );
  const onAssignDirty = useCallback(mark("assign"), [mark]);
  const onListDirty = useCallback(mark("list"), [mark]);
  const onCatalogueDirty = useCallback(mark("catalogue"), [mark]);
  const onImportDirty = useCallback(mark("import"), [mark]);

  if (periods.isPending) {
    return (
      <div
        className="h-64 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }
  if (periods.error) {
    return (
      <SectionCard title="Awards">
        <ErrorLine message={errorText(periods.error.message)} />
      </SectionCard>
    );
  }

  const current = periods.data.currentAcademicYear;
  const year = picked ?? current;
  const status =
    periods.data.periods.find((x) => x.academicYear === year)?.status ?? null;
  const readOnly = !isWritable(status);

  // Leaving remounts the parts keyed by year (or unmounts the tab), and each
  // part clears its own dirty flag as it goes: nothing is wiped from here.
  const leave = () => confirmLeave();

  return (
    <div className="space-y-6">
      <SectionCard
        title="Awards"
        description="Awards from the end-of-year Colours Awards. They appear in the Awards section of each resident's transcript."
      >
        <YearSelect
          id="awards-year"
          label="Academic year"
          value={year}
          options={yearOptions(periods.data.periods, current)}
          onChange={(y) => {
            if (y !== year && leave()) setPicked(y);
          }}
        />
        {readOnly && (
          <p className="mt-3 text-sm text-amber-800" role="status">
            {WRITES_LOCKED_NOTE}
          </p>
        )}

        <Tabs
          value={tab}
          onValueChange={(v) => {
            if (v !== tab && leave()) setTab(v as AwardTab);
          }}
          className="mt-5"
        >
          <TabsList>
            {AWARD_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="awards" className="mt-5 space-y-6">
            <section aria-labelledby="assign-heading">
              <h3
                id="assign-heading"
                className="mb-3 text-sm font-semibold text-gray-900"
              >
                Assign an award
              </h3>
              <AssignAward
                key={year}
                academicYear={year}
                readOnly={readOnly}
                onDirty={onAssignDirty}
              />
            </section>
            <section aria-labelledby="awards-heading">
              <h3
                id="awards-heading"
                className="mb-3 border-t border-gray-100 pt-5 text-sm font-semibold text-gray-900"
              >
                Awards for {year}
              </h3>
              <AwardsList
                key={year}
                academicYear={year}
                readOnly={readOnly}
                onDirty={onListDirty}
              />
            </section>
          </TabsContent>

          <TabsContent value="catalogue" className="mt-5">
            <AwardCatalogue onDirty={onCatalogueDirty} />
          </TabsContent>

          <TabsContent value="import" className="mt-5">
            {readOnly ? (
              <p className="text-sm text-gray-600">
                Importing is not available while the year is published.
              </p>
            ) : null}
            <AwardImport
              key={year}
              academicYear={year}
              readOnly={readOnly}
              onDirty={onImportDirty}
              onOpenHistory={() => setTab("history")}
            />
          </TabsContent>

          <TabsContent value="history" className="mt-5">
            <AwardHistory academicYear={year} readOnly={readOnly} />
          </TabsContent>
        </Tabs>
      </SectionCard>
    </div>
  );
}
