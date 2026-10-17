"use client";

import { Loader2, X } from "lucide-react";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ErrorLine,
  FIELD_LABEL,
} from "~/app/admin/transcripts/_components/Bits";
import ResidentPicker, {
  DEFAULT_PLACEHOLDER,
  HEAD_PLACEHOLDER,
} from "~/app/admin/transcripts/_components/ResidentPicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  filterMembers,
  saveThenPeople,
  type MemberOption,
} from "~/lib/transcript/activityEditor";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import { REFRESH_FAILED_NOTE, counterText } from "~/lib/transcript/headView";
import { useUnsavedChangesGuard } from "~/lib/transcript/useUnsavedChangesGuard";
import {
  KIND_LABEL,
  VOLUNTEER_DESCRIPTION_MAX,
  VOLUNTEER_KINDS,
  VOLUNTEER_TITLE_MAX,
  type VolunteerKind,
} from "~/lib/transcript/volunteer";
import {
  addPerson,
  clearAll,
  emptyVolunteerDraft,
  hoursText,
  isPicked,
  isVolunteerDirty,
  outsiders,
  parseVolunteerHours,
  removePerson,
  selectAll,
  togglePerson,
  volunteerDraftOf,
  volunteerFields,
  volunteerProblem,
  type VolunteerDraft,
} from "~/lib/transcript/volunteerEditor";
import { peopleCountLine } from "~/lib/transcript/activityEditor";
import { api } from "~/trpc/react";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

export interface VolunteerEditorViewProps {
  mode: "add" | "edit";
  draft: VolunteerDraft;
  onChange: (next: VolunteerDraft) => void;
  members: MemberOption[];
  filter: string;
  onFilter: (query: string) => void;
  picker: ReactNode;
  /** An existing activity's type cannot change. */
  kindLocked: boolean;
  readOnly: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  /** A non-blocking line: the latest refresh failed but nothing was lost. */
  refreshNote?: string | null;
  onSave: () => void;
  onCancel: () => void;
}

