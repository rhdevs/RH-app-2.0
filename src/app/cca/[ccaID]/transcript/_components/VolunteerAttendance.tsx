"use client";

import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  ErrorLine,
  FIELD_LABEL,
} from "~/app/admin/transcripts/_components/Bits";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import { formatSgDate, sgDateToInstant } from "~/lib/transcript/sgDate";
import {
  formatVolunteerHours,
  type VolunteerKind,
} from "~/lib/transcript/volunteer";
import {
  clearColumn,
  clearRow,
  copyPrevious,
  defaultPhoneIndex,
  cellsOf,
  gridChanges,
  gridWindow,
  isTicked,
  liveTotals,
  overrideOf,
  pageStart,
  previousSession,
  restrictCells,
  setOverride,
  stepSession,
  tickColumn,
  tickRow,
  toggleCell,
  unsavedCells,
  windowLine,
  applyEdits,
  editsFrom,
  reconcileEdits,
  type Cells,
  type GridEdits,
  type GridSession,
} from "~/lib/transcript/volunteerGrid";
import { REFRESH_FAILED_NOTE } from "~/lib/transcript/headView";
import {
  hoursText,
  parseVolunteerHours,
} from "~/lib/transcript/volunteerEditor";
import { useUnsavedChangesGuard } from "~/lib/transcript/useUnsavedChangesGuard";
import { api } from "~/trpc/react";
import { SaveAllBar } from "./RosterEditor";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

export interface AttendancePerson {
  userID: string;
  displayName: string | null;
}

const nameOf = (p: AttendancePerson) => p.displayName ?? p.userID;

/** "8 Oct" for a column header. */
function shortDate(iso: string): string {
  const instant = sgDateToInstant(iso);
  if (!instant) return iso;
  const [day, month] = formatSgDate(instant).split(" ");
  return `${day} ${month}`;
}

const MINI =
  "min-h-6 min-w-6 rounded border border-gray-400 bg-white px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40";

export interface AttendanceViewProps {
  kind: VolunteerKind;
  sessions: GridSession[];
  people: AttendancePerson[];
  cells: Cells;
  onCells: (next: Cells) => void;
  readOnly: boolean;
  /** Where the desktop window starts; null = the most recent sessions. */
  windowStart: number | null;
  onWindowStart: (start: number | null) => void;
  /** The session the phone view shows. */
  phoneIndex: number;
  onPhoneIndex: (index: number) => void;
  /** The cell whose hours override is being typed, if any. */
  editingCell: { sessionID: string; userID: string } | null;
  onEditingCell: (cell: { sessionID: string; userID: string } | null) => void;
  onAddSession: () => void;
  addingSession: boolean;
  onEditSession: (sessionID: string) => void;
  error: string | null;
}

/** The attendance grid on desktop and the one-session list on a phone. */
export function AttendanceView(p: AttendanceViewProps) {
  const ids = p.people.map((x) => x.userID);
  const totals = liveTotals(p.cells, p.sessions, ids);
  const oneoff = p.kind === "oneoff";

  return (
    <div>
      {p.sessions.length === 0 ? (
        <p className="mb-3 text-sm text-gray-600">
          No sessions yet. Add the first session to start ticking attendance.
        </p>
      ) : p.people.length === 0 ? (
        <p className="mb-3 text-sm text-gray-600">
          No people yet. Edit the activity to choose who took part.
        </p>
      ) : (
        <>
          <div className="hidden md:block">
            <DesktopGrid {...p} totals={totals} />
          </div>
          <div className="md:hidden">
            <PhoneView {...p} totals={totals} />
          </div>
        </>
      )}
      {!p.readOnly && !oneoff && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={p.addingSession}
          onClick={p.onAddSession}
        >
          {p.addingSession ? "Adding session" : "Add session"}
        </Button>
      )}
      <ErrorLine message={p.error} />
    </div>
  );
}

type WithTotals = AttendanceViewProps & { totals: Map<string, number> };

