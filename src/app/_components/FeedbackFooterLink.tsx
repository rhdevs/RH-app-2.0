"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";

import { api } from "~/trpc/react";

/**
 * "or in the app" beside the footer's Google Form link. Draws nothing unless
 * `feedback.enabled` is known to be on: while loading, failed or off, the
 * footer reads exactly as before. `feedback.enabled` is a protected procedure,
 * so the query runs only for a signed-in user; a signed-out visitor sends no
 * request.
 */
export default function FeedbackFooterLink() {
  const { status } = useSession();
  const enabled =
    api.feedback.enabled.useQuery(undefined, {
      enabled: status === "authenticated",
      retry: false,
      staleTime: 60_000,
    }).data?.enabled === true;
  if (!enabled) return null;
  return (
    <>
      {" "}
      or
      <Link href="/feedback" className="ml-1 underline hover:text-emerald-300">
        in the app
      </Link>
    </>
  );
}
