"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

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

/**
 * Full profile detail for one member, keyed by rosterEntryKey. Supplied only on
 * the head's own member list (via cca.memberDirectory); when absent the rows
 * are not expandable and the table behaves exactly as before.
 */
export type MemberDetail = {
  resolved: boolean;
  role: "Head" | "Member";
  name: string | null;
  email: string | null;
  userID: string | null;
  matric: string | null;
  block: number | null;
  telegramHandle: string | null;
  bio: string | null;
  membershipRecords: number;
  joinedAt: string | null;
  note: string | null;
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
    // stopPropagation so ticking the box never also expands the row.
    <TableCell className="w-0 pr-0" onClick={(e) => e.stopPropagation()}>
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

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
        {label}
      </dt>
      <dd
        className="truncate text-sm text-gray-800"
        title={value ?? undefined}
      >
        {value ?? <span className="text-gray-300">—</span>}
      </dd>
    </div>
  );
}

/** The expanded detail panel shown under a member row when it is opened. */
function DetailRow({
  detail,
  colSpan,
}: {
  detail: MemberDetail;
  colSpan: number;
}) {
  const telegram = detail.telegramHandle ? `@${detail.telegramHandle}` : null;
  const headSince =
    detail.role === "Head" && detail.joinedAt
      ? new Date(detail.joinedAt).toLocaleDateString("en-SG", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;

  const fields: { label: string; value: string | null }[] = [
    { label: "Matric", value: detail.matric },
    { label: "Block", value: detail.block != null ? String(detail.block) : null },
    { label: "Email", value: detail.email },
    { label: "Telegram", value: telegram },
    { label: "User ID", value: detail.userID },
    { label: "Membership records", value: String(detail.membershipRecords) },
    ...(headSince ? [{ label: "Head since", value: headSince }] : []),
  ];

  return (
    <TableRow className="bg-gray-50 hover:bg-gray-50">
      <TableCell colSpan={colSpan} className="py-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          {fields.map((f) => (
            <Field key={f.label} label={f.label} value={f.value} />
          ))}
        </dl>
        {detail.bio?.trim() && (
          <div className="mt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
              About
            </p>
            <p className="mt-0.5 whitespace-pre-line text-sm text-gray-700">
              {detail.bio}
            </p>
          </div>
        )}
        {detail.note && (
          <p className="mt-3 text-sm text-amber-700">{detail.note}</p>
        )}
      </TableCell>
    </TableRow>
  );
}

function EntryRow({
  entry,
  selection,
  detail,
  expanded,
  onToggleExpand,
  colSpan,
  showEmail,
}: {
  entry: RosterEntry;
  selection?: RosterSelection;
  /** When present, the row is expandable and reveals full member details. */
  detail?: MemberDetail;
  expanded: boolean;
  onToggleExpand: () => void;
  colSpan: number;
  /** Mirrors RosterTable's prop — see it for why this is not a guard. */
  showEmail: boolean;
}) {
  const duplicate = entry.userCcaRowCount > 1;
  const selected =
    selection?.selectedKeys.has(rosterEntryKey(entry)) ?? false;
  const expandable = detail != null;

  if (entry.kind === "unresolved") {
    const { label, detail: tip } = unresolvedCopy(entry);
    return (
      <TableRow
        className={selected ? "bg-amber-100" : "border-amber-200 bg-amber-50"}
      >
        {selection && <SelectCell entry={entry} selection={selection} />}
        <TableCell className="font-medium text-amber-900">
          <span title={tip}>{label}</span>
          {duplicate && (
            <span className="ml-2 text-xs font-normal text-amber-700">
              · {entry.userCcaRowCount} membership records
            </span>
          )}
        </TableCell>
        {showEmail && (
          <TableCell className="text-amber-700">—</TableCell>
        )}
        <TableCell className="text-right">
          <RoleLabel isHead={entry.isHead} />
        </TableCell>
      </TableRow>
    );
  }

  return (
    <Fragment>
      <TableRow
        className={[
          selected ? "bg-emerald-50" : undefined,
          expandable ? "cursor-pointer" : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={expandable ? onToggleExpand : undefined}
        aria-expanded={expandable ? expanded : undefined}
      >
        {selection && <SelectCell entry={entry} selection={selection} />}
        <TableCell className="font-medium text-gray-900">
          <span className="inline-flex items-center gap-1.5">
            {expandable &&
              (expanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
              ))}
            {entry.displayName ?? (
              <span className="text-gray-500">No name on file</span>
            )}
          </span>
          {duplicate && (
            <span
              className="ml-2 text-xs font-normal text-amber-700"
              title="This person has more than one membership record for this CCA. Harmless, but worth cleaning up."
            >
              · {entry.userCcaRowCount} membership records
            </span>
          )}
        </TableCell>
        {showEmail && (
          <TableCell className="text-gray-600">{entry.email}</TableCell>
        )}
        <TableCell className="text-right">
          <RoleLabel isHead={entry.isHead} />
        </TableCell>
      </TableRow>
      {expandable && expanded && (
        <DetailRow detail={detail} colSpan={colSpan} />
      )}
    </Fragment>
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
  /**
   * Per-member full details, keyed by rosterEntryKey. Supplied only on a head's
   * own member list; when present, resolved rows become expandable to reveal
   * matric, block, telegram, etc. Absent on the read-only viewer, so nothing
   * there is clickable.
   */
  details,
  /**
   * DEFAULT TRUE, so every existing caller is unchanged.
   *
   * Set false by the hall-office viewer, whose roster arrives from the server
   * with `email` already NULLED (cca.getRoster redacts on the `readOnly` tier —
   * see redactRosterForReadOnly). This flag does not hide anything the client
   * holds; it stops the table drawing a column header over data the server
   * declined to send, which reads as broken rather than as deliberate.
   *
   * It is presentation only and must never be mistaken for a guard: passing
   * `showEmail` has no effect on what the server returns, and passing it TRUE
   * on a redacted roster shows an empty column, not an address.
   */
  showEmail = true,
}: {
  title: string;
  entries: RosterEntry[];
  emptyCopy: string;
  selection?: RosterSelection;
  details?: Map<string, MemberDetail>;
  showEmail?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Name + Role, plus Email when shown and the select column when present. The
  // expanded detail row spans all of them, so this must track both flags or the
  // detail panel stops lining up with the table above it.
  const colSpan = (selection ? 1 : 0) + (showEmail ? 1 : 0) + 2;

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
                {showEmail && <TableHead>Email</TableHead>}
                <TableHead className="text-right">Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => {
                const key = rosterEntryKey(e);
                const detail =
                  e.kind === "resolved" ? details?.get(key) : undefined;
                return (
                  <EntryRow
                    key={key}
                    entry={e}
                    selection={selection}
                    detail={detail}
                    expanded={expanded.has(key)}
                    onToggleExpand={() => toggleExpand(key)}
                    colSpan={colSpan}
                    showEmail={showEmail}
                  />
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
