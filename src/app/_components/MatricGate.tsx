"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

// Routes that must NEVER be gated (the auth flow + the onboarding page itself),
// otherwise a matric-less user would be redirected in an infinite loop. Any
// path equal to, or nested under, one of these is exempt.
const ALLOW_LIST = ["/onboarding", "/login", "/signup", "/reset-password"];

function isAllowed(pathname: string) {
  return ALLOW_LIST.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Client-side login gate. Mounted once in the root layout (inside the session
 * provider so `useSession` works). Two distinct states, checked in this order:
 *
 *  1. INELIGIBLE (`eligible === false`) — a pre-cutover JWT on a non-@u.nus.edu
 *     address. It MUST be checked first. Such a session also has
 *     `hasMatric === false`, so a hasMatric-first gate sends them to
 *     /onboarding/matric, where the only action calls `user.setMatric` — a
 *     protectedProcedure, which rejects them with NUS_ACCOUNT_REQUIRED at the
 *     eligibility check before the form's own guards ever run. They would type
 *     a valid matric and get an opaque error forever: worse than a clean
 *     logout. They go to /onboarding/ineligible, which explains it and offers
 *     sign-out.
 *  2. NO MATRIC — redirect to /onboarding/matric, but ONLY when the server says
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
  const ineligible = authed && session?.user?.eligible === false;
  const needsMatric =
    authed &&
    !ineligible &&
    session?.user?.matricRequired === true &&
    session?.user?.hasMatric === false;

  const redirectTo = ineligible
    ? "/onboarding/ineligible"
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
