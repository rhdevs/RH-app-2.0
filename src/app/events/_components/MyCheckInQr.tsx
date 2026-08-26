"use client";

import { QRCodeSVG } from "qrcode.react";

import { api } from "~/trpc/react";
import {
  QR_REFRESH_MS,
  buildCheckInPayload,
} from "~/lib/schemas/eventAttendance";

/**
 * The resident's rotating check-in code.
 *
 * WHY IT ROTATES. A static code is a bearer credential: screenshot it once, send
 * it to a friend, and they are marked present at every event for the rest of the
 * year. This one is an HMAC over a 30-second window, so a forwarded screenshot
 * is dead before it arrives. The cost is real and worth stating: the resident
 * needs to be ONLINE at the door to hold a live code, and the answer for a flat
 * battery or no signal is the committee's manual list, not a longer-lived token.
 *
 * IMPORTS FROM `~/lib/schemas/eventAttendance` AND NOT FROM THE SIGNING MODULE.
 * `services/eventQr.ts` imports `~/env` and `node:crypto` at module scope and
 * therefore cannot be reached from a `"use client"` file at all. The secret
 * never leaves the server; what arrives here is one already-signed 32-character
 * tag with a 30-second life.
 */
export default function MyCheckInQr({ className }: { className?: string }) {
  const token = api.event.myCheckInToken.useQuery(undefined, {
    // Refetch a little before the 30-second window closes. The verifier also
    // accepts the PREVIOUS window, so a scan landing in the gap still works and
    // a slow round trip is not a failed check-in.
    //
    // AND STOP POLLING ONCE IT HAS FAILED. Both kill switches are asserted
    // server-side on every call, so on a deployment where the door layer is off
    // — which is the state this feature SHIPS IN — a fixed interval would poll
    // a guaranteed refusal three times a minute, forever, on the busiest screen
    // in the app, and each refusal costs two uncached SystemFlag reads because
    // the flag cache's TTL is shorter than the interval.
    refetchInterval: (q) => (q.state.error ? false : QR_REFRESH_MS),
    refetchOnWindowFocus: true,
    retry: false,
  });

  // NOTHING WHILE IT LOADS, deliberately: a 200px placeholder that appears and
  // then vanishes on every deployment where attendance is off is a worse
  // artefact than the code arriving a moment late.
  if (token.isPending) return null;

  if (token.error || !token.data) {
    const why = token.error?.message ?? "";
    // THE FEATURE BEING OFF IS NOT AN ERROR AND MUST RENDER NOTHING. It ships
    // dark: the flag row is absent until somebody deliberately creates it, so
    // this branch is the DEFAULT state at merge, on the event page of every
    // resident who is signed up for anything. Telling all of them about a
    // check-in code that does not exist yet is a feature announcing itself
    // while switched off — the same ruling the analytics side already carries.
    if (why === "ATTENDANCE_DISABLED" || why === "EVENTS_DISABLED") return null;
    // A CONFIGURATION FAULT IS DIFFERENT and does get a line: the flag is ON,
    // so there may well be somebody at a door expecting to scan them, and they
    // need to know to ask for the list instead.
    return (
      <div className={className}>
        <p className="text-sm text-gray-500">
          Check-in codes aren&rsquo;t available right now. The people running the
          event can still tick you off their list at the door.
        </p>
      </div>
    );
  }

  const { userID, token: tag } = token.data;

  return (
    <div className={className}>
      <div className="flex flex-col items-center gap-3">
        <div className="rounded-lg bg-white p-3 ring-1 ring-gray-200">
          {/*
            Level M rather than L. The payload is ~45 bytes, so M still fits a
            version-3 symbol, and the extra redundancy is what lets it decode
            off a slightly dirty or angled phone screen across a table — which
            is the actual reading condition at a door.
          */}
          <QRCodeSVG
            value={buildCheckInPayload(userID, tag)}
            size={200}
            level="M"
            marginSize={2}
          />
        </div>
        <p className="text-center text-sm text-gray-600">
          Show this to whoever is on the door.
        </p>
        {/* NO COUNTDOWN, AND THAT IS THE POINT. A ticking number invites people
            to snatch the phone back and wait for a "fresh" code, which is the
            one thing that makes a queue stall. The refresh is silent and the
            scanner accepts the previous window anyway, so a code that looks old
            still works. */}
        <p className="text-center text-xs text-gray-400">
          It refreshes every few seconds — that&rsquo;s normal.
        </p>
      </div>
    </div>
  );
}
