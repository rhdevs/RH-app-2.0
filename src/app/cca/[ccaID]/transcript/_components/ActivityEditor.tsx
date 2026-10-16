"use client";

import { Loader2, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  ErrorLine,
  FIELD_LABEL,
} from "~/app/admin/transcripts/_components/Bits";
import ResidentPicker, {
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
  ACTIVITY_DESCRIPTION_MAX,
  ACTIVITY_PERIODS,
  ACTIVITY_TITLE_MAX,
  PARTICIPANT_DESCRIPTION_MAX,
  PARTICIPANT_ROLE_MAX,
  PERIOD_LABEL,
  type ActivityPeriod,
} from "~/lib/transcript/activities";
import {
  PERSON_DESCRIPTION_PLACEHOLDER,
  ROLE_PLACEHOLDER,
  activityFields,
  addPerson,
  clearAll,
  editorOf,
  editorProblem,
  emptyEditor,
  filterMembers,
  isEditorDirty,
  isPicked,
  outsiders,
  participantsPayload,
  patchPerson,
  peopleCountLine,
  removePerson,
  selectAll,
  togglePerson,
  type EditorState,
  type MemberOption,
} from "~/lib/transcript/activityEditor";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import { counterText } from "~/lib/transcript/headView";
import { useUnsavedChangesGuard } from "~/lib/transcript/useUnsavedChangesGuard";
import { api } from "~/trpc/react";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

/** A saved activity, as activities.list returns it. */
export interface EditableActivity {
  id: string;
  title: string;
  description: string;
  period: string;
  participants: Array<{
    userID: string;
    displayName: string | null;
    role: string;
    description: string;
  }>;
}

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

export interface ActivityEditorViewProps {
  mode: "add" | "edit";
  state: EditorState;
  onChange: (next: EditorState) => void;
  members: MemberOption[];
  filter: string;
  onFilter: (query: string) => void;
  /** Is "Customise each person" open? */
  customising: boolean;
  onCustomising: (open: boolean) => void;
  /** The resident search for people outside the CCA. */
  picker: ReactNode;
  readOnly: boolean;
  saving: boolean;
  dirty: boolean;
  /** An error from the last save. */
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}

