"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  serializeCsv,
  downloadTextFile,
  formatDateTime,
} from "~/app/events/_lib/format";

/**
 * The attendee list for the head's monitor page, plus the audited CSV export.
 *
 * The on-screen table uses the (un-audited) getAttendees query — the head is
 * already authorised to see it. The DOWNLOAD calls the exportAttendees mutation,
 * which writes an event.attendees.export audit row (the file carries matric /
 * block / telegram — PII), and builds the CSV from what it returns.
 */
export default function EventAttendees({ eventID }: { eventID: number }) {
  const list = api.event.getAttendees.useQuery({ eventID }, { retry: false });
  const [exporting, setExporting] = useState(false);
  const exportMut = api.event.exportAttendees.useMutation();

  async function download() {
    setExporting(true);
    try {
      const res = await exportMut.mutateAsync({ eventID });
      const rows: (string | number | null)[][] = [
        ["Name", "Matric", "Block", "Telegram", "Signed up at"],
        ...res.attendees.map((a) => [
          a.displayName ?? "",
          a.matric ?? "",
          a.block ?? "",
          a.telegramHandle ? `@${a.telegramHandle}` : "",
          a.signedUpAt ? new Date(a.signedUpAt).toISOString() : "",
        ]),
      ];
      downloadTextFile(
        `attendees-event-${res.eventID}.csv`,
        serializeCsv(rows),
      );
    } catch {
      // surfaced below via exportMut.error
    } finally {
      setExporting(false);
    }
  }

  if (list.isPending) {
    return <div className="h-32 animate-pulse rounded-lg bg-gray-100" />;
  }
  if (list.error || !list.data) {
    return <p className="text-sm text-gray-500">Attendees couldn’t load.</p>;
  }

  const attendees = list.data.attendees;
  const missingMatric = attendees.filter((a) => !a.matric).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">
          {attendees.length} attendee{attendees.length === 1 ? "" : "s"}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={exporting || attendees.length === 0}
          onClick={download}
        >
          <Download className="mr-1.5 h-4 w-4" />
          {exporting ? "Preparing…" : "Download CSV"}
        </Button>
      </div>

      {missingMatric > 0 && (
        <p className="text-xs text-amber-700">
          {missingMatric} attendee{missingMatric === 1 ? "" : "s"} have no matric
          on file — those cells will be blank.
        </p>
      )}

      {attendees.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-500">
          No signups yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Matric</th>
                <th className="px-4 py-2 font-medium">Block</th>
                <th className="px-4 py-2 font-medium">Telegram</th>
                <th className="px-4 py-2 font-medium">Signed up</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {attendees.map((a) => (
                <tr key={a.userID}>
                  <td className="px-4 py-2 text-gray-900">
                    {a.displayName ?? a.userID}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-gray-700">
                    {a.matric ?? (
                      <span className="text-amber-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-gray-700">
                    {a.block ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {a.telegramHandle ? `@${a.telegramHandle}` : "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-500">
                    {a.signedUpAt ? formatDateTime(
                      Math.floor(new Date(a.signedUpAt).getTime() / 1000),
                    ) : "—"}
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
