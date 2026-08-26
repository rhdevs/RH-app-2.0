"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import Link from "next/link";

import { api } from "~/trpc/react";

/* -------------------------------------------------------------------------- */
/* Error copy                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every string here is reachable by someone standing at a door with a queue
 * behind them, so each one says what happened AND what to do instead. None of
 * them says "try again" for a condition that retrying cannot fix.
 */
function mapDoorError(e: { message?: string } | null | undefined): string {
  const m = e?.message ?? "";
  if (m === "ATTENDANCE_DISABLED")
    return "Check-in isn't switched on for the hall yet. Take names on paper and add them afterwards.";
  if (m === "ATTENDANCE_NOT_CONFIGURED")
    return "Check-in isn't set up on this deployment. Take names on paper — this is not something you can fix from here.";
  if (m === "EVENTS_DISABLED")
    return "Events are switched off right now.";
  if (m === "NOT_A_SCANNER")
    return "You're not on this event's door list. The head who created the event can add you.";
  if (m === "NOT_PUBLISHED")
    return "This event isn't live, so there's nobody to check in yet.";
  if (m === "DOOR_NOT_OPEN")
    return "Check-in hasn't opened for this event yet. It opens an hour before the start time unless the head changed it.";
  if (m === "DOOR_CLOSED")
    return "Check-in has closed for this event.";
  if (m === "BAD_QR")
    return "That code didn't work. It may have expired — ask them to let it refresh, or tick them off the list instead.";
  if (m === "NOT_CHECKED_IN")
    return "They weren't checked in, so there's nothing to undo.";
  if (m === "NO_SUCH_EVENT") return "That event doesn't exist.";
  return "That didn't go through. Try again.";
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/* -------------------------------------------------------------------------- */

type CameraState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "blocked"; reason: string };

/**
 * IN-APP BROWSERS ARE THE COMMON FAILURE, NOT AN EXOTIC ONE. A link opened from
 * inside Telegram or Instagram runs in a webview that frequently refuses camera
 * access outright, and the committee will absolutely open the door link from a
 * group chat. Detecting it lets us say "open this in Safari or Chrome" instead
 * of showing a black rectangle and letting someone conclude the app is broken.
 */
function looksLikeInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /FBAN|FBAV|Instagram|Line\/|Telegram|WhatsApp|MicroMessenger|TikTok/i.test(
    ua,
  );
}

