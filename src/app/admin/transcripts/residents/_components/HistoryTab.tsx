"use client";

import { errorText } from "~/lib/transcript/adminView";
import {
  SELF_MADE_TAG,
  eventDetail,
  eventLabel,
} from "~/lib/transcript/residentView";
import { formatSgDate, instantToSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import { ErrorLine } from "../../_components/Bits";
import { Loading, SubHeading, Tag } from "./ResidentBits";

export interface HistoryItem {
  id: string;
  action: string;
  reason: string | null;
  summary: string | null;
  byName: string | null;
  /** The change was made by the resident themself (shown, never blocked). */
  selfMade?: boolean;
  at: Date | string | null;
}

/** Singapore date and time, "16 Oct 2026, 12:30". */
export function eventTime(at: Date | string | null): string {
  if (!at) return "";
  const d = new Date(at);
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${formatSgDate(instantToSgDate(d))}, ${hm}`;
}

const TONE: Record<string, "gray" | "amber" | "emerald"> = {
  unlock: "amber",
  withhold: "amber",
  relock: "gray",
  release: "emerald",
};

/** The timeline: what happened, why, who did it and when. Newest first. */
export function HistoryView({ items }: { items: HistoryItem[] }) {
  return (
    <section aria-labelledby="history-heading">
      <SubHeading id="history-heading">History</SubHeading>
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing has been changed for this resident and year.
        </p>
      ) : (
        <ol className="space-y-3 border-l-2 border-gray-200 pl-4">
          {items.map((e) => {
            const detail = eventDetail(e);
            return (
              <li key={e.id} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-gray-400"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone={TONE[e.action] ?? "gray"}>
                    {eventLabel(e.action)}
                  </Tag>
                  <span className="text-xs text-gray-500">
                    {eventTime(e.at)}
                    {e.byName ? ` by ${e.byName}` : ""}
                  </span>
                  {e.selfMade && (
                    <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                      {SELF_MADE_TAG}
                    </span>
                  )}
                </div>
                {detail && (
                  <p className="mt-1 text-sm text-gray-800">{detail}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default function HistoryTab({
  userID,
  academicYear,
}: {
  userID: string;
  academicYear: string;
}) {
  const history = api.transcriptManage.corrections.history.useQuery(
    { userID, academicYear },
    { retry: false },
  );
  if (history.isPending) return <Loading rows={3} />;
  if (history.error) {
    return <ErrorLine message={errorText(history.error.message)} />;
  }
  return <HistoryView items={history.data} />;
}
