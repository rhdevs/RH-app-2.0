"use client";

import { useEffect } from "react";

/**
 * Root error boundary (03-admin-dashboard.md §4). There was none above the
 * admin segment, so an unhandled render error anywhere in the tree blanked the
 * whole app shell.
 *
 * NOTE the boundary this does NOT provide: a segment's error.tsx does not catch
 * errors thrown by that same segment's layout.tsx. `src/app/admin/layout.tsx`
 * therefore still has to fail closed on its own (it catches and redirects),
 * rather than relying on this file.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({ evt: "app_render_error", digest: error.digest }),
    );
  }, [error]);

  return (
    <div className="mb-14 flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 text-center shadow-lg">
        <h1 className="text-lg font-semibold text-gray-900">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          The page failed to load. This has been logged.
        </p>
        <button
          onClick={reset}
          className="mt-6 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-800"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
