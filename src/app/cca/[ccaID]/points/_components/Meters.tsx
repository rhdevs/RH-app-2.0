"use client";

/**
 * A horizontal bar on a fixed scale with the allowed band shaded and a marker
 * at the current value. Green inside the band, red outside, and the value is
 * always written out (2 dp) so colour is never the only signal.
 */
export function RangeMeter({
  label,
  value,
  min,
  max,
  scaleMax,
  ok,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  scaleMax: number;
  ok: boolean;
}) {
  const has = Number.isFinite(value);
  const pct = (n: number) =>
    `${Math.min(100, Math.max(0, (n / scaleMax) * 100))}%`;
  const tone = !has
    ? "text-gray-400"
    : ok
      ? "text-emerald-700"
      : "text-red-700";
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-gray-700">{label}</span>
        <span className={`font-semibold tabular-nums ${tone}`}>
          {has ? value.toFixed(2) : "—"}
          <span className="ml-1.5 text-xs font-normal text-gray-500">
            target {min}–{max}
          </span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={scaleMax}
        aria-valuenow={has ? Number(value.toFixed(2)) : undefined}
        aria-valuetext={
          has
            ? `${value.toFixed(2)}, target ${min} to ${max}, ${ok ? "inside" : "outside"} the range`
            : "no scores yet"
        }
        className="relative mt-1.5 h-3 rounded-full bg-gray-100"
      >
        <div
          className="absolute inset-y-0 rounded-full bg-emerald-100"
          style={{ left: pct(min), width: `calc(${pct(max)} - ${pct(min)})` }}
        />
        {has && (
          <div
            className={`absolute -top-1 h-5 w-1.5 -translate-x-1/2 rounded-full ${ok ? "bg-emerald-600" : "bg-red-600"}`}
            style={{ left: pct(value) }}
          />
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-gray-400">
        <span>0</span>
        <span>{scaleMax}</span>
      </div>
    </div>
  );
}

/** 21 small bars, one per score 0–20. */
export function ScoreHistogram({ counts }: { counts: number[] }) {
  const peak = Math.max(1, ...counts);
  const summary = counts
    .map((n, score) => (n > 0 ? `${n} × ${score}` : null))
    .filter(Boolean)
    .join(", ");
  return (
    <figure>
      <figcaption className="text-sm font-medium text-gray-700">
        Score spread
      </figcaption>
      <div
        role="img"
        aria-label={summary ? `Scores given: ${summary}` : "No scores yet"}
        className="mt-1.5 flex h-16 items-end gap-px"
      >
        {counts.map((n, score) => (
          <div
            key={score}
            className="flex-1 rounded-t-sm bg-emerald-500/80"
            style={{ height: `${(n / peak) * 100}%`, minHeight: n > 0 ? 2 : 0 }}
            title={`${n} at ${score}`}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-gray-400">
        <span>0</span>
        <span>5</span>
        <span>10</span>
        <span>15</span>
        <span>20</span>
      </div>
    </figure>
  );
}
