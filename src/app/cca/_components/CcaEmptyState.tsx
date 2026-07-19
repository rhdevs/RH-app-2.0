import Link from "next/link";

/**
 * What you see at /cca when you head no CCA.
 *
 * CALM, NOT AN ERROR — heading no CCA is an ordinary state, and this is also
 * where CH-1 drift comes to rest: a stale `cca_head` string with no CcaHead
 * rows lands here rather than on a broken page. That is the intended failure
 * direction for the reachCcaDashboard gate — an empty page, never a leaked
 * roster.
 *
 * A server component: it has no state and no interactivity.
 */
export default function CcaEmptyState({
  canBrowseAll,
}: {
  canBrowseAll: boolean;
}) {
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-white px-5 py-8 text-center">
      <h1 className="text-lg font-semibold text-gray-900">
        You don&rsquo;t head any CCAs
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        This page shows the CCAs you&rsquo;re listed as a head of. If that
        should include one, contact the JCRC and they can add you.
      </p>
      {canBrowseAll && (
        <p className="mt-4 text-sm text-gray-500">
          Looking for a specific CCA?{" "}
          <Link
            href="/admin/ccas"
            className="font-medium text-emerald-700 underline underline-offset-2"
          >
            Browse all CCAs
          </Link>
          .
        </p>
      )}
    </div>
  );
}
