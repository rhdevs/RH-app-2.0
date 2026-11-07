"use client";

import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { AUX_TEXT_MAX } from "~/lib/auxPoints";
import { api, type RouterOutputs } from "~/trpc/react";
import { AttendeeList } from "./AttendeeList";
import { addSummary, auxErrorCopy, sgtToday } from "./auxCopy";
import { ErrorLine, Panel, PasteBox, StatusLine, UnresolvedList } from "./Bits";

type AuxRecord = RouterOutputs["aux"]["sources"]["records"][number];
type CreateResult = RouterOutputs["aux"]["createRecord"];

/**
 * Record-only AUX events: things held before the app tracked attendance, or
 * outside it. A title, a date and a list of people (pasted or from a CSV);
 * each person on the list gets 1 AUX.
 */
export default function RecordsPanel({
  readOnly,
  records,
  onChanged,
}: {
  readOnly: boolean;
  records: readonly AuxRecord[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title="Record-only events"
      description="For an AUX event that wasn’t run through the app. Each person on its list gets 1 AUX."
    >
      <div className="space-y-4">
        {!readOnly && <CreateRecord onChanged={onChanged} />}
        {records.length === 0 ? (
          <p className="text-sm text-gray-500">No record-only events yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {records.map((r) => (
              <RecordRow
                key={r.id}
                record={r}
                readOnly={readOnly}
                isOpen={open === r.id}
                onToggle={() => setOpen(open === r.id ? null : r.id)}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function TitleDate({
  title,
  heldOn,
  onTitle,
  onHeldOn,
  disabled,
}: {
  title: string;
  heldOn: string;
  onTitle: (v: string) => void;
  onHeldOn: (v: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
      <div className="space-y-1">
        <label
          htmlFor={`${id}-t`}
          className="text-sm font-medium text-gray-800"
        >
          Title
        </label>
        <Input
          id={`${id}-t`}
          value={title}
          maxLength={AUX_TEXT_MAX}
          disabled={disabled}
          onChange={(e) => onTitle(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label
          htmlFor={`${id}-d`}
          className="text-sm font-medium text-gray-800"
        >
          Held on
        </label>
        <Input
          id={`${id}-d`}
          type="date"
          value={heldOn}
          disabled={disabled}
          onChange={(e) => onHeldOn(e.target.value)}
        />
      </div>
    </div>
  );
}

function CreateRecord({ onChanged }: { onChanged: () => void }) {
  const [title, setTitle] = useState("");
  const [heldOn, setHeldOn] = useState(() => sgtToday(new Date()));
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const create = api.aux.createRecord.useMutation();

  const save = async () => {
    if (!title.trim() || !heldOn) {
      setError("Fill in a title and a date.");
      return;
    }
    setError(null);
    setResult(null);
    try {
      const r = await create.mutateAsync({ title: title.trim(), heldOn, text });
      setResult(r);
      setTitle("");
      setText("");
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-dashed border-gray-300 p-4">
      <h3 className="text-sm font-semibold text-gray-900">
        Add a record-only event
      </h3>
      <TitleDate
        title={title}
        heldOn={heldOn}
        onTitle={setTitle}
        onHeldOn={setHeldOn}
        disabled={create.isPending}
      />
      <PasteBox
        label="Who came"
        hint="One matric, email or NUSNET id per line, or a CSV with them in the first column. You can add more later."
        value={text}
        onChange={setText}
        disabled={create.isPending}
      />
      <Button size="sm" onClick={() => void save()} disabled={create.isPending}>
        Add event
      </Button>
      <ErrorLine message={error} />
      {result && (
        <>
          <StatusLine
            message={`Event added. ${addSummary(result.added.length, result.already.length)}`}
          />
          <UnresolvedList lines={result.unknown} />
        </>
      )}
    </div>
  );
}

function RecordRow({
  record,
  readOnly,
  isOpen,
  onToggle,
  onChanged,
}: {
  record: AuxRecord;
  readOnly: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [edit, setEdit] = useState<{ title: string; heldOn: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const list = api.aux.recordAttendees.useQuery(
    { id: record.id },
    { enabled: isOpen },
  );
  const update = api.aux.updateRecord.useMutation();
  const remove = api.aux.deleteRecord.useMutation();
  const add = api.aux.addRecordAttendees.useMutation();
  const removeOne = api.aux.removeRecordAttendee.useMutation();
  const busy = update.isPending || remove.isPending;
  const changed = () => {
    void list.refetch();
    onChanged();
  };

  const save = async () => {
    if (!edit?.title.trim() || !edit.heldOn) {
      setError("Fill in a title and a date.");
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({
        id: record.id,
        title: edit.title.trim(),
        heldOn: edit.heldOn,
      });
      setEdit(null);
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  const del = async () => {
    if (
      !window.confirm(
        `Delete “${record.title}”? The ${record.attendees} people on it lose its AUX.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await remove.mutateAsync({ id: record.id });
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  return (
    <li className="px-3 py-2">
      {edit ? (
        <div className="space-y-2">
          <TitleDate
            title={edit.title}
            heldOn={edit.heldOn}
            onTitle={(title) => setEdit({ ...edit, title })}
            onHeldOn={(heldOn) => setEdit({ ...edit, heldOn })}
            disabled={busy}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEdit(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={onToggle}
            className="inline-flex items-center gap-1 rounded text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            {isOpen ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
            <span className="font-medium text-gray-900">{record.title}</span>
            <span className="text-xs text-gray-500">
              · {record.heldOn} · {record.attendees} listed
            </span>
          </button>
          {!readOnly && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  setEdit({ title: record.title, heldOn: record.heldOn })
                }
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void del()}
                className="text-red-700 hover:text-red-800"
              >
                Delete
              </Button>
            </div>
          )}
        </div>
      )}
      <ErrorLine message={error} />
      {isOpen && !edit && (
        <div className="mt-3 pl-5">
          <AttendeeList
            people={list.data}
            loading={list.isLoading}
            readOnly={readOnly}
            onAdd={async (text) => {
              const r = await add.mutateAsync({ id: record.id, text });
              changed();
              return r;
            }}
            onRemove={async (userID) => {
              await removeOne.mutateAsync({ id: record.id, userID });
              changed();
            }}
          />
        </div>
      )}
    </li>
  );
}
