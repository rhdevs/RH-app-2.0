import { type ReactNode } from "react";

/**
 * The small shared pieces of the /admin/transcripts screens. Plain markup in
 * the same look as the other admin cards: white, rounded, a shadow, gray text,
 * emerald actions, and inline red errors (toasts are not mounted in this app).
 */

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <h2 className="mb-1 text-sm font-semibold text-gray-900">{title}</h2>
      {description && (
        <p className="mb-5 max-w-3xl text-xs text-gray-500">{description}</p>
      )}
      {children}
    </section>
  );
}

/** An inline error line. `role="alert"` so a screen reader hears it. */
export function ErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p className="mt-2 text-sm text-red-700" role="alert">
      {message}
    </p>
  );
}

export const FIELD_LABEL = "mb-1 block text-xs font-medium text-gray-700";

/** A native select, styled like the neighbouring inputs. */
export function YearSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (year: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      >
        {options.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Words as well as colour: the state is never shown by colour alone. */
export function StatusBadge({
  label,
  published,
}: {
  label: string;
  published: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        published
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-gray-200 bg-gray-50 text-gray-700"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${published ? "bg-emerald-500" : "bg-gray-400"}`}
      />
      {label}
    </span>
  );
}
