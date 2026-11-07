"use client";

import { api } from "~/trpc/react";
import { DISPOSABLES_HREF } from "~/lib/disposables/links";
import Link from "next/link";

/**
 * Today's approved disposables collections, for the Social director only. NOT a
 * guard: `disposable.digest` checks the switch and who is the Social director
 * from the stored rows. Everyone else, and a failed read, sees nothing here:
 * the rest of the page still works, and this is a convenience, not the record.
 */
export default function DigestSection() {
  const digest = api.disposable.digest.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  if (!digest.data) return null;
  const { day, items, skipped, more } = digest.data;

  return (
    <section aria-labelledby="director-digest">
      <h2
        id="director-digest"
        className="mb-2 text-sm font-semibold text-gray-900"
      >
        Disposables collections today ({day})
      </h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
          No collections are booked for today.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
          {items.map((i) => (
            <li key={i.id} className="px-4 py-3">
              <p className="text-sm font-medium text-gray-900">
                {i.collectionTime} · {i.title}
              </p>
              <p className="text-xs text-gray-500">
                {i.ccaName ?? "A CCA"} · plates {i.plates}, cups {i.cups}, bowls{" "}
                {i.bowls}, forks {i.forks}, spoons {i.spoons}
              </p>
            </li>
          ))}
        </ul>
      )}
      {(skipped > 0 || more) && (
        <p className="mt-2 text-xs text-gray-500">
          {skipped > 0 && `${skipped} could not be shown. `}
          {more && "There are more than this list can show. "}
          <Link href={DISPOSABLES_HREF} className="underline">
            Open all requests
          </Link>
        </p>
      )}
    </section>
  );
}
