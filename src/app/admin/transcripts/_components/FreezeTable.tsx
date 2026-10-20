"use client";

import { errorText, unmatchedLine } from "~/lib/transcript/adminView";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import { ErrorLine } from "./Bits";

export interface FreezeRowView {
  ccaID: number;
  ccaName: string;
  category: string;
  /** "Saved when transcripts opened", or "Not saved". */
  state: string;
  locked: boolean;
  frozenAt: Date | string | null;
  frozenByName: string | null;
  memberCount: number | null;
  /** Members the resolver could not match when the list was saved. */
  unresolvedCount?: number | null;
  /** Who they were: the raw key, or the names of the accounts claiming it. */
  unresolvedMembers?: ReadonlyArray<{ key: string; names: readonly string[] }>;
}

/** Shown while the year is still collecting but some lists are already saved. */
export const PARTLY_SAVED_NOTE =
  "Some CCAs are saved; press Open transcripts again to finish.";

/**
 * Whether the member-list table is drawn at all: an open year always shows it;
 * a collecting year only once some list is saved, or when loading failed (so
 * the error is never hidden).
 */
export function showFreezeTable(p: {
  published: boolean;
  hasError: boolean;
  rows: ReadonlyArray<{ locked: boolean }>;
}): boolean {
  return p.published || p.hasError || p.rows.some((r) => r.locked);
}

export interface FreezeTableViewProps {
  rows: FreezeRowView[];
  loadError: string | null;
  /** The year is not open yet, but Open transcripts saved some lists. */
  partlySaved?: boolean;
}

/**
 * "CCA member lists" for an open year: each CCA's list as it was saved when
 * transcripts opened, how many members it holds, and how many roster rows
 * could not be matched to a person. Read-only: nothing here changes a list.
 */
export function FreezeTableView(p: FreezeTableViewProps) {
  return (
    <div className="mt-8 border-t border-gray-100 pt-5">
      <h3 className="text-sm font-semibold text-gray-900">CCA member lists</h3>
      <p className="mt-1 max-w-2xl text-xs text-gray-500">
        Each CCA&rsquo;s member list was saved when transcripts opened, so later
        recruitment does not change the transcripts.
      </p>
      {p.partlySaved && (
        <p className="mt-2 text-sm text-amber-800" role="status">
          {PARTLY_SAVED_NOTE}
        </p>
      )}
      <ErrorLine message={p.loadError} />

      {p.rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">No CCAs.</p>
      ) : (
        <div className="relative mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] divide-y divide-gray-200 text-left text-sm">
            <thead>
              <tr className="text-xs font-medium text-gray-700">
                <th scope="col" className="px-2 py-2">
                  CCA
                </th>
                <th scope="col" className="px-2 py-2">
                  State
                </th>
                <th scope="col" className="px-2 py-2">
                  Date
                </th>
                <th scope="col" className="px-2 py-2">
                  Members
                </th>
                <th scope="col" className="px-2 py-2">
                  Not matched
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {p.rows.map((r) => (
                <tr key={r.ccaID}>
                  <td className="px-2 py-2 font-medium text-gray-900">
                    {r.ccaName}
                  </td>
                  <td className="px-2 py-2">{r.state}</td>
                  <td className="whitespace-nowrap px-2 py-2">
                    {r.frozenAt ? formatSgDate(r.frozenAt) : ""}
                  </td>
                  <td className="px-2 py-2">{r.memberCount ?? ""}</td>
                  <td className="px-2 py-2">
                    {r.unresolvedCount ? (
                      <span className="text-amber-800">
                        {unmatchedLine(
                          r.unresolvedCount,
                          r.unresolvedMembers ?? [],
                        )}
                      </span>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function FreezeTable({
  academicYear,
  published,
}: {
  academicYear: string;
  /** The year is open. While collecting, the table shows only if some list is saved. */
  published: boolean;
}) {
  const list = api.transcript.freezes.list.useQuery(
    { academicYear },
    { enabled: academicYear !== "", retry: false },
  );
  const rows: FreezeRowView[] = (list.data?.rows ?? []).map((r) => ({
    ccaID: r.ccaID,
    ccaName: r.ccaName,
    category: r.category,
    state: r.state,
    locked: r.locked,
    frozenAt: r.frozenAt,
    frozenByName: r.frozenByName,
    memberCount: r.memberCount,
    unresolvedCount: r.unresolvedCount,
    unresolvedMembers: r.unresolvedMembers,
  }));
  if (!showFreezeTable({ published, hasError: Boolean(list.error), rows })) {
    return null;
  }
  return (
    <FreezeTableView
      rows={rows}
      loadError={list.error ? errorText(list.error.message) : null}
      partlySaved={!published}
    />
  );
}