/** The form. Presentational: the dialog owns the state and the save. */
export function VolunteerEditorView(p: VolunteerEditorViewProps) {
  const d = p.draft;
  const shown = filterMembers(p.members, p.filter);
  const outside = outsiders(d, p.members);
  const problem = volunteerProblem(d);
  const set = (patch: Partial<VolunteerDraft>) =>
    p.onChange({ ...d, ...patch });
  const oneoff = d.kind === "oneoff";

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!p.readOnly && !problem && !p.saving) p.onSave();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <div>
          <label htmlFor="vol-title" className={FIELD_LABEL}>
            Title
          </label>
          <Input
            id="vol-title"
            value={d.title}
            maxLength={VOLUNTEER_TITLE_MAX}
            disabled={p.readOnly}
            onChange={(e) => set({ title: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(d.title, VOLUNTEER_TITLE_MAX)}
          </p>
        </div>
        <div>
          <label htmlFor="vol-kind" className={FIELD_LABEL}>
            Type
          </label>
          <select
            id="vol-kind"
            value={d.kind}
            disabled={p.readOnly || p.kindLocked}
            onChange={(e) => set({ kind: e.target.value as VolunteerKind })}
            className={SELECT}
          >
            {VOLUNTEER_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="vol-description" className={FIELD_LABEL}>
          Description (optional)
        </label>
        <Textarea
          id="vol-description"
          rows={2}
          value={d.description}
          maxLength={VOLUNTEER_DESCRIPTION_MAX}
          disabled={p.readOnly}
          onChange={(e) => set({ description: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(d.description, VOLUNTEER_DESCRIPTION_MAX)}
        </p>
      </div>

      {oneoff ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="vol-date" className={FIELD_LABEL}>
              Date
            </label>
            <Input
              id="vol-date"
              type="date"
              value={d.date}
              disabled={p.readOnly}
              onChange={(e) => set({ date: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="vol-hours" className={FIELD_LABEL}>
              Hours
            </label>
            <Input
              id="vol-hours"
              inputMode="decimal"
              value={d.hours}
              disabled={p.readOnly}
              onChange={(e) => set({ hours: e.target.value })}
            />
            <ErrorLine message={hoursText(d.hours)} />
          </div>
        </div>
      ) : (
        <div className="max-w-[12rem]">
          <label htmlFor="vol-default-hours" className={FIELD_LABEL}>
            Default hours per session (optional)
          </label>
          <Input
            id="vol-default-hours"
            inputMode="decimal"
            value={d.defaultHours}
            disabled={p.readOnly}
            onChange={(e) => set({ defaultHours: e.target.value })}
          />
          <ErrorLine message={hoursText(d.defaultHours)} />
        </div>
      )}

      <fieldset>
        <legend className={FIELD_LABEL}>People (CCA members)</legend>
        <div className="mb-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1">
            <label htmlFor="vol-filter" className="sr-only">
              Filter members by name
            </label>
            <Input
              id="vol-filter"
              type="search"
              autoComplete="off"
              placeholder="Filter members by name"
              value={p.filter}
              onChange={(e) => p.onFilter(e.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={p.readOnly || shown.length === 0}
            onClick={() => p.onChange(selectAll(d, shown))}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={p.readOnly || shown.length === 0}
            onClick={() => p.onChange(clearAll(d, shown))}
          >
            Clear all
          </Button>
        </div>
        {p.members.length === 0 ? (
          <p className="text-sm text-gray-500">
            This CCA has no members to list for this year. You can still add
            people below.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-gray-500">No member matches that name.</p>
        ) : (
          <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200">
            {shown.map((m) => (
              <li key={m.userID}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-gray-900 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={isPicked(d, m.userID)}
                    disabled={p.readOnly}
                    onChange={() => p.onChange(togglePerson(d, m))}
                  />
                  {m.displayName ?? m.userID}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div>
        <p className={FIELD_LABEL}>Add someone outside the CCA</p>
        {outside.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2">
            {outside.map((person) => (
              <li
                key={person.userID}
                className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-50 py-0.5 pl-3 pr-1 text-sm text-gray-900"
              >
                {person.displayName ?? person.userID}
                {!p.readOnly && (
                  <button
                    type="button"
                    className="rounded-full p-1 text-gray-600 hover:bg-gray-200"
                    aria-label={`Remove ${person.displayName ?? person.userID}`}
                    onClick={() => p.onChange(removePerson(d, person.userID))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!p.readOnly && p.picker}
      </div>

      <p className="text-sm text-gray-700" role="status">
        {peopleCountLine(d.people.length)}
      </p>

      <ErrorLine message={problem && p.dirty ? problem : p.error} />
      {p.refreshNote && (
        <p className="text-sm text-amber-800" role="status">
          {p.refreshNote}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={p.saving}
          onClick={p.onCancel}
        >
          {p.readOnly ? "Close" : "Cancel"}
        </Button>
        {!p.readOnly && (
          <Button
            type="submit"
            disabled={!p.dirty || p.saving || problem !== null}
          >
            {p.saving ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Saving
              </>
            ) : p.mode === "add" ? (
              "Add volunteer activity"
            ) : (
              "Save activity"
            )}
          </Button>
        )}
      </div>
    </form>
  );
}

function EditorShell({
  editing,
  onClose,
  children,
}: {
  editing: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        {...returnFocus}
        className="h-[100dvh] max-w-none overflow-y-auto rounded-none sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit volunteer activity" : "Add volunteer activity"}
          </DialogTitle>
          <DialogDescription>
            Choose who took part. Hours come from the sessions each person
            attended, which you tick in the attendance grid.
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function EditorDialogBody({
  ccaID,
  academicYear,
  activityID,
  initial,
  members,
  readOnly,
  onClose,
  onDirtyChange,
  refreshFailed,
}: {
  ccaID: number;
  academicYear: string;
  activityID: string | null;
  initial: VolunteerDraft;
  members: MemberOption[];
  readOnly: boolean;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** A background refresh failed; the editor keeps its data and says so. */
  refreshFailed?: boolean;
}) {
  const utils = api.useUtils();
  const roles: readonly string[] = useSession().data?.user.roles ?? [];
  const isManager = roles.includes("admin") || roles.includes("jcrc");
  const [draft, setDraft] = useState<VolunteerDraft>(initial);
  const [filter, setFilter] = useState("");
  const [createdID, setCreatedID] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = api.transcriptManage.volunteer.activities.create.useMutation();
  const update = api.transcriptManage.volunteer.activities.update.useMutation();
  const setPeople = api.transcriptManage.volunteer.people.set.useMutation();

  const dirty = isVolunteerDirty(draft, initial);

  // Tell the page while this editor holds unsaved changes (cleared on unmount).
  const dirtyRef = useRef(onDirtyChange);
  dirtyRef.current = onDirtyChange;
  useEffect(() => {
    dirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyRef.current?.(false), []);
  const confirmLeave = useUnsavedChangesGuard(dirty);
  const close = () => {
    if (confirmLeave()) onClose();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const oneoff = draft.kind === "oneoff";
      const session = oneoff
        ? { date: draft.date, hours: parseVolunteerHours(draft.hours)! }
        : {};
      await saveThenPeople({
        existingID: activityID ?? createdID,
        update: (existing) =>
          update.mutateAsync({
            id: existing,
            ccaID,
            ...volunteerFields(draft),
            ...session,
          }),
        create: () =>
          create.mutateAsync({
            ccaID,
            academicYear,
            kind: draft.kind,
            ...volunteerFields(draft),
            ...session,
          }),
        // The activity exists from here on: show it in the list and make the
        // editor an editor of that id, so a retry cannot create a copy.
        onCreated: async (made) => {
          setCreatedID(made);
          await utils.transcriptManage.volunteer.activities.list.invalidate();
        },
        setPeople: (made) =>
          setPeople.mutateAsync({
            activityID: made,
            ccaID,
            userIDs: draft.people.map((p) => p.userID),
          }),
      });
      await Promise.all([
        utils.transcriptManage.volunteer.activities.list.invalidate(),
        utils.transcriptManage.volunteer.activities.get.invalidate(),
      ]);
      onClose();
    } catch (e) {
      const err = e as {
        message?: string;
        data?: {
          zodError?: {
            fieldErrors?: Record<string, string[] | undefined>;
          } | null;
        };
      };
      const zod = err.data?.zodError ?? null;
      setError(
        fieldError(zod, "title") ??
          fieldError(zod, "description") ??
          fieldError(zod, "date") ??
          fieldError(zod, "hours") ??
          errorText(err.message),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorShell
      editing={activityID !== null}
      onClose={() => !saving && close()}
    >
      <VolunteerEditorView
        mode={activityID || createdID ? "edit" : "add"}
        draft={draft}
        onChange={(next) => {
          setError(null);
          setDraft(next);
        }}
        members={members}
        filter={filter}
        onFilter={setFilter}
        picker={
          <ResidentPicker
            idPrefix="vol-person"
            label="Search by name"
            placeholder={isManager ? DEFAULT_PLACEHOLDER : HEAD_PLACEHOLDER}
            hideSelectedMatric
            selected={null}
            onSelect={(r) =>
              setDraft((current) =>
                addPerson(current, {
                  userID: r.userID,
                  displayName: r.displayName,
                }),
              )
            }
            onClear={() => undefined}
          />
        }
        kindLocked={activityID !== null || createdID !== null}
        readOnly={readOnly}
        saving={saving}
        dirty={dirty}
        error={error}
        refreshNote={refreshFailed ? REFRESH_FAILED_NOTE : null}
        onSave={() => void save()}
        onCancel={close}
      />
    </EditorShell>
  );
}

/**
 * The dialog on a desktop, a full-screen sheet on a phone. Saving writes the
 * activity, then replaces its people; if the second step fails the editor stays
 * open on the saved activity, so a retry never makes a copy.
 */
export default function VolunteerEditorDialog({
  ccaID,
  academicYear,
  activityID,
  members,
  readOnly,
  onClose,
  onDirtyChange,
}: {
  ccaID: number;
  academicYear: string;
  /** The activity being edited, or null to add one. */
  activityID: string | null;
  members: MemberOption[];
  readOnly: boolean;
  onClose: () => void;
  /** Called with true while the editor holds unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const detail = api.transcriptManage.volunteer.activities.get.useQuery(
    { id: activityID ?? "", ccaID },
    { enabled: activityID !== null, retry: false },
  );

  if (activityID === null) {
    return (
      <EditorDialogBody
        ccaID={ccaID}
        academicYear={academicYear}
        activityID={null}
        initial={emptyVolunteerDraft()}
        members={members}
        readOnly={readOnly}
        onClose={onClose}
        onDirtyChange={onDirtyChange}
      />
    );
  }
  // The blocking error is only for when there is nothing to show. A refresh
  // that failed behind data already on screen must not throw the edits away.
  if (!detail.data) {
    return (
      <EditorShell editing onClose={onClose}>
        {detail.error ? (
          <ErrorLine message={errorText(detail.error.message)} />
        ) : (
          <div
            className="h-40 animate-pulse rounded-md bg-gray-200"
            aria-busy="true"
          />
        )}
      </EditorShell>
    );
  }
  const d = detail.data;
  const first = d.sessions.find((s) => !s.removed);
  return (
    <EditorDialogBody
      ccaID={ccaID}
      academicYear={academicYear}
      activityID={activityID}
      initial={volunteerDraftOf({
        title: d.title,
        kind: d.kind,
        description: d.description,
        defaultHours: d.defaultHours,
        people: d.people,
        session: first ? { date: first.date, hours: first.hours } : null,
      })}
      members={members}
      readOnly={readOnly}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
      refreshFailed={detail.error != null}
    />
  );
}
