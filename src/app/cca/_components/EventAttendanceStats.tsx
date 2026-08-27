"use client";

import { api } from "~/trpc/react";

/**
 * The head's turnout panel. A SEPARATE component mounted beside EventAnalytics
 * rather than folded into it, mirroring the server split: `getSignupStats` is
 * Phase 1 behaviour and keeps working with the door layer switched off, and one
 * component reading both queries would fail together.
 *
 * RENDERS NOTHING AT ALL WHEN ATTENDANCE IS OFF. With the flag absent — the
 * state this feature ships in — the head's page should show nothing about
 * attendance: not an error, not an empty chart, not a zero. A zero is a claim,
 * and "nobody came" is a different fact from "we were not counting".
 *
 * WITH THE FLAG ON BUT THE SECRET MISSING, the head IS told, and told WHICH
 * thing is wrong — "attendance doesn't work" sends them to the wrong person,
 * while naming the environment variable reaches whoever can actually set it.
 */
export default function EventAttendanceStats({ eventID }: { eventID: number }) {
  // Reuses Part C's per-event status query rather than adding a second one. It
  // already distinguishes the two failure modes: `enabled` is the flag, and
  // `configured` is EVENT_QR_SECRET.
  const status = api.event.attendanceStatus.useQuery(
    { eventID },
    { retry: false },
  );
  const stats = api.event.getAttendanceStats.useQuery(
    { eventID },
    { retry: false, enabled: status.data?.enabled === true },
  );

  if (status.isPending) return null;
  // A failed status read is not an occasion to assert anything about turnout.
  if (status.error || !status.data) return null;
  if (!status.data.enabled) return null;

  if (!status.data.configured) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
        <p className="text-sm text-amber-900">
          Door check-in is switched on for the hall, but this deployment has no{" "}
          <code className="rounded bg-amber-100 px-1">EVENT_QR_SECRET</code>{" "}
          set, so nobody can scan. Whoever looks after the deployment needs to
          set it and redeploy.
        </p>
      </div>
    );
  }

  if (stats.isPending) {
    return <div className="h-24 animate-pulse rounded-lg bg-gray-100" />;
  }
  if (stats.error || !stats.data) return null;

  const s = stats.data;

  // "—", NEVER "0%". An event where nobody opened the door page has NO DATA,
  // which is a different fact from nobody turning up — and a 0% printed next to
  // a well-attended event is a defamatory number about a CCA.
  const turnout =
    s.checkedIn === 0
      ? "—"
      : s.signedUp === 0
        ? "—"
        : `${Math.round((s.turnedUp / s.signedUp) * 100)}%`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Signed up" value={String(s.signedUp)} />
        <Stat label="Checked in" value={String(s.checkedIn)} />
        <Stat label="Walk-ins" value={String(s.walkIns)} />
        <Stat label="Turnout" value={turnout} />
      </div>

      {s.checkedIn === 0 ? (
        <p className="text-sm text-gray-500">
          Nobody has been scanned in yet. If the event has already happened and
          the door was never opened, there&rsquo;s no attendance to show —
          that&rsquo;s different from nobody coming.
        </p>
      ) : (
        <p className="text-xs text-gray-400">
          {s.byMethod.qr} scanned · {s.byMethod.manual} ticked off the list
        </p>
      )}

      {s.noShows.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-900">
            Signed up, not scanned ({s.noShows.length})
          </h4>
          <p className="mt-1 text-xs text-gray-500">
            Useful for chasing your own members. It is not a record anyone else
            sees.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {s.noShows.map((n) => (
              <li key={n.userID} className="text-sm text-gray-700">
                {n.displayName ?? n.userID}
                {n.block !== null ? (
                  <span className="text-gray-400"> · Block {n.block}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        D-77, AND IT IS ON THE SCREEN ON PURPOSE. A number acquires a
        consequence the moment somebody assumes it has one, and the screen is
        the thing best placed to correct that assumption before it spreads.
      */}
      <p className="border-t border-gray-100 pt-3 text-xs text-gray-400">
        Attendance is for your own records. It doesn&rsquo;t affect anyone&rsquo;s
        signups, priority or standing anywhere in RHApp, and no export pairs a
        name with a no-show.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
        {value}
      </p>
    </div>
  );
}
