"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

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
import {
  MAX_ACTIVITIES,
  PERIOD_LABEL,
  REMOVE_ACTIVITY_CONFIRMATION,
  activityCountLine,
  readPeriod,
} from "~/lib/transcript/activities";
import type { MemberOption } from "~/lib/transcript/activityEditor";
import { errorText } from "~/lib/transcript/adminView";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import ActivityEditorDialog, { type EditableActivity } from "./ActivityEditor";

export interface ActivityListItem extends EditableActivity {
  removed: boolean;
  removedByName: string | null;
  removedAt: Date | string | null;
}

export const ACTIVITIES_HELPER =
  "Things this CCA did during the year. Each person ticked gets the activity on their transcript, under this CCA. People outside the CCA appear under Other involvement.";

export const ACTIVITIES_FULL_NOTE = `This CCA has ${MAX_ACTIVITIES} activities for the year. Remove one to add another.`;

export interface ActivitiesSectionViewProps {
  academicYear: string;
  activeCount: number;
  max: number;
  items: ActivityListItem[];
  showRemoved: boolean;
  onShowRemoved: (value: boolean) => void;
  /** Why the year cannot be edited, or null. Hides every action. */
  readOnlyNote: string | null;
  readOnly: boolean;
  loadError: string | null;
  actionError: string | null;
  /** The activity whose removal is being confirmed. */
  removing: { id: string; title: string } | null;
  onRemoving: (item: { id: string; title: string } | null) => void;
  onRemove: () => void;
  onRestore: (id: string) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  busy: boolean;
}

/** The "Activities" card: the count, Add activity, the list, Show removed. */
export function ActivitiesSectionView(p: ActivitiesSectionViewProps) {
  const full = p.activeCount >= p.max;
  return (
    <AlertDialog
      open={p.removing !== null}
      onOpenChange={(o) => !o && !p.busy && p.onRemoving(null)}
    >
      <SectionCard title="Activities" description={ACTIVITIES_HELPER}>
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm font-medium text-gray-900">
            {activityCountLine(p.activeCount)}
          </p>
          {!p.readOnly && (
            <Button
              type="button"
              size="sm"
              disabled={full || p.busy}
              onClick={p.onAdd}
            >
              Add activity
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
        {!p.readOnly && full && (
          <p className="mb-3 text-sm text-gray-600" role="status">
            {ACTIVITIES_FULL_NOTE}
          </p>
        )}
        <ErrorLine message={p.loadError ?? p.actionError} />

        {p.items.length === 0 ? (
          <p className="text-sm text-gray-500">
            {p.showRemoved
              ? "No activities, removed or not, for this year."
              : `No activities for ${p.academicYear} yet.`}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {p.items.map((item) => (
              <ActivityItem key={item.id} item={item} view={p} />
            ))}
          </ul>
        )}
      </SectionCard>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {p.removing ? `Remove ${p.removing.title}?` : "Remove activity?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {REMOVE_ACTIVITY_CONFIRMATION}
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

function ActivityItem({
  item,
  view,
}: {
  item: ActivityListItem;
  view: ActivitiesSectionViewProps;
}) {
  const people = item.participants.length;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <p
          className={`text-sm font-medium ${item.removed ? "text-gray-500 line-through" : "text-gray-900"}`}
        >
          {item.title}
          <span className="ml-2 text-xs font-normal text-gray-500 no-underline">
            {PERIOD_LABEL[readPeriod(item.period)]}
          </span>
        </p>
        {item.description && (
          <p className="mt-0.5 text-xs text-gray-600">{item.description}</p>
        )}
        <p className="mt-0.5 text-xs text-gray-500">
          {people} {people === 1 ? "person" : "people"}
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
      {!view.readOnly && (
        <div className="flex gap-2">
          {item.removed ? (
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
          ) : (
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
        </div>
      )}
    </li>
  );
}

/**
 * Wires the card to activities.list / remove / restore, and opens the editor.
 * The CCA's members (from the roster) are the tick list.
 */
export default function ActivitiesSection({
  ccaID,
  academicYear,
  members,
  readOnly,
  readOnlyNote,
}: {
  ccaID: number;
  academicYear: string;
  members: MemberOption[];
  readOnly: boolean;
  readOnlyNote: string | null;
}) {
  const utils = api.useUtils();
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const list = api.transcriptManage.activities.list.useQuery(
    { ccaID, academicYear, includeRemoved: showRemoved },
    { enabled: academicYear !== "", retry: false },
  );
  const refresh = () => utils.transcriptManage.activities.list.invalidate();
  const remove = api.transcriptManage.activities.remove.useMutation({
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });
  const restore = api.transcriptManage.activities.restore.useMutation({
    onSuccess: refresh,
  });

  const items: ActivityListItem[] = list.data?.activities ?? [];
  const editable = items.find((i) => i.id === editing) ?? null;
  const error = remove.error ?? restore.error;

  return (
    <>
      <ActivitiesSectionView
        academicYear={academicYear}
        activeCount={list.data?.activeCount ?? 0}
        max={list.data?.max ?? MAX_ACTIVITIES}
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
        busy={remove.isPending || restore.isPending}
      />
      {editing !== null && (editing === "new" || editable) && (
        <ActivityEditorDialog
          key={editing}
          ccaID={ccaID}
          academicYear={academicYear}
          activity={editing === "new" ? null : editable}
          members={members}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
