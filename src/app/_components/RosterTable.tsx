"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Checkbox } from "~/components/ui/checkbox";
import type { RosterEntry } from "~/server/api/services/ccaRoster";

/**
 * DISPLAY ONLY — the same rule CcaBadges and RoleBadges state. Nothing here is
 * the basis of a permission decision.
 *
 * Rendered by BOTH /cca/[ccaID] (a head viewing their own CCA) and
 * /admin/ccas (a manager viewing any CCA). One component, because the two
 * surfaces show the same thing to different audiences — if this ever needs to
 * fork, that is a signal something upstream was designed wrong.
 *
 * THE AMBER ROWS ARE THE POINT. A membership record that resolves to no account
 * is real data drift, and this is the only place anyone will ever see it. It is
 * NOT filtered out: 07-cca-future.md §3 names the client-side .filter() as the
 * anti-pattern that hides the problem it is hiding from.
 */

/**
 * Stable identity for a roster entry, namespaced so a resolved User.id can
 * never collide with an unresolved membership key. Exported so the selection
 * state in RosterPanel and the checkboxes here agree on exactly one key per row.
 */
export function rosterEntryKey(entry: RosterEntry): string {
  return entry.kind === "resolved" ? `u:${entry.userId}` : `k:${entry.key}`;
}

/** Everything RosterPanel threads in to make the members table selectable. */
export type RosterSelection = {
  selectedKeys: Set<string>;
  onToggle: (entry: RosterEntry) => void;
  onToggleAll: () => void;
  /** true = all selected, false = none, "indeterminate" = some. */
  headerState: boolean | "indeterminate";
  disabled: boolean;
};

/** Head vs member, labelled on BOTH states — see the note in CcaBadges. */
function RoleLabel({ isHead }: { isHead: boolean }) {
  return isHead ? (
    <span className="shrink-0 rounded-full border border-indigo-300 bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-800">
      Head
    </span>
  ) : (
    <span className="shrink-0 text-xs text-gray-400">Member</span>
  );
}

/**
 * The copy here is load-bearing. It must say "we cannot match this record to an
 * account" and must NOT imply the person is absent — a member whose NUS email
 * doesn't match the canonical guess (a Google sign-in on a personal address, a
 * merged account) lands here, and "Unknown" alone reads as "Jane isn't in the
 * roster", which is a different and wrong conclusion.
 */
function unresolvedCopy(entry: Extract<RosterEntry, { kind: "unresolved" }>) {
  return entry.reason === "AMBIGUOUS_KEY"
    ? {
        label: `Ambiguous record (${entry.key})`,
        detail: `${entry.candidateUserIds.length} accounts claim this membership record, so we can't tell which person it belongs to. It has not been guessed. Contact the JCRC to have the duplicate accounts merged.`,
      }
    : {
        label: `Unmatched record (${entry.key})`,
        detail:
          "This membership record doesn't match any account we can find. It may predate the account migration, or the member may sign in with a different address. They are still a member — we just can't show their details.",
      };
}

function SelectCell({
  entry,
  selection,
}: {
  entry: RosterEntry;
  selection: RosterSelection;
}) {
  const checked = selection.selectedKeys.has(rosterEntryKey(entry));
  return (
    <TableCell className="w-0 pr-0">
      <Checkbox
        checked={checked}
        disabled={selection.disabled}
        onCheckedChange={() => selection.onToggle(entry)}
        aria-label={
          entry.kind === "resolved"
            ? `Select ${entry.displayName ?? entry.email}`
            : `Select ${entry.key}`
        }
      />
    </TableCell>
  );
}

function EntryRow({
  entry,
  selection,
}: {
  entry: RosterEntry;
  selection?: RosterSelection;
}) {
  const duplicate = entry.userCcaRowCount > 1;
  const selected =
    selection?.selectedKeys.has(rosterEntryKey(entry)) ?? false;

  if (entry.kind === "unresolved") {
    const { label, detail } = unresolvedCopy(entry);
    return (
      <TableRow
        className={selected ? "bg-amber-100" : "border-amber-200 bg-amber-50"}
      >
        {selection && <SelectCell entry={entry} selection={selection} />}
        <TableCell className="font-medium text-amber-900">
          <span title={detail}>{label}</span>
          {duplicate && (
            <span className="ml-2 text-xs font-normal text-amber-700">
              · {entry.userCcaRowCount} membership records
            </span>
          )}
        </TableCell>
        <TableCell className="text-amber-700">—</TableCell>
        <TableCell className="text-right">
          <RoleLabel isHead={entry.isHead} />
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow className={selected ? "bg-emerald-50" : undefined}>
      {selection && <SelectCell entry={entry} selection={selection} />}
      <TableCell className="font-medium text-gray-900">
        {entry.displayName ?? (
          <span className="text-gray-500">No name on file</span>
        )}
        {duplicate && (
          <span
            className="ml-2 text-xs font-normal text-amber-700"
            title="This person has more than one membership record for this CCA. Harmless, but worth cleaning up."
          >
            · {entry.userCcaRowCount} membership records
          </span>
        )}
      </TableCell>
      <TableCell className="text-gray-600">{entry.email}</TableCell>
      <TableCell className="text-right">
        <RoleLabel isHead={entry.isHead} />
      </TableCell>
    </TableRow>
  );
}

export default function RosterTable({
  title,
  entries,
  emptyCopy,
  /**
   * When provided, each row gets a selection checkbox and the header gets a
   * select-all. Passed ONLY to the members table on a head's own dashboard —
   * the heads table and the read-only /admin/ccas viewer leave it undefined, so
   * the column never appears there. Removal is still authorised server-side by
   * assertHeadsCca; this only decides whether to draw the checkboxes.
   */
  selection,
}: {
  title: string;
  entries: RosterEntry[];
  emptyCopy: string;
  selection?: RosterSelection;
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
        {title}
        <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
          {entries.length}
        </span>
      </h2>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
          {emptyCopy}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                {selection && (
                  <TableHead className="w-0 pr-0">
                    <Checkbox
                      checked={selection.headerState}
                      disabled={selection.disabled}
                      onCheckedChange={() => selection.onToggleAll()}
                      aria-label="Select all members"
                    />
                  </TableHead>
                )}
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <EntryRow
                  key={rosterEntryKey(e)}
                  entry={e}
                  selection={selection}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
