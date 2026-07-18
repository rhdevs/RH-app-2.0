"use client";

import { useEffect } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

/**
 * Catches errors thrown by admin PAGES. It does NOT catch errors thrown by
 * admin/layout.tsx — that boundary does not exist in Next's model, which is why
 * the layout guard catches its own database failure and redirects rather than
 * throwing.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({ evt: "admin_render_error", digest: error.digest }),
    );
  }, [error]);

  return (
    <Alert variant="destructive">
      <AlertTitle>This admin page failed to load</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>Your permissions are unaffected.</span>
        <Button size="sm" variant="outline" onClick={reset}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