function OverrideInput({
  idPrefix,
  label,
  session,
  value,
  onCommit,
  onCancel,
}: {
  idPrefix: string;
  label: string;
  session: GridSession;
  value: number | null;
  onCommit: (hours: number | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const parsed = parseVolunteerHours(text);
  const bad = text.trim() !== "" && parsed === null;
  return (
    <span className="inline-flex items-center gap-1">
      <label htmlFor={idPrefix} className="sr-only">
        {label}
      </label>
      <input
        id={idPrefix}
        autoFocus
        inputMode="decimal"
        value={text}
        placeholder={String(session.hours)}
        aria-invalid={bad}
        className={`h-7 w-14 rounded border px-1 text-sm ${bad ? "border-red-500" : "border-gray-300"}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!bad) onCommit(parsed);
          }
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => (bad ? onCancel() : onCommit(parsed))}
      />
    </span>
  );
}

function DesktopGrid(p: WithTotals) {
  const win = gridWindow(p.sessions.length, p.windowStart);
  const visible = p.sessions.slice(win.start, win.end);
  const ids = p.people.map((x) => x.userID);
  const allSessionIDs = p.sessions.map((s) => s.id);
  const oneoff = p.kind === "oneoff";

  return (
    <div>
      {!oneoff && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-600" role="status">
            {windowLine(win, p.sessions.length)}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!win.hasEarlier}
              onClick={() =>
                p.onWindowStart(pageStart(p.sessions.length, win, "earlier"))
              }
            >
              Earlier sessions
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!win.hasLater}
              onClick={() =>
                p.onWindowStart(pageStart(p.sessions.length, win, "later"))
              }
            >
              Later sessions
            </Button>
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-[10rem] border-b border-gray-200 bg-white px-2 py-2 text-left text-xs font-medium text-gray-700"
              >
                Name
              </th>
              {visible.map((s) => {
                const prev = previousSession(p.sessions, s.id);
                return (
                  <th
                    key={s.id}
                    scope="col"
                    className="min-w-[7.5rem] border-b border-gray-200 px-2 py-2 text-left align-top text-xs font-medium text-gray-700"
                  >
                    <div className="text-sm font-semibold text-gray-900">
                      {shortDate(s.date)}
                    </div>
                    <div className="mb-1 font-normal text-gray-600">
                      {formatVolunteerHours(s.hours)} h
                    </div>
                    {!p.readOnly && (
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className={MINI}
                          onClick={() =>
                            p.onCells(tickColumn(p.cells, s.id, ids))
                          }
                        >
                          Tick all
                        </button>
                        <button
                          type="button"
                          className={MINI}
                          onClick={() =>
                            p.onCells(clearColumn(p.cells, s.id, ids))
                          }
                        >
                          Clear all
                        </button>
                        {prev && (
                          <button
                            type="button"
                            className={MINI}
                            onClick={() =>
                              p.onCells(
                                copyPrevious(p.cells, prev.id, s.id, ids),
                              )
                            }
                          >
                            Copy previous
                          </button>
                        )}
                        {!oneoff && (
                          <button
                            type="button"
                            className={MINI}
                            onClick={() => p.onEditSession(s.id)}
                          >
                            Edit session
                          </button>
                        )}
                      </div>
                    )}
                  </th>
                );
              })}
              <th
                scope="col"
                className="border-b border-gray-200 px-2 py-2 text-right text-xs font-medium text-gray-700"
              >
                Total
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {p.people.map((person) => (
              <tr key={person.userID}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-white px-2 py-1.5 text-left font-medium text-gray-900"
                >
                  <div>{nameOf(person)}</div>
                  {!p.readOnly && !oneoff && (
                    <div className="mt-0.5 flex gap-1">
                      <button
                        type="button"
                        className={MINI}
                        onClick={() =>
                          p.onCells(
                            tickRow(p.cells, person.userID, allSessionIDs),
                          )
                        }
                      >
                        Tick all sessions
                      </button>
                      <button
                        type="button"
                        className={MINI}
                        onClick={() =>
                          p.onCells(
                            clearRow(p.cells, person.userID, allSessionIDs),
                          )
                        }
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                </th>
                {visible.map((s) => {
                  const ticked = isTicked(p.cells, s.id, person.userID);
                  const override = overrideOf(p.cells, s.id, person.userID);
                  const editing =
                    p.editingCell?.sessionID === s.id &&
                    p.editingCell.userID === person.userID;
                  const label = `${nameOf(person)}, ${shortDate(s.date)}`;
                  return (
                    <td key={s.id} className="px-2 py-1.5">
                      {editing ? (
                        <OverrideInput
                          idPrefix={`ov-${s.id}-${person.userID}`}
                          label={`Hours for ${label}`}
                          session={s}
                          value={override}
                          onCommit={(hours) => {
                            p.onCells(
                              setOverride(p.cells, s.id, person.userID, hours),
                            );
                            p.onEditingCell(null);
                          }}
                          onCancel={() => p.onEditingCell(null)}
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={ticked}
                            aria-label={label}
                            disabled={p.readOnly}
                            onClick={() =>
                              p.onCells(
                                toggleCell(p.cells, s.id, person.userID),
                              )
                            }
                            className={`flex h-8 min-w-[2.25rem] items-center justify-center rounded border px-1 text-sm ${
                              ticked
                                ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                                : "border-gray-500 bg-white text-gray-600"
                            } disabled:cursor-not-allowed`}
                          >
                            {ticked ? (
                              override === null ? (
                                <Check className="h-4 w-4" />
                              ) : (
                                formatVolunteerHours(override)
                              )
                            ) : (
                              ""
                            )}
                          </button>
                          {ticked && !p.readOnly && (
                            <button
                              type="button"
                              className={MINI}
                              aria-label={`Set hours for ${label}`}
                              onClick={() =>
                                p.onEditingCell({
                                  sessionID: s.id,
                                  userID: person.userID,
                                })
                              }
                            >
                              h
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right font-medium text-gray-900">
                  {formatVolunteerHours(p.totals.get(person.userID) ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PhoneView(p: WithTotals) {
  const index = Math.min(
    Math.max(p.phoneIndex, 0),
    Math.max(p.sessions.length - 1, 0),
  );
  const session = p.sessions[index];
  if (!session) return null;
  const ids = p.people.map((x) => x.userID);
  const prev = previousSession(p.sessions, session.id);
  const oneoff = p.kind === "oneoff";

  return (
    <div>
      {!oneoff && (
        <div className="mb-3 flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous session"
            disabled={index === 0}
            onClick={() =>
              p.onPhoneIndex(stepSession(p.sessions.length, index, -1))
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <label htmlFor="phone-session" className="sr-only">
            Session
          </label>
          <select
            id="phone-session"
            value={session.id}
            onChange={(e) =>
              p.onPhoneIndex(
                p.sessions.findIndex((s) => s.id === e.target.value),
              )
            }
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          >
            {p.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {shortDate(s.date)} · {formatVolunteerHours(s.hours)} h
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Next session"
            disabled={index >= p.sessions.length - 1}
            onClick={() =>
              p.onPhoneIndex(stepSession(p.sessions.length, index, 1))
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
      <p className="mb-2 text-sm font-medium text-gray-900">
        {shortDate(session.date)} · {formatVolunteerHours(session.hours)} h
      </p>
      {!p.readOnly && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => p.onCells(tickColumn(p.cells, session.id, ids))}
          >
            Tick all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => p.onCells(clearColumn(p.cells, session.id, ids))}
          >
            Clear all
          </Button>
          {prev && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                p.onCells(copyPrevious(p.cells, prev.id, session.id, ids))
              }
            >
              Copy previous session
            </Button>
          )}
          {!oneoff && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => p.onEditSession(session.id)}
            >
              Edit session
            </Button>
          )}
        </div>
      )}
      <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
        {p.people.map((person) => {
          const ticked = isTicked(p.cells, session.id, person.userID);
          const override = overrideOf(p.cells, session.id, person.userID);
          return (
            <li
              key={person.userID}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            >
              <label className="flex min-w-[8rem] flex-1 cursor-pointer items-center gap-3 text-sm text-gray-900">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={ticked}
                  disabled={p.readOnly}
                  onChange={() =>
                    p.onCells(toggleCell(p.cells, session.id, person.userID))
                  }
                />
                <span className="min-w-0 break-words">{nameOf(person)}</span>
              </label>
              {ticked && (
                <>
                  <label
                    htmlFor={`ph-${session.id}-${person.userID}`}
                    className="sr-only"
                  >{`Hours for ${nameOf(person)}`}</label>
                  <Input
                    id={`ph-${session.id}-${person.userID}`}
                    inputMode="decimal"
                    className="h-8 w-20"
                    placeholder={String(session.hours)}
                    disabled={p.readOnly}
                    defaultValue={override === null ? "" : String(override)}
                    key={`${session.id}-${person.userID}-${override ?? ""}`}
                    onBlur={(e) => {
                      const text = e.target.value;
                      if (text.trim() === "") {
                        p.onCells(
                          setOverride(p.cells, session.id, person.userID, null),
                        );
                      } else {
                        const hours = parseVolunteerHours(text);
                        if (hours !== null) {
                          p.onCells(
                            setOverride(
                              p.cells,
                              session.id,
                              person.userID,
                              hours,
                            ),
                          );
                        }
                      }
                    }}
                  />
                </>
              )}
              <span className="w-16 text-right text-xs text-gray-600">
                Total {formatVolunteerHours(p.totals.get(person.userID) ?? 0)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---- editing a session ------------------------------------------------------- */

function SessionDialog({
  ccaID,
  session,
  onClose,
}: {
  ccaID: number;
  session: GridSession;
  onClose: () => void;
}) {
  const returnFocus = useReturnFocus();
  const utils = api.useUtils();
  const [date, setDate] = useState(session.date);
  const [hours, setHours] = useState(String(session.hours));
  const update = api.transcriptManage.volunteer.sessions.update.useMutation();
  const remove = api.transcriptManage.volunteer.sessions.remove.useMutation();
  const done = async () => {
    await Promise.all([
      utils.transcriptManage.volunteer.activities.get.invalidate(),
      utils.transcriptManage.volunteer.activities.list.invalidate(),
    ]);
    onClose();
  };
  const parsed = parseVolunteerHours(hours);
  const busy = update.isPending || remove.isPending;
  const err = update.error ?? remove.error;
  const zod = update.error?.data?.zodError ?? null;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent {...returnFocus} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit session</DialogTitle>
          <DialogDescription>
            Changing the hours changes everyone ticked in this session, except
            people with their own hours.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="session-date" className={FIELD_LABEL}>
              Date
            </label>
            <Input
              id="session-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="session-hours" className={FIELD_LABEL}>
              Hours
            </label>
            <Input
              id="session-hours"
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <ErrorLine message={hoursText(hours)} />
          </div>
          <ErrorLine
            message={
              err
                ? (fieldError(zod, "date") ??
                  fieldError(zod, "hours") ??
                  errorText(err.message))
                : null
            }
          />
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                remove.mutate(
                  { sessionID: session.id, ccaID },
                  { onSuccess: () => void done() },
                )
              }
            >
              Remove session
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busy || parsed === null || date === ""}
                onClick={() =>
                  update.mutate(
                    { sessionID: session.id, ccaID, date, hours: parsed! },
                    { onSuccess: () => void done() },
                  )
                }
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---- the container -------------------------------------------------------------- */

/**
 * One activity's attendance. Ticks are kept locally and saved together with
 * "Save", so a run of clicks is one request; leaving with unsaved ticks asks first.
 */
export default function VolunteerAttendance({
  ccaID,
  activityID,
  readOnly,
  onUnsavedChange,
}: {
  ccaID: number;
  activityID: string;
  readOnly: boolean;
  onUnsavedChange?: (count: number) => void;
}) {
  const utils = api.useUtils();
  const detail = api.transcriptManage.volunteer.activities.get.useQuery(
    { id: activityID, ccaID },
    { retry: false },
  );
  // Only the cells I changed; the server's cells are laid under them each render.
  const [edits, setEdits] = useState<GridEdits | null>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const [windowStart, setWindowStart] = useState<number | null>(null);
  const [phoneIndex, setPhoneIndex] = useState<number | null>(null);
  const [editingCell, setEditingCell] = useState<{
    sessionID: string;
    userID: string;
  } | null>(null);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = api.transcriptManage.volunteer.attendance.save.useMutation();
  const add = api.transcriptManage.volunteer.sessions.add.useMutation();

  const data = detail.data;
  const sessions: GridSession[] = (data?.sessions ?? [])
    .filter((s) => !s.removed)
    .map((s) => ({ id: s.id, date: s.date, hours: s.hours }));
  const people = data?.people ?? [];
  const sessionIDs = sessions.map((s) => s.id);
  const userIDs = people.map((x) => x.userID);
  const saved = restrictCells(cellsOf(data?.cells ?? []), sessionIDs, userIDs);
  const cells = restrictCells(
    edits ? applyEdits(saved, edits) : saved,
    sessionIDs,
    userIDs,
  );
  const count = unsavedCells(saved, cells);
  // Closing or reloading the tab asks first; the parent hears the count so it
  // can ask before another activity opens.
  useUnsavedChangesGuard(count > 0);
  useEffect(() => onUnsavedChange?.(count), [count, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(0), [onUnsavedChange]);

  // A failed refresh with data on screen is not a reason to drop the ticks.
  if (detail.error && !data) {
    return <ErrorLine message={errorText(detail.error.message)} />;
  }
  if (!data) {
    return (
      <div
        className="h-32 animate-pulse rounded-md bg-gray-100"
        aria-busy="true"
      />
    );
  }

  const index = phoneIndex ?? defaultPhoneIndex(sessions.length);
  const editSession = sessions.find((s) => s.id === editingSession) ?? null;

  const doSave = async () => {
    setSaveError(null);
    const submitted = editsRef.current;
    if (!submitted) return;
    try {
      // Only my edits are sent, so a tick another editor made is never undone.
      await save.mutateAsync({
        activityID,
        ccaID,
        changes: gridChanges(saved, applyEdits(saved, submitted)),
      });
      await Promise.all([
        utils.transcriptManage.volunteer.activities.get.invalidate(),
        utils.transcriptManage.volunteer.activities.list.invalidate(),
      ]);
      // Clear what was sent; anything edited meanwhile stays.
      setEdits(reconcileEdits(submitted, editsRef.current));
    } catch (e) {
      setSaveError(errorText((e as { message?: string }).message));
    }
  };

  return (
    <div>
      {detail.error && (
        <p className="mb-2 text-sm text-amber-800" role="status">
          {REFRESH_FAILED_NOTE}
        </p>
      )}
      <AttendanceView
        kind={data.kind}
        sessions={sessions}
        people={people}
        cells={cells}
        onCells={(next) => {
          setSaveError(null);
          setEdits(editsFrom(saved, next));
        }}
        readOnly={readOnly || save.isPending}
        windowStart={windowStart}
        onWindowStart={setWindowStart}
        phoneIndex={index}
        onPhoneIndex={setPhoneIndex}
        editingCell={editingCell}
        onEditingCell={setEditingCell}
        onAddSession={() =>
          add.mutate(
            { activityID, ccaID },
            {
              onSuccess: () => {
                void Promise.all([
                  utils.transcriptManage.volunteer.activities.get.invalidate(),
                  utils.transcriptManage.volunteer.activities.list.invalidate(),
                ]);
                setWindowStart(null);
                setPhoneIndex(null);
              },
            },
          )
        }
        addingSession={add.isPending}
        onEditSession={setEditingSession}
        error={saveError ?? (add.error ? errorText(add.error.message) : null)}
      />
      {!readOnly && (
        <SaveAllBar
          count={count}
          busy={save.isPending}
          failureLine={null}
          saveLabel="Save"
          onSaveAll={() => void doSave()}
          onDiscard={() => {
            setSaveError(null);
            setEditingCell(null);
            setEdits(null);
          }}
        />
      )}
      {editSession && (
        <SessionDialog
          key={editSession.id}
          ccaID={ccaID}
          session={editSession}
          onClose={() => setEditingSession(null)}
        />
      )}
    </div>
  );
}
