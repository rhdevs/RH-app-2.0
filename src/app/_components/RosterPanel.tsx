"use client";

import { useMemo, useState } from "react";

import { api } from "~/trpc/react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Download } from "lucide-react";
import type { RosterEntry } from "~/server/api/services/ccaRoster";
import RosterTable, {
  rosterEntryKey,
  type RosterSelection,
  type MemberDetail,
} from "./RosterTable";
import RosterDriftNote from "./RosterDriftNote";
import { downloadXlsx } from "~/lib/xlsx";

/** How a roster entry maps to a removeMembers target. */
function removalTarget(entry: RosterEntry) {
  return entry.kind === "resolved"
    ? ({ kind: "user", userObjectId: entry.userId } as const)
    : ({ kind: "key", key: entry.key } as const);
}

/**
 * The roster for one CCA. Rendered by /cca/[ccaID] and by /admin/ccas.
 *
 * NEITHER PAGE PRE-GUARDS. cca.getRoster is the one policy site — a client can
 * call it from the console on any page in the app, so a duplicate check in the
 * page would be a second place to keep in step while buying no protection
 * (I-7). This component renders the denial the procedure returns.
 */
export default function RosterPanel({
  ccaID,
  /**
   * The CCA dashboard renders its own persistent heading in the shell, so the
   * member-list section would otherwise show the name twice. /admin/ccas has no
   * such heading and still needs it — hence a prop rather than deleting it.
   */
  hideHeader = false,
  /**
   * Enables member selection + bulk removal. Set ONLY by a head's own
   * member-list section (/cca/[ccaID]/members); the /admin/ccas viewer stays
   * read-only, and admins manage membership from /admin/manage-ccas. The server
   * guard (assertHeadsCca on cca.removeMembers) is the real boundary — this flag
   * only decides whether the checkboxes are drawn.
   */
  manageMembers = false,
  /**
   * Enables the click-to-expand member details and the "Export to Excel"
   * button by fetching cca.memberDirectory (the roster plus each member's full
   * profile). Set by a head's own member list AND by /admin/ccas —
   * memberDirectory's assertHeadsCca returns `via: "manageCcaHeads"` for admin
   * and jcrc, so both surfaces are authorized for it by the same guard.
   *
   * Off by default, and left off wherever the extra query would buy nothing:
   * unset, nothing is expandable and no second request is made.
   */
  enableDirectory = false,
}: {
  ccaID: number;
  hideHeader?: boolean;
  manageMembers?: boolean;
  enableDirectory?: boolean;
}) {
  const utils = api.useUtils();
  // Selected members, by rosterEntryKey. Confirmation opens a dialog separately.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const { data, isPending, error } = api.cca.getRoster.useQuery(
    { ccaID },
    {
      // A FORBIDDEN is a settled answer, not a transient failure. Retrying it
      // three times is log noise and a slow, ambiguous UI.
      retry: false,
    },
  );

  const remove = api.cca.removeMembers.useMutation({
    onSuccess: async () => {
      setConfirming(false);
      setSelected(new Set());
      await Promise.all([
        utils.cca.getRoster.invalidate({ ccaID }),
        utils.cca.memberDirectory.invalidate({ ccaID }),
      ]);
    },
  });

  // Full per-member details, fetched only when the head's member list asks for
  // them. Drives the expandable rows and the Excel export.
  const directory = api.cca.memberDirectory.useQuery(
    { ccaID },
    { enabled: enableDirectory, retry: false },
  );

  // rosterEntryKey -> detail, so a table row can look up its own person.
  const details = useMemo(() => {
    const map = new Map<string, MemberDetail>();
    for (const e of directory.data?.entries ?? []) map.set(e.rowKey, e);
    return map;
  }, [directory.data]);

  function exportExcel() {
    const dir = directory.data;
    if (!dir) return;
    const header = [
      "Name",
      "Email",
      "Role",
      "User ID",
      "Matric",
      "Block",
      "Telegram",
    ];
    const rows = dir.entries.map((e) => [
      e.name ?? (e.resolved ? "" : "Unmatched record"),
      e.email ?? "",
      e.role,
      e.userID ?? "",
      e.matric ?? "",
      e.block != null ? String(e.block) : "",
      e.telegramHandle ? `@${e.telegramHandle}` : "",
    ]);
    const slug =
      (dir.cca.ccaName ?? `cca-${ccaID}`)
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || `cca-${ccaID}`;
    downloadXlsx(`${slug}-members`, "Members", [header, ...rows]);
  }

  // Memoised so the `?? []` fallback doesn't mint a new array every render and
  // churn the selection memo below. react-query's `data` is reference-stable
  // between renders until the query actually changes.
  const members = useMemo(() => data?.members ?? [], [data]);

  // Keep the selection honest: a member removed (or renamed away) on a refetch
  // must drop out of the set, so the count and the bulk action never reference
  // a row that is no longer on screen.
  const liveSelected = useMemo(() => {
    if (selected.size === 0) return selected;
    const live = new Set<string>();
    for (const m of members) {
      const k = rosterEntryKey(m);
      if (selected.has(k)) live.add(k);
    }
    return live;
  }, [members, selected]);

  if (isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
        <div className="h-32 animate-pulse rounded-lg bg-gray-200" />
      </div>
    );
  }

  if (error) {
    if (error.message === "NOT_A_HEAD_OF_THIS_CCA") {
      return (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
          <p className="text-sm font-medium text-gray-900">
            You don&rsquo;t have access to this CCA
          </p>
          <p className="mt-1 text-sm text-gray-500">
            You can only view CCAs you&rsquo;re listed as a head of. If that
            should include this one, contact the JCRC.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6">
        <p className="text-sm font-medium text-red-900">
          This roster couldn&rsquo;t be loaded
        </p>
        <p className="mt-1 text-sm text-red-700">
          Reload the page. If it keeps happening, contact the JCRC.
        </p>
      </div>
    );
  }

  const { cca, heads, drift, via } = data;

  const toggle = (entry: RosterEntry) => {
    const k = rosterEntryKey(entry);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      // If everything on screen is already selected, clear; otherwise select
      // every member currently listed.
      const allKeys = members.map(rosterEntryKey);
      const allSelected =
        allKeys.length > 0 && allKeys.every((k) => prev.has(k));
      return allSelected ? new Set() : new Set(allKeys);
    });
  };

  const selectedCount = liveSelected.size;
  const headerState: boolean | "indeterminate" =
    members.length > 0 && selectedCount === members.length
      ? true
      : selectedCount > 0
        ? "indeterminate"
        : false;

  const selection: RosterSelection | undefined = manageMembers
    ? {
        selectedKeys: liveSelected,
        onToggle: toggle,
        onToggleAll: toggleAll,
        headerState,
        disabled: remove.isPending,
      }
    : undefined;

  return (
    <div className="space-y-6">
      {enableDirectory && (
        <div className="flex items-center justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={exportExcel}
            disabled={
              directory.isPending ||
              !!directory.error ||
              (directory.data?.entries.length ?? 0) === 0
            }
            title="Download every member's contact details as an Excel file"
          >
            <Download className="mr-2 h-4 w-4" />
            Export to Excel
          </Button>
        </div>
      )}

      {!hideHeader && (
        <header>
          <h1 className="text-2xl font-semibold text-gray-900">
            {cca.ccaName ?? `Unknown CCA (#${cca.ccaID})`}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {cca.category ?? "Uncategorised"}
            {via === "manageCcaHeads" && (
              <span className="ml-2 text-gray-400">· viewing as JCRC</span>
            )}
          </p>
        </header>
      )}

      {/* The CCA record itself is missing — the CcaBadges amber idiom, applied
          to the whole page rather than one row. */}
      {drift.ccaMissing && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          There is no CCA with this id any more, but these membership records
          still point at it.
        </div>
      )}

      <RosterDriftNote drift={drift} />

      {/* Heads are NEVER selectable here — headship is managed through
          grant/revoke/transfer, which keep the CcaHead row and the cca_head
          string in step (CH-1). Only the members table gets `selection`. */}
      <RosterTable
        title="Heads"
        entries={heads}
        emptyCopy="Nobody is currently listed as a head of this CCA."
        details={enableDirectory ? details : undefined}
      />

      {/* The bulk action bar. Reserves no space when nothing is selected, so it
          reads as a response to the selection rather than permanent chrome. */}
      {manageMembers && selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-sm text-emerald-900">
            {selectedCount} selected
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
            <Button
              size="sm"
              disabled={remove.isPending}
              onClick={() => setConfirming(true)}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Remove selected
            </Button>
          </div>
        </div>
      )}

      <RosterTable
        title="Members"
        entries={members}
        emptyCopy="No members are listed for this CCA yet."
        selection={selection}
        details={enableDirectory ? details : undefined}
      />

      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setConfirming(false);
            remove.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {selectedCount}{" "}
              {selectedCount === 1 ? "member" : "members"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedCount === 1 ? "This member" : "These members"} will be
              removed from this CCA. There&rsquo;s no way to add members back
              yet, so they&rsquo;d need to rejoin through the sign-up system.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error && (
            <p className="text-sm text-red-600">
              {remove.error.message === "NOT_A_HEAD_OF_THIS_CCA"
                ? "You're no longer a head of this CCA."
                : "That didn't work. Try again."}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            {/* Not AlertDialogAction: that closes the dialog on click, which
                would dismiss it before the mutation resolves and hide any
                error. A plain button keeps it open until onSuccess closes it. */}
            <button
              type="button"
              disabled={remove.isPending || selectedCount === 0}
              onClick={() => {
                const targets = members
                  .filter((m) => liveSelected.has(rosterEntryKey(m)))
                  .map(removalTarget);
                if (targets.length > 0) {
                  remove.mutate({ ccaID, targets });
                }
              }}
              className="inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:pointer-events-none disabled:opacity-50"
            >
              {remove.isPending
                ? "Removing…"
                : `Remove ${selectedCount} ${selectedCount === 1 ? "member" : "members"}`}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
