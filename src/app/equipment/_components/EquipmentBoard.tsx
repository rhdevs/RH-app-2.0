"use client";

import Link from "next/link";
import { useState } from "react";
import { Boxes } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { formatDateRange } from "~/app/events/_lib/format";
import { equipmentLoanHref, EQUIPMENT_ITEMS_HREF } from "~/lib/equipment/links";
import { LOAN_STATUSES, LOAN_STATUS_LABEL } from "~/lib/equipment/status";
import StatusBadge from "./StatusBadge";

const fieldClass =
  "rounded-md border border-gray-300 dark:border-border bg-white dark:bg-card px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

const HALL = "hall";

/**
 * The equipment loan board: every loan, with its event, CCA, items, window,
 * status and an overdue mark. No photo and no reason ever reach this list. NOT a
 * guard: the procedure checks the flag and that this person may read the board;
 * the rows carry nothing but what every reader may see. Server text is
 * rendered as React text. A new loan starts from the event page, so this
 * screen has no "new" button.
 */
export default function EquipmentBoard() {
  const enabled = api.equipment.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const [status, setStatus] = useState("");
  const [cca, setCca] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const list = api.equipment.list.useQuery(
    {
      status: LOAN_STATUSES.find((s) => s === status) ?? null,
      cca: cca === "" ? null : cca === HALL ? "hall" : Number(cca),
      overdueOnly,
    },
    { retry: false, enabled: on },
  );

  const muted = "text-sm text-gray-500 dark:text-muted-foreground";
  if (enabled.isLoading) return <p className={muted}>Loading…</p>;
  if (!on)
    return <p className={muted}>Equipment loans are not switched on yet.</p>;
  if (list.isLoading) return <p className={muted}>Loading loans…</p>;
  if (list.isError || !list.data) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {list.error?.message.includes("NOT_EQUIPMENT_READER")
          ? "You do not have access to equipment loans."
          : "Could not load the loans. Try again shortly."}
      </p>
    );
  }
  const { items, viewer, ccaOptions, more, skipped } = list.data;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground">
          Equipment loans
        </h2>
        <Button asChild size="sm" variant="outline">
          <Link href={EQUIPMENT_ITEMS_HREF}>
            <Boxes className="mr-1.5 h-4 w-4" />
            {viewer.isDirector ? "Edit the list" : "Equipment list"}
          </Link>
        </Button>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter loans"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="text-xs text-gray-600 dark:text-muted-foreground">
          Status
          <select
            className={`${fieldClass} mt-1 block`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {LOAN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LOAN_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-600 dark:text-muted-foreground">
          CCA
          <select
            className={`${fieldClass} mt-1 block`}
            value={cca}
            onChange={(e) => setCca(e.target.value)}
          >
            <option value="">All</option>
            <option value={HALL}>Hall-wide</option>
            {ccaOptions.map((c) => (
              <option key={c.ccaID} value={c.ccaID}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-gray-700 dark:text-foreground">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          Overdue only
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setStatus("");
            setCca("");
            setOverdueOnly(false);
          }}
        >
          Clear filters
        </Button>
      </form>

      {skipped > 0 && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          {skipped} loan{skipped === 1 ? "" : "s"} could not be shown.
        </p>
      )}
      {more && (
        <p
          role="status"
          className="text-xs text-gray-500 dark:text-muted-foreground"
        >
          Showing the first 300 loans. Narrow the filters to see others.
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 dark:border-border dark:bg-card dark:text-muted-foreground">
          No loans match. Borrow equipment from an event&apos;s page.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white dark:divide-border dark:border-border dark:bg-card">
          {items.map((loan) => (
            <li key={loan.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={equipmentLoanHref(loan.id)}
                  className="font-medium text-gray-900 underline-offset-2 hover:underline dark:text-foreground"
                >
                  {loan.eventTitle ?? "An event"}
                </Link>
                <StatusBadge status={loan.status} overdue={loan.overdue} />
              </div>
              <p className="text-xs text-gray-500 dark:text-muted-foreground">
                {loan.hallWide ? "Hall-wide" : (loan.ccaName ?? "A CCA")}
                {" · "}
                {formatDateRange(loan.collectAt, loan.returnAt)}
              </p>
              {(loan.eventState === "canceled" ||
                loan.eventState === "declined") &&
                loan.status === "approved" && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    The event is {loan.eventState}, so this loan holds no stock.
                  </p>
                )}
              <p className="mt-1 text-sm text-gray-700 dark:text-foreground">
                {loan.lines
                  .map((l) => `${l.quantity} x ${l.name ?? "removed item"}`)
                  .join(", ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
