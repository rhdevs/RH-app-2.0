"use client";

import React from "react";
import { signOut } from "next-auth/react";
import { ShieldAlert } from "lucide-react";

/**
 * D-7 terminal state. Reached by MatricGate when `session.user.hasIdentity` is
 * false — the signed-in email does not canonicalize to an @u.nus.edu id. That
 * is a non-NUS address, or a JWT minted before the eligibility cutover on one
 * (session.maxAge is 30 days and the signIn callback does not re-run for a live
 * token).
 *
 * D-C: the gate keys off `hasIdentity`, not `eligible`. Until that change this
 * page was effectively UNREACHABLE, because `eligible` is flag-aware (I-11) and
 * is `true` for these sessions in every mode but `enforce`. Do not "simplify"
 * the gate back onto `eligible`.
 *
 * Deliberately calls NO tRPC procedure — not even one that would succeed today.
 * Under `enforce` every procedure is built on protectedProcedure and denies
 * this session with NUS_ACCOUNT_REQUIRED, so anything data-driven here would
 * render as an opaque error in exactly the mode where this page matters most.
 * The page states the requirement and offers the one action that actually
 * resolves it: sign out and sign back in with an NUS account.
 */
export default function IneligibleAccountPage() {
  return (
    <div className="mt-16 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
        <div className="mb-6 text-center">
          <ShieldAlert className="mx-auto mb-3 text-amber-600" size={40} />
          <h1 className="mb-2 text-2xl font-bold text-gray-900">
            NUS account required
          </h1>
          <p className="text-gray-600">
            The RH App is only available to Raffles Hall residents signing in
            with their NUS student account — an address ending in{" "}
            <span className="font-semibold text-gray-900">@u.nus.edu</span>.
          </p>
          <p className="mt-3 text-gray-600">
            You are signed in with a different address. Bookings and posts made
            from this account cannot be linked back to you, so it can no longer
            use the rest of the app. Sign in with your NUS student account and
            everything works normally.
          </p>
        </div>

        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:bg-emerald-700"
        >
          Log out and sign in with NUS
        </button>

        <p className="mt-4 text-center text-sm text-gray-500">
          Already using an @u.nus.edu address? Log out and back in — your
          session predates this requirement.
        </p>
      </div>
    </div>
  );
}
