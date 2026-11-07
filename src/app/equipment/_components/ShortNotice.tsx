import Link from "next/link";

import { formatDateRange } from "~/app/events/_lib/format";
import { equipmentLoanHref } from "~/lib/equipment/links";
import type { ShortDetail } from "~/lib/equipment/stock";

/**
 * "Not enough of this item" for one item: how many are owned, the most held at
 * once in the window, how many are wanted, and the loans holding it. Used for
 * the form's "looks short" warning (filing is still allowed) and for a refused
 * approval. Names and titles are server text, rendered as React text.
 */
export default function ShortNotice({ detail }: { detail: ShortDetail }) {
  return (
    <div
      role="status"
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <p>
        <strong>{detail.name}</strong> looks short: {detail.owned} owned,{" "}
        {detail.heldAtPeak} already held at the busiest time, {detail.wanted}{" "}
        wanted.
      </p>
      {detail.loans.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
          {detail.loans.map((l) => (
            <li key={l.id}>
              <Link
                href={equipmentLoanHref(l.id)}
                className="underline underline-offset-2"
              >
                {l.eventTitle ?? "An event"}
              </Link>
              : {l.quantity} held, {formatDateRange(l.collectAt, l.returnAt)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
