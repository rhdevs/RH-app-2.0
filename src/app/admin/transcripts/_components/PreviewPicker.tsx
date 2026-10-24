"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { yearOptions } from "~/lib/transcript/adminView";
import { yearToParam } from "~/lib/transcript/assemble";
import { api } from "~/trpc/react";
import { SectionCard, YearSelect } from "./Bits";
import ResidentPicker, { type PickedResident } from "./ResidentPicker";

/** Where the preview of one resident's transcript lives. */
export function previewHref(userID: string, academicYear: string): string {
  return `/admin/transcripts/preview/${encodeURIComponent(userID)}?ay=${yearToParam(academicYear)}`;
}

export function PreviewPickerView({
  years,
  year,
  onYear,
  picker,
  href,
}: {
  years: string[];
  year: string;
  onYear: (year: string) => void;
  picker: ReactNode;
  /** Null until a resident is chosen. */
  href: string | null;
}) {
  return (
    <SectionCard
      title="Preview a transcript"
      description="See a resident's transcript as it would be assembled now. Nothing is issued and residents cannot see it."
    >
      <div className="space-y-4">
        <YearSelect
          id="preview-year"
          label="Academic year"
          value={year}
          options={years}
          onChange={onYear}
        />
        {picker}
        {href ? (
          <Link
            href={href}
            className="inline-flex h-9 items-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            Open preview
          </Link>
        ) : (
          <p className="text-xs text-gray-500">
            Choose a resident to open a preview.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

export default function PreviewPicker() {
  const periods = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const [year, setYear] = useState<string | null>(null);
  const [resident, setResident] = useState<PickedResident | null>(null);

  const current = periods.data?.currentAcademicYear ?? "";
  const selected = year ?? current;
  if (periods.isPending) {
    return (
      <div
        className="h-40 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }

  return (
    <PreviewPickerView
      years={yearOptions(periods.data?.periods ?? [], current)}
      year={selected}
      onYear={setYear}
      picker={
        <ResidentPicker
          idPrefix="preview"
          selected={resident}
          onSelect={setResident}
          onClear={() => setResident(null)}
        />
      }
      href={resident ? previewHref(resident.userID, selected) : null}
    />
  );
}
