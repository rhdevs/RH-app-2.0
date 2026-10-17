"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ErrorLine,
  SectionCard,
} from "~/app/admin/transcripts/_components/Bits";
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
import type { MemberOption } from "~/lib/transcript/activityEditor";
import { errorText } from "~/lib/transcript/adminView";
import { formatSgDate } from "~/lib/transcript/sgDate";
import {
  DISCARD_CHANGES_QUESTION,
  mayLeave,
} from "~/lib/transcript/useUnsavedChangesGuard";
import {
  KIND_LABEL,
  REMOVE_VOLUNTEER_ACTIVITY_CONFIRMATION,
  formatVolunteerHours,
  readKind,
  volunteerCountLine,
} from "~/lib/transcript/volunteer";
import { api } from "~/trpc/react";
import VolunteerAttendance from "./VolunteerAttendance";
import VolunteerEditorDialog from "./VolunteerEditor";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

export interface VolunteerListItem {
  id: string;
  title: string;
  kind: string;
  description: string;
  peopleCount: number;
  totalHours: number;
  removed: boolean;
  removedByName: string | null;
  removedAt: Date | string | null;
}

export const VOLUNTEER_HELPER =
  "Hours are recorded by activity. Choose who took part, add a session for each time you met, and tick who attended. Each person's total appears on their transcript.";

export interface VolunteerSectionViewProps {
  academicYear: string;
  activeCount: number;
  items: VolunteerListItem[];
  showRemoved: boolean;
  onShowRemoved: (value: boolean) => void;
  /** Why the year cannot be edited, or null. Hides every action. */
  readOnlyNote: string | null;
  readOnly: boolean;
  loadError: string | null;
  actionError: string | null;
  removing: { id: string; title: string } | null;
  onRemoving: (item: { id: string; title: string } | null) => void;
  onRemove: () => void;
  onRestore: (id: string) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  /** The activity whose attendance is open. */
  openID: string | null;
  onOpen: (id: string | null) => void;
  /** The attendance panel of the open activity. */
  panel: ReactNode;
  busy: boolean;
}

