import type { ApplicationStatus } from "~/lib/schemas/ccaApplication";

/**
 * Human copy + badge styling for an application status. Shared by every surface
 * that shows one (resident browse, apply panel, my-applications, head review),
 * so the wording and colour of "interview_scheduled" cannot drift between them.
 *
 * Plain module (no "use client"): it exports data + pure helpers, imported by
 * both client components and server-safe code.
 */
export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  submitted: "Submitted",
  interview_scheduled: "Interview booked",
  interviewed: "Interviewed",
  accepted: "Accepted",
  rejected: "Not accepted",
  withdrawn: "Withdrawn",
};

const STATUS_CLASS: Record<ApplicationStatus, string> = {
  submitted: "bg-sky-50 text-sky-700 ring-sky-600/20",
  interview_scheduled: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  interviewed: "bg-amber-50 text-amber-700 ring-amber-600/20",
  accepted: "bg-green-50 text-green-700 ring-green-600/20",
  rejected: "bg-rose-50 text-rose-700 ring-rose-600/20",
  withdrawn: "bg-gray-100 text-gray-600 ring-gray-500/20",
};

export function statusLabel(status: string | null | undefined): string {
  return STATUS_LABEL[(status ?? "") as ApplicationStatus] ?? "Unknown";
}

/** Tailwind classes for a `ring-1` pill of the given status. */
export function statusBadgeClass(status: string | null | undefined): string {
  return (
    STATUS_CLASS[(status ?? "") as ApplicationStatus] ??
    "bg-gray-100 text-gray-600 ring-gray-500/20"
  );
}

/** Format an epoch-seconds slot as a human date + time range. */
export function formatSlot(
  startTime: number | null,
  endTime: number | null,
): string {
  if (startTime === null) return "—";
  const start = new Date(startTime * 1000);
  const date = start.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const startT = start.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (endTime === null) return `${date}, ${startT}`;
  const endT = new Date(endTime * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date}, ${startT}–${endT}`;
}
