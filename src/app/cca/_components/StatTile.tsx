"use client";

/**
 * One number and what it counts.
 *
 * `tabular-nums` so a row of tiles keeps its digits aligned when the numbers
 * change width, and the count is the largest thing on the tile because it is
 * the thing being read.
 */
export default function StatTile({
  label,
  value,
  hint,
  loading = false,
}: {
  label: string;
  value: number;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </p>
      {loading ? (
        <div className="mt-2 h-9 w-14 animate-pulse rounded bg-gray-200" />
      ) : (
        <p className="mt-1 text-3xl font-semibold tabular-nums text-gray-900">
          {value}
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
