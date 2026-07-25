"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

// Routes that must NEVER be gated (the auth flow + the onboarding page itself),
// otherwise a matric-less user would be redirected in an infinite loop. Any
// path equal to, or nested under, one of these is exempt. `/whats-new` is a
// public, read-only showcase page and is exempt so anyone can reach it.
const ALLOW_LIST = [
  "/onboarding",
  "/login",
  "/signup",
  "/reset-password",
  "/whats-new",
];

function isAllowed(pathname: string) {
  return ALLOW_LIST.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Client-side login gate. Mounted once in the root layout (inside the session
 * provider so `useSession` works). Two distinct states, checked in this order:
 *
 *  1. NO IDENTITY (`hasIdentity === false`) — the session's email does not
 *     canonicalize to an @u.nus.edu id: a non-NUS address, or a pre-cutover JWT
 *     on one. It MUST be checked first.
 *
 *     It keys off `hasIdentity`, NOT off `eligible`, and the difference is the
 *     whole point (D-C). `eligible` is the ENFORCEMENT DECISION — "is this
 *     principal admitted under the current `rbac.auth.enforcement` mode" — and
 *     I-11 made it flag-aware, so it is `true` for an empty-identity session in
 *     every mode except `enforce`, which is not the shipping default. Gating on
 *     it therefore applied nothing to exactly the cohort this branch exists for.
 *     `hasIdentity` is the identity FACT and does not move when a flag moves.
 *
 *     Such a session also has
 *     `hasMatric === false`, so a hasMatric-first gate sends them to
 *     /onboarding/matric, where the only action calls `user.setMatric` — a
 *     protectedProcedure, which rejects them in every mode: with
 *     NUS_ACCOUNT_REQUIRED at the eligibility check under `enforce`, and with
 *     BAD_REQUEST "No canonical userID on session" under the default `off`
 *     (user.ts:208 — the guard that stops a ""-keyed UserMatric row). Either
 *     way they would type a valid matric and get an opaque error forever:
 *     worse than a clean logout. They go to /onboarding/ineligible, which
 *     explains it and offers sign-out.
 *  2. INCOMPLETE PROFILE (`profileNeedsFields` non-empty) — a duplicate account
 *     was merged into this one and some details disagreed, so they were cleared
 *     and must be re-entered. Redirect to /onboarding/complete-profile.
 *
 *     It sits ABOVE the matric branch, not below, and the order is load-bearing
 *     in both directions:
 *
 *     - A merged user whose matric was cleared has `hasMatric === false` too, so
 *       a matric-first ladder would send them to /onboarding/matric. That page
 *       writes UserMatric and nothing else — it does not know ProfileCompletion
 *       exists — so it would clear `hasMatric`, leave "matric" sitting in
 *       `needsFields`, and drop the user straight back here on the next render.
 *       /onboarding/complete-profile writes through the SAME writer and clears
 *       the flag, so it is a strict superset for exactly this cohort.
 *     - The matric branch is behind `matricRequired`, which defaults to OFF.
 *       Ordering the flag-gated branch first would mean a flagged user is not
 *       prompted at all while that switch is off — the prompt would be silently
 *       coupled to an unrelated kill switch.
 *
 *     Unlike the matric branch this has NO kill switch, and does not need one:
 *     it is self-limiting. It fires only for accounts that have a row in a
 *     collection whose sole producer is the merge script, so "off" is already
 *     the state of every account that script never touched. There is nothing
 *     for a flag to protect against.
 *  3. NO MATRIC — redirect to /onboarding/matric, but ONLY when the server says
 *     the gate is live (`matricRequired`, the `rbac.matric.enforcement` switch).
 *     UserMatric is a new, empty, un-backfilled collection, so gating on
 *     hasMatric alone would bounce every existing user to onboarding and render
 *     the calendar, profile and admin pages as a blank page on deploy day.
 *
 * The auth/onboarding routes are allow-listed to avoid a redirect loop. It
 * never blocks logged-out or still-loading sessions, so the public surface and
 * the login page behave exactly as before. This is the UX layer; the
 * server-side `matricProcedure` is the authoritative backstop.
 */
export default function MatricGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const authed = status === "authenticated";
  // D-C. `hasIdentity`, never `eligible`: see (1) in the docstring above. This
  // branch is NOT behind `rbac.matric.enforcement` — that switch gates the
  // matric redirect below (`matricRequired`) and nothing else. An empty
  // identity is not a policy question and does not vary by mode.
  const ineligible = authed && session?.user?.hasIdentity === false;
  // Post-merge completion. `?? []` matters: a session cookie minted before this
  // field existed has no `profileNeedsFields` at all, and `undefined.length`
  // would throw inside the root layout — i.e. a blank app for every logged-in
  // user until their JWT rolled over. Absent means "not flagged".
  const needsProfileCompletion =
    authed &&
    !ineligible &&
    (session?.user?.profileNeedsFields ?? []).length > 0;
  const needsMatric =
    authed &&
    !ineligible &&
    !needsProfileCompletion &&
    session?.user?.matricRequired === true &&
    session?.user?.hasMatric === false;

  const redirectTo = ineligible
    ? "/onboarding/ineligible"
    : needsProfileCompletion
      ? "/onboarding/complete-profile"
      : needsMatric
        ? "/onboarding/matric"
        : null;
  const blocked = redirectTo !== null && !isAllowed(pathname);

  useEffect(() => {
    if (blocked && redirectTo) {
      router.replace(redirectTo);
    }
  }, [blocked, redirectTo, router]);

  // While the redirect is pending on a gated route, render nothing to avoid a
  // flash of protected UI. Allow-listed routes and logged-out / loading states
  // always render their children untouched.
  if (blocked) return null;

  return <>{children}</>;
}
