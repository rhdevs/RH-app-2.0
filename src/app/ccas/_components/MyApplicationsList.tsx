"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, ChevronRight, MapPin } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { formatSlot, statusBadgeClass, statusLabel } from "../_lib/status";
import SlotPicker from "./SlotPicker";

type MyApp =
  RouterOutputs["ccaApplications"]["myApplications"]["applications"][number];

export default function MyApplicationsList() {
  const q = api.ccaApplications.myApplications.useQuery(undefined, {
    retry: false,
  });

  if (q.isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg bg-gray-200" />
        ))}
      </div>
    );
  }

  if (q.error) {
    if (q.error.message === "CCA_APPLICATIONS_DISABLED") {
      return (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
          CCA applications aren&rsquo;t open right now.
        </p>
      );
    }
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800">
        These couldn&rsquo;t be loaded. Reload the page.
      </p>
    );
  }

  if (q.data.applications.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-900">No applications yet</p>
        <Link
          href="/ccas"
          className="mt-2 inline-block text-sm font-medium text-emerald-700"
        >
          Browse CCAs →
        </Link>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {q.data.applications.map((a) => (
        <MyApplicationRow key={a.applicationID} app={a} />
      ))}
    </ul>
  );
}

function MyApplicationRow({ app }: { app: MyApp }) {
  const utils = api.useUtils();
  const [picking, setPicking] = useState(false);

  const scheduled = app.status === "interview_scheduled";
  const canBook = app.status === "submitted";

  const refresh = async () => {
    await Promise.all([
      utils.ccaApplications.myApplications.invalidate(),
      utils.ccaApplications.availableSlots.invalidate({ ccaID: app.ccaID }),
    ]);
  };

  const cancelSlot = api.ccaApplications.cancelSlot.useMutation({
    onSuccess: refresh,
  });

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/ccas/${app.ccaID}`}
          className="group inline-flex items-center gap-1 font-medium text-gray-900 hover:text-emerald-700"
        >
          {app.ccaName ?? `CCA #${app.ccaID}`}
          <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-emerald-600" />
        </Link>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
            app.status,
          )}`}
        >
          {statusLabel(app.status)}
        </span>
      </div>

      {/* Booked interview */}
      {scheduled && app.slot && (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="h-4 w-4 text-gray-400" />
            {formatSlot(app.slot.startTime, app.slot.endTime)}
          </span>
          {app.slot.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5 text-gray-400" />
              {app.slot.location}
            </span>
          )}
        </p>
      )}

      {app.status === "rejected" && app.decisionReason && (
        <p className="mt-2 text-sm text-gray-600">{app.decisionReason}</p>
      )}

      {/* Interview scheduling controls — the point of this view: change your
          timeslot without leaving the page. */}
      {(scheduled || canBook) && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          {picking ? (
            <SlotPicker
              ccaID={app.ccaID}
              applicationID={app.applicationID}
              currentSlotID={app.interviewSlotID}
              onDone={async () => {
                setPicking(false);
                await refresh();
              }}
              onCancel={() => setPicking(false)}
            />
          ) : scheduled ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => setPicking(true)}>
                Reschedule
              </Button>
              <button
                onClick={() =>
                  cancelSlot.mutate({ applicationID: app.applicationID })
                }
                disabled={cancelSlot.isPending}
                className="text-sm font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
              >
                {cancelSlot.isPending ? "Cancelling…" : "Cancel interview"}
              </button>
            </div>
          ) : (
            <Button
              onClick={() => setPicking(true)}
              className="inline-flex items-center gap-1.5"
            >
              <CalendarClock className="h-4 w-4" /> Book an interview
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