export default function DoorScanner({ eventID }: { eventID: number }) {
  const utils = api.useUtils();
  const status = api.event.attendanceStatus.useQuery(
    { eventID },
    { retry: false, refetchInterval: 30_000 },
  );
  const roster = api.event.getDoorRoster.useQuery(
    { eventID },
    { retry: false, enabled: status.data?.mayScan === true },
  );

  const [camera, setCamera] = useState<CameraState>({ kind: "idle" });
  const [lastResult, setLastResult] = useState<{
    displayName: string | null;
    wasSignedUp: boolean;
    alreadyCheckedIn: boolean;
    userID: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  /**
   * Guards against re-submitting the same code every animation frame while it
   * is still in front of the lens — a QR sits in view for a second or more,
   * which is thirty-plus frames.
   */
  const inFlightRef = useRef(false);
  const lastPayloadRef = useRef<{ value: string; at: number } | null>(null);

  const checkIn = api.event.checkIn.useMutation({
    onSuccess: async (res, vars) => {
      setError(null);
      setLastResult({
        displayName: res.displayName,
        wasSignedUp: res.wasSignedUp,
        alreadyCheckedIn: res.alreadyCheckedIn,
        userID: vars.payload.split("|")[1] ?? "",
      });
      await Promise.all([
        utils.event.attendanceStatus.invalidate({ eventID }),
        utils.event.getDoorRoster.invalidate({ eventID }),
      ]);
    },
    onError: (e) => setError(mapDoorError(e)),
    onSettled: () => {
      inFlightRef.current = false;
    },
  });

  const manual = api.event.checkInManual.useMutation({
    onSuccess: async (res, vars) => {
      setError(null);
      setLastResult({
        displayName: res.displayName,
        wasSignedUp: res.wasSignedUp,
        alreadyCheckedIn: res.alreadyCheckedIn,
        userID: vars.userID,
      });
      await Promise.all([
        utils.event.attendanceStatus.invalidate({ eventID }),
        utils.event.getDoorRoster.invalidate({ eventID }),
      ]);
    },
    onError: (e) => setError(mapDoorError(e)),
  });

  const undo = api.event.undoCheckIn.useMutation({
    onSuccess: async () => {
      setError(null);
      setLastResult(null);
      await Promise.all([
        utils.event.attendanceStatus.invalidate({ eventID }),
        utils.event.getDoorRoster.invalidate({ eventID }),
      ]);
    },
    onError: (e) => setError(mapDoorError(e)),
  });

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera({ kind: "idle" });
  }, []);

  // Release the camera when the page goes away. A door surface left holding the
  // lens keeps the phone's camera indicator on and drains it.
  useEffect(() => stopCamera, [stopCamera]);

  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      rafRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) {
      rafRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      rafRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const decoded = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
      inversionAttempts: "dontInvert",
    });

    if (decoded?.data && !inFlightRef.current) {
      const now = Date.now();
      const last = lastPayloadRef.current;
      // Same code within two seconds is the same person still holding their
      // phone up, not a second scan.
      const isRepeat =
        last !== null && last.value === decoded.data && now - last.at < 2000;
      if (!isRepeat) {
        lastPayloadRef.current = { value: decoded.data, at: now };
        inFlightRef.current = true;
        checkIn.mutate({ eventID, payload: decoded.data });
      }
    }
    rafRef.current = requestAnimationFrame(scanFrame);
  }, [checkIn, eventID]);

  const startCamera = useCallback(async () => {
    setError(null);
    // MUST BE CALLED FROM A USER GESTURE. iOS Safari refuses getUserMedia
    // otherwise, which is why this is a button and not an effect on mount.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCamera({
        kind: "blocked",
        reason: looksLikeInAppBrowser()
          ? "This is an in-app browser and it won't give the camera to a web page. Open this link in Safari or Chrome and it will work."
          : "This browser won't give a web page the camera. Open the link in Safari or Chrome, or use the list below.",
      });
      return;
    }
    setCamera({ kind: "starting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // playsInline matters on iOS: without it the video goes fullscreen and
        // the door page disappears behind it mid-queue.
        await videoRef.current.play();
      }
      setCamera({ kind: "running" });
      rafRef.current = requestAnimationFrame(scanFrame);
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      setCamera({
        kind: "blocked",
        reason:
          name === "NotAllowedError"
            ? "Camera permission was refused. Allow it in your browser settings, or use the list below."
            : looksLikeInAppBrowser()
              ? "This is an in-app browser and it won't give the camera to a web page. Open this link in Safari or Chrome."
              : "The camera wouldn't start. Use the list below instead — it works without a camera.",
      });
    }
  }, [scanFrame]);

  const filtered = useMemo(() => {
    const rows = roster.data?.rows ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.displayName ?? "").toLowerCase().includes(q) ||
        (r.matricSuffix ?? "").toLowerCase().includes(q),
    );
  }, [roster.data, query]);

  /* ---------------------------------------------------------------- render */

  if (status.isPending) {
    return <p className="p-6 text-sm text-gray-500">Loading the door…</p>;
  }
  if (status.error) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-700">{mapDoorError(status.error)}</p>
      </div>
    );
  }

  const s = status.data;

  if (!s.enabled) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-xl font-semibold text-gray-900">Door check-in</h1>
        <p className="mt-2 text-sm text-gray-600">
          Check-in isn&rsquo;t switched on for the hall yet. Take names on paper
          and add them afterwards.
        </p>
      </div>
    );
  }
  if (!s.mayScan) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-xl font-semibold text-gray-900">Door check-in</h1>
        <p className="mt-2 text-sm text-gray-600">
          You&rsquo;re not on this event&rsquo;s door list. The head who created
          the event can add you.
        </p>
        <Link
          href={`/events/${eventID}`}
          className="mt-4 inline-block text-sm text-blue-700 underline"
        >
          ← Back to the event
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 pb-24">
      <div>
        <Link
          href={`/events/${eventID}`}
          className="text-sm text-gray-500 underline"
        >
          ← Back to the event
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">
          Door check-in
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {s.count} checked in
          {roster.data ? ` · ${roster.data.rows.length} signed up` : ""}
        </p>
      </div>

      {!s.open && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            {s.opensAt !== null &&
            Math.floor(Date.now() / 1000) < s.opensAt
              ? "Check-in hasn't opened yet. It opens an hour before the start time unless the head changed it."
              : "Check-in has closed for this event."}
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------- scanner */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold text-gray-900">Scan a code</h2>

        {camera.kind === "idle" && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void startCamera()}
              disabled={!s.open}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Start camera
            </button>
            <p className="mt-2 text-xs text-gray-500">
              Your phone will ask for camera permission.
            </p>
          </div>
        )}

        {camera.kind === "starting" && (
          <p className="mt-3 text-sm text-gray-500">Starting the camera…</p>
        )}

        {camera.kind === "blocked" && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
            {/* NEVER A BLACK RECTANGLE. If the camera cannot run, say why and
                point at the list, which needs no camera at all. */}
            <p className="text-sm text-amber-900">{camera.reason}</p>
          </div>
        )}

        <div className={camera.kind === "running" ? "mt-3" : "hidden"}>
          <video
            ref={videoRef}
            className="w-full rounded-md bg-black"
            muted
            playsInline
          />
          <canvas ref={canvasRef} className="hidden" />
          <button
            type="button"
            onClick={stopCamera}
            className="mt-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            Stop camera
          </button>
        </div>
      </div>

      {/* --------------------------------------------------------- feedback */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {lastResult && (
        <div
          className={`rounded-md border p-3 ${
            lastResult.wasSignedUp
              ? "border-green-200 bg-green-50"
              : "border-blue-200 bg-blue-50"
          }`}
          aria-live="polite"
        >
          <p className="text-sm font-medium text-gray-900">
            {lastResult.displayName ?? lastResult.userID}
            {lastResult.alreadyCheckedIn ? " — already in" : " — checked in"}
          </p>
          <p className="mt-0.5 text-sm text-gray-600">
            {lastResult.wasSignedUp
              ? "On the signup list."
              : "Not on the list — walk-in, recorded."}
          </p>
          <button
            type="button"
            onClick={() =>
              undo.mutate({
                eventID,
                userID: lastResult.userID,
                reason: "Undone at the door",
              })
            }
            disabled={undo.isPending}
            className="mt-2 text-xs text-gray-600 underline disabled:opacity-50"
          >
            {undo.isPending ? "Undoing…" : "Undo this"}
          </button>
        </div>
      )}

      {/* ----------------------------------------------------- manual list */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold text-gray-900">
          Or find them on the list
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Works without a camera. Search by name, or the last four of a matric.
        </p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or ••••567X"
          className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />

        {roster.isPending && (
          <p className="mt-3 text-sm text-gray-500">Loading the list…</p>
        )}
        {roster.error && (
          <p className="mt-3 text-sm text-red-700">{mapDoorError(roster.error)}</p>
        )}

        <ul className="mt-3 divide-y divide-gray-100">
          {filtered.map((r) => (
            <li
              key={r.userID}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-900">
                  {r.displayName ?? r.userID}
                </p>
                <p className="text-xs text-gray-500">
                  {r.block !== null ? `Block ${r.block}` : "—"}
                  {r.matricSuffix ? ` · ••••${r.matricSuffix}` : ""}
                </p>
              </div>
              {r.checkedIn ? (
                <span className="shrink-0 text-xs text-green-700">In</span>
              ) : (
                <button
                  type="button"
                  onClick={() => manual.mutate({ eventID, userID: r.userID })}
                  disabled={manual.isPending || !s.open}
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Check in
                </button>
              )}
            </li>
          ))}
        </ul>

        {roster.data && filtered.length === 0 && (
          <p className="mt-3 text-sm text-gray-500">
            {query.trim()
              ? "Nobody on the list matches that. If they didn't sign up, scan their code instead — walk-ins are fine."
              : "Nobody has signed up for this event."}
          </p>
        )}
      </div>
    </div>
  );
}
