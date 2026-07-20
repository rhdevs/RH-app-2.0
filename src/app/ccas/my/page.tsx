import Link from "next/link";

import MyCcasList from "../_components/MyCcasList";

export const dynamic = "force-dynamic";

/** The resident's "My CCAs" — the CCAs they're a member of, view-only. */
export default function MyCcasPage() {
  return (
    <div>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">My CCAs</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            The co-curricular activities you&rsquo;re a member of.
          </p>
        </div>
        <Link
          href="/ccas"
          className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
        >
          Browse all CCAs →
        </Link>
      </header>
      <MyCcasList />
    </div>
  );
}
