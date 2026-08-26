"use client";

import { useEffect, useState } from "react";
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
    refetchInterval: QR_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  // Re-render on a timer purely to age the "refreshes in Ns" line. The QR
  // itself only changes when the query returns a new token.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (token.isPending) {
    return (
      <div className={className}>
        <div className="h-[200px] w-[200px] animate-pulse rounded-md bg-gray-100" />
      </div>
    );
  }

  if (token.error || !token.data) {
    // ATTENDANCE_NOT_CONFIGURED and ATTENDANCE_DISABLED both land here, and both
    // are honest states rather than faults the resident can act on — so the copy
    // does not tell them to try again or to report anything.
    return (
      <div className={className}>
        <p className="text-sm text-gray-500">
          Check-in codes aren&rsquo;t available right now. The people running the
          event can still tick you off their list at the door.
        </p>
      </div>
    );
  }

  const { userID, token: tag, expiresAt } = token.data;
  const secondsLeft = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));

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
        <p className="text-center text-xs text-gray-400">
          {secondsLeft > 0
            ? `Refreshes in ${secondsLeft}s — that's normal.`
            : "Refreshing…"}
        </p>
      </div>
    </div>
  );
}