/** The form. Presentational: the dialog owns the state and the save. */
export function ActivityEditorView(p: ActivityEditorViewProps) {
  const { state } = p;
  const a = state.activity;
  const shown = filterMembers(p.members, p.filter);
  const outside = outsiders(state, p.members);
  const problem = editorProblem(state);
  const setActivity = (patch: Partial<EditorState["activity"]>) =>
    p.onChange({ ...state, activity: { ...a, ...patch } });

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
          <label htmlFor="activity-title" className={FIELD_LABEL}>
            Title
          </label>
          <Input
            id="activity-title"
            value={a.title}
            maxLength={ACTIVITY_TITLE_MAX}
            disabled={p.readOnly}
            onChange={(e) => setActivity({ title: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(a.title, ACTIVITY_TITLE_MAX)}
          </p>
        </div>
        <div>
          <label htmlFor="activity-period" className={FIELD_LABEL}>
            Period
          </label>
          <select
            id="activity-period"
            value={a.period}
            disabled={p.readOnly}
            onChange={(e) =>
              setActivity({ period: e.target.value as ActivityPeriod })
            }
            className={SELECT}
          >
            {ACTIVITY_PERIODS.map((period) => (
              <option key={period} value={period}>
                {PERIOD_LABEL[period]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="activity-description" className={FIELD_LABEL}>
          Description (what the activity was)
        </label>
        <Textarea
          id="activity-description"
          rows={3}
          value={a.description}
          maxLength={ACTIVITY_DESCRIPTION_MAX}
          disabled={p.readOnly}
          onChange={(e) => setActivity({ description: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(a.description, ACTIVITY_DESCRIPTION_MAX)}
        </p>
      </div>

      <fieldset>
        <legend className={FIELD_LABEL}>Who took part (CCA members)</legend>
        <div className="mb-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1">
            <label htmlFor="activity-filter" className="sr-only">
              Filter members by name
            </label>
            <Input
              id="activity-filter"
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
            onClick={() => p.onChange(selectAll(state, shown))}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={p.readOnly || shown.length === 0}
            onClick={() => p.onChange(clearAll(state, shown))}
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
                    checked={isPicked(state, m.userID)}
                    disabled={p.readOnly}
                    onChange={() => p.onChange(togglePerson(state, m))}
                  />
                  {m.displayName ?? m.userID}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div>
        <p className={FIELD_LABEL}>Other people (not in this CCA)</p>
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
                    onClick={() =>
                      p.onChange(removePerson(state, person.userID))
                    }
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

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-700" role="status">
            {peopleCountLine(state.people.length)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={p.customising}
            aria-controls="activity-customise"
            disabled={state.people.length === 0}
            onClick={() => p.onCustomising(!p.customising)}
          >
            {p.customising ? "Hide" : "Customise each person"}
          </Button>
        </div>
        {p.customising && state.people.length > 0 && (
          <ul id="activity-customise" className="mt-3 space-y-3">
            {state.people.map((person) => {
              const name = person.displayName ?? person.userID;
              return (
                <li
                  key={person.userID}
                  className="rounded-md border border-gray-200 p-3"
                >
                  <p className="mb-2 text-sm font-medium text-gray-900">
                    {name}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                    <div>
                      <label
                        htmlFor={`role-${person.userID}`}
                        className="sr-only"
                      >{`Role for ${name}`}</label>
                      <Input
                        id={`role-${person.userID}`}
                        value={person.role}
                        maxLength={PARTICIPANT_ROLE_MAX}
                        placeholder={ROLE_PLACEHOLDER}
                        disabled={p.readOnly}
                        onChange={(e) =>
                          p.onChange(
                            patchPerson(state, person.userID, {
                              role: e.target.value,
                            }),
                          )
                        }
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`desc-${person.userID}`}
                        className="sr-only"
                      >{`Description for ${name}`}</label>
                      <Textarea
                        id={`desc-${person.userID}`}
                        rows={2}
                        value={person.description}
                        maxLength={PARTICIPANT_DESCRIPTION_MAX}
                        placeholder={PERSON_DESCRIPTION_PLACEHOLDER}
                        disabled={p.readOnly}
                        onChange={(e) =>
                          p.onChange(
                            patchPerson(state, person.userID, {
                              description: e.target.value,
                            }),
                          )
                        }
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        {counterText(
                          person.description,
                          PARTICIPANT_DESCRIPTION_MAX,
                        )}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ErrorLine message={problem && p.dirty ? problem : p.error} />

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
              "Add activity"
            ) : (
              "Save activity"
            )}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * The dialog on a desktop, a full-screen sheet on a phone. Saving writes the
 * activity first and then replaces its participants; if the second step fails
 * the editor stays open on the saved activity, so a retry never makes a copy.
 */
export default function ActivityEditorDialog({
  ccaID,
  academicYear,
  activity,
  members,
  readOnly,
  onClose,
}: {
  ccaID: number;
  academicYear: string;
  /** The activity being edited, or null to add one. */
  activity: EditableActivity | null;
  members: MemberOption[];
  readOnly: boolean;
  onClose: () => void;
}) {
  const returnFocus = useReturnFocus();
  const utils = api.useUtils();
  const [saved, setSaved] = useState<EditorState>(() =>
    activity ? editorOf(activity) : emptyEditor(),
  );
  const [state, setState] = useState<EditorState>(saved);
  const [filter, setFilter] = useState("");
  const [customising, setCustomising] = useState(false);
  const [createdID, setCreatedID] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = api.transcriptManage.activities.create.useMutation();
  const update = api.transcriptManage.activities.update.useMutation();
  const setParticipants = api.transcriptManage.participants.set.useMutation();

  const dirty = isEditorDirty(state, saved);
  const confirmLeave = useUnsavedChangesGuard(dirty);
  const close = () => {
    if (confirmLeave()) onClose();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let id = activity?.id ?? createdID;
      if (id) {
        await update.mutateAsync({
          id,
          ccaID,
          ...activityFields(state.activity),
        });
      } else {
        const made = await create.mutateAsync({
          ccaID,
          academicYear,
          ...activityFields(state.activity),
        });
        id = made.id;
        setCreatedID(made.id);
      }
      await setParticipants.mutateAsync({
        id,
        ccaID,
        participants: participantsPayload(state),
      });
      setSaved(state);
      await utils.transcriptManage.activities.list.invalidate();
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
          fieldError(zod, "participants") ??
          errorText(err.message),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && close()}>
      <DialogContent
        {...returnFocus}
        className="h-[100dvh] max-w-none overflow-y-auto rounded-none sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {activity ? "Edit activity" : "Add activity"}
          </DialogTitle>
          <DialogDescription>
            Tick the members who took part. Each person&rsquo;s line on their
            transcript uses the description below unless you customise it.
          </DialogDescription>
        </DialogHeader>
        <ActivityEditorView
          mode={activity || createdID ? "edit" : "add"}
          state={state}
          onChange={(next) => {
            setError(null);
            setState(next);
          }}
          members={members}
          filter={filter}
          onFilter={setFilter}
          customising={customising}
          onCustomising={setCustomising}
          picker={
            <ResidentPicker
              idPrefix="activity-person"
              label="Add a person by name"
              placeholder={HEAD_PLACEHOLDER}
              hideSelectedMatric
              selected={null}
              onSelect={(r) =>
                setState((current) =>
                  addPerson(current, {
                    userID: r.userID,
                    displayName: r.displayName,
                  }),
                )
              }
              onClear={() => undefined}
            />
          }
          readOnly={readOnly}
          saving={saving}
          dirty={dirty}
          error={error}
          onSave={() => void save()}
          onCancel={close}
        />
      </DialogContent>
    </Dialog>
  );
}