/** The "Volunteer hours" card: the count, Add, the list, Show removed. */
export function VolunteerSectionView(p: VolunteerSectionViewProps) {
  const returnFocus = useReturnFocus();
  return (
    <AlertDialog
      open={p.removing !== null}
      onOpenChange={(o) => !o && !p.busy && p.onRemoving(null)}
    >
      <SectionCard title="Volunteer hours" description={VOLUNTEER_HELPER}>
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm font-medium text-gray-900">
            {volunteerCountLine(p.activeCount)}
          </p>
          {!p.readOnly && (
            <Button type="button" size="sm" disabled={p.busy} onClick={p.onAdd}>
              Add volunteer activity
            </Button>
          )}
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={p.showRemoved}
              onChange={(e) => p.onShowRemoved(e.target.checked)}
            />
            Show removed
          </label>
        </div>
        {p.readOnlyNote && (
          <p className="mb-3 text-sm text-amber-800" role="status">
            {p.readOnlyNote}
          </p>
        )}
        <ErrorLine message={p.loadError ?? p.actionError} />

        {p.items.length === 0 ? (
          <p className="text-sm text-gray-500">
            {p.showRemoved
              ? "No volunteer activities, removed or not, for this year."
              : `No volunteer activities for ${p.academicYear} yet.`}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {p.items.map((item) => (
              <VolunteerItem key={item.id} item={item} view={p} />
            ))}
          </ul>
        )}
      </SectionCard>

      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {p.removing ? `Remove ${p.removing.title}?` : "Remove activity?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {REMOVE_VOLUNTEER_ACTIVITY_CONFIRMATION}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={p.actionError} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.busy}>Cancel</AlertDialogCancel>
          <Button type="button" onClick={p.onRemove} disabled={p.busy}>
            {p.busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Removing
              </>
            ) : (
              "Remove activity"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function VolunteerItem({
  item,
  view,
}: {
  item: VolunteerListItem;
  view: VolunteerSectionViewProps;
}) {
  const open = view.openID === item.id && !item.removed;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <p
            className={`text-sm font-medium ${item.removed ? "text-gray-500 line-through" : "text-gray-900"}`}
          >
            {item.title}
            <span className="ml-2 text-xs font-normal text-gray-500 no-underline">
              {KIND_LABEL[readKind(item.kind)]}
            </span>
          </p>
          {item.description && (
            <p className="mt-0.5 text-xs text-gray-600">{item.description}</p>
          )}
          <p className="mt-0.5 text-xs text-gray-500">
            {item.peopleCount} {item.peopleCount === 1 ? "person" : "people"}
            {" · "}
            {formatVolunteerHours(item.totalHours)}{" "}
            {item.totalHours === 1 ? "hour" : "hours"} in total
            {item.removed && (
              <>
                {" "}
                · Removed
                {item.removedByName ? ` by ${item.removedByName}` : ""}
                {item.removedAt ? ` on ${formatSgDate(item.removedAt)}` : ""}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {item.removed ? (
            !view.readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={view.busy}
                aria-label={`Restore ${item.title}`}
                onClick={() => view.onRestore(item.id)}
              >
                Restore
              </Button>
            )
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Open"} attendance for ${item.title}`}
                onClick={() => view.onOpen(open ? null : item.id)}
              >
                {open ? "Hide attendance" : "Attendance"}
              </Button>
              {!view.readOnly && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Edit ${item.title}`}
                    onClick={() => view.onEdit(item.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${item.title}`}
                    onClick={() =>
                      view.onRemoving({ id: item.id, title: item.title })
                    }
                  >
                    Remove
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-3 rounded-md border border-gray-200 p-2 sm:p-3">
          {view.panel}
        </div>
      )}
    </li>
  );
}

/**
 * Wires the card to the volunteer activity procedures, and opens the editor and
 * the attendance grid. The CCA's members (from the roster) are the tick list.
 */
export default function VolunteerSection({
  ccaID,
  academicYear,
  members,
  readOnly,
  readOnlyNote,
  onUnsavedChange,
}: {
  ccaID: number;
  academicYear: string;
  members: MemberOption[];
  readOnly: boolean;
  readOnlyNote: string | null;
  /** Unsaved attendance ticks plus 1 for an open editor with changes. */
  onUnsavedChange?: (count: number) => void;
}) {
  const utils = api.useUtils();
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [openID, setOpenID] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const report = useRef(onUnsavedChange);
  report.current = onUnsavedChange;
  const total = unsaved + (editorDirty ? 1 : 0);
  useEffect(() => {
    report.current?.(total);
  }, [total]);
  useEffect(() => () => report.current?.(0), []);
  const [removing, setRemoving] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const list = api.transcriptManage.volunteer.activities.list.useQuery(
    { ccaID, academicYear, includeRemoved: showRemoved },
    { enabled: academicYear !== "", retry: false },
  );
  const refresh = () =>
    utils.transcriptManage.volunteer.activities.list.invalidate();
  const remove = api.transcriptManage.volunteer.activities.remove.useMutation({
    onSuccess: async () => {
      if (removing?.id === openID) setOpenID(null);
      setRemoving(null);
      await refresh();
    },
  });
  const restore = api.transcriptManage.volunteer.activities.restore.useMutation(
    { onSuccess: refresh },
  );

  const items: VolunteerListItem[] = list.data?.activities ?? [];
  const error = remove.error ?? restore.error;
  const leave = () =>
    mayLeave(unsaved > 0, () => window.confirm(DISCARD_CHANGES_QUESTION));

  return (
    <>
      <VolunteerSectionView
        academicYear={academicYear}
        activeCount={list.data?.activeCount ?? 0}
        items={items}
        showRemoved={showRemoved}
        onShowRemoved={setShowRemoved}
        readOnly={readOnly}
        readOnlyNote={readOnlyNote}
        loadError={list.error ? errorText(list.error.message) : null}
        actionError={error ? errorText(error.message) : null}
        removing={removing}
        onRemoving={(item) => {
          remove.reset();
          setRemoving(item);
        }}
        onRemove={() => removing && remove.mutate({ id: removing.id, ccaID })}
        onRestore={(id) => {
          remove.reset();
          restore.mutate({ id, ccaID });
        }}
        onAdd={() => setEditing("new")}
        onEdit={setEditing}
        openID={openID}
        onOpen={(id) => {
          if (leave()) setOpenID(id);
        }}
        panel={
          openID && (
            <VolunteerAttendance
              key={openID}
              ccaID={ccaID}
              activityID={openID}
              readOnly={readOnly}
              onUnsavedChange={setUnsaved}
            />
          )
        }
        busy={remove.isPending || restore.isPending}
      />
      {editing !== null && (
        <VolunteerEditorDialog
          key={editing}
          ccaID={ccaID}
          academicYear={academicYear}
          activityID={editing === "new" ? null : editing}
          members={members}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
          onDirtyChange={setEditorDirty}
        />
      )}
    </>
  );
}
