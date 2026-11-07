import { LOAN_STATUS_LABEL, type LoanStatus } from "~/lib/equipment/status";

const TONE: Record<LoanStatus, string> = {
  requested:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
  approved:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
  collected: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200",
  returned:
    "bg-gray-100 text-gray-700 dark:bg-muted dark:text-muted-foreground",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200",
  canceled:
    "bg-gray-100 text-gray-600 dark:bg-muted dark:text-muted-foreground",
};

/** The status of a loan, and a red OVERDUE mark beside it when it is late. */
export default function StatusBadge({
  status,
  overdue,
}: {
  status: LoanStatus;
  overdue: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status]}`}
      >
        {LOAN_STATUS_LABEL[status]}
      </span>
      {overdue && (
        <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-red-500">
          Overdue
        </span>
      )}
    </span>
  );
}
