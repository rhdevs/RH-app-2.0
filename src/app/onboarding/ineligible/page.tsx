"use client";

import React from "react";
import { signOut, useSession } from "next-auth/react";
import { ShieldAlert } from "lucide-react";

/**
 * TWO terminal states, ONE page, because the resolving action is the same in
 * both — sign out — and a second route would only be a second thing to
 * allow-list correctly in MatricGate.
 *
 * 1. D-7 INELIGIBLE. Reached when `session.user.hasIdentity` is false: the
 *    signed-in email does not canonicalize to an @u.nus.edu id. That is a
 *    non-NUS address, or a JWT minted before the eligibility cutover on one
 *    (session.maxAge is 30 days and the signIn callback does not re-run for a
 *    live token).
 *
 *    D-C: the gate keys off `hasIdentity`, not `eligible`. Until that change
 *    this page was effectively UNREACHABLE, because `eligible` is flag-aware
 *    (I-11) and is `true` for these sessions in every mode but `enforce`. Do not
 *    "simplify" the gate back onto `eligible`.
 *
 * 2. NO ACCOUNT ROW. Reached when `session.user.accountMissing` is true: the
 *    `User` document this JWT was minted against is gone — deleted through
 *    `userAdmin.delete`, or removed as the losing row of an account merge. The
 *    copy has to be DIFFERENT from state 1's, because state 1's is a false
 *    statement here: their address is fine, and telling someone whose account
 *    was merged that they need an NUS account sends them to create a duplicate
 *    of the row the merge just cleaned up. It is also checked FIRST, since such
 *    a session still canonicalizes and would otherwise read as eligible.
 *
 * Deliberately calls NO tRPC procedure — not even one that would succeed today.
 * Under `enforce` every procedure is built on protectedProcedure and denies
 * state 1 with NUS_ACCOUNT_REQUIRED, and state 2 is denied the same way once
 * the account is genuinely gone, so anything data-driven here would render as an
 * opaque error in exactly the modes where this page matters most. The page
 * states the requirement and offers the one action that resolves it.
 */
export default function IneligibleAccountPage() {
  const { data: session } = useSession();
  const accountMissing = session?.user?.accountMissing === true;

  return (
    <div className="mt-16 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
        <div className="mb-6 text-center">
          <ShieldAlert className="mx-auto mb-3 text-amber-600" size={40} />

          {accountMissing ? (
            <>
              <h1 className="mb-2 text-2xl font-bold text-gray-900">
                This session is no longer valid
              </h1>
              <p className="text-gray-600">
                The account this browser is signed in as no longer exists. That
                happens when an account is removed, and also when two duplicate
                accounts are merged into one — in which case your details,
                bookings and CCA memberships are all safe on the account that
                was kept.
              </p>
              <p className="mt-3 text-gray-600">
                Signing out and signing back in with the same NUS address picks
                up the current account. If you are still shown this page
                afterwards, the account really was removed — speak to the JCRC.
              </p>
            </>
          ) : (
            <>
              <h1 className="mb-2 text-2xl font-bold text-gray-900">
                NUS account required
              </h1>
              <p className="text-gray-600">
                The RH App is only available to Raffles Hall residents signing
                in with their NUS student account — an address ending in{" "}
                <span className="font-semibold text-gray-900">@u.nus.edu</span>.
              </p>
              <p className="mt-3 text-gray-600">
                You are signed in with a different address. Bookings and posts
                made from this account cannot be linked back to you, so it can
                no longer use the rest of the app. Sign in with your NUS student
                account and everything works normally.
              </p>
            </>
          )}
        </div>

        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:bg-emerald-700"
        >
          {accountMissing
            ? "Log out and sign in again"
            : "Log out and sign in with NUS"}
        </button>

        {!accountMissing && (
          <p className="mt-4 text-center text-sm text-gray-500">
            Already using an @u.nus.edu address? Log out and back in — your
            session predates this requirement.
          </p>
        )}
      </div>
    </div>
  );
}
