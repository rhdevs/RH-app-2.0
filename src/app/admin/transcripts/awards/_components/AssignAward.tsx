"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { errorText, fieldError, stoppedLine } from "~/lib/transcript/adminView";
import {
  AWARD_CITATION_MAX,
  AWARD_NAME_MAX,
  assignResultLine,
} from "~/lib/transcript/awards";
import { counterText } from "~/lib/transcript/headView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";
import ResidentPicker from "../../_components/ResidentPicker";

export const NEW_AWARD = "new";

export interface AssignType {
  id: string;
  name: string;
  defaultCitation: string;
}

export interface AssignRecipient {
  userID: string;
  displayName: string | null;
  /** Typed here; empty means "use the award's default". */
  citation: string;
}

export interface AssignAwardViewProps {
  types: AssignType[];
  /** A catalogue id, NEW_AWARD, or "". */
  choice: string;
  onChoice: (choice: string) => void;
  newName: string;
  onNewName: (value: string) => void;
  newCitation: string;
  onNewCitation: (value: string) => void;
  recipients: AssignRecipient[];
  onCitation: (userID: string, value: string) => void;
  onRemoveRecipient: (userID: string) => void;
  picker: ReactNode;
  readOnly: boolean;
  assigning: boolean;
  error: string | null;
  nameError: string | null;
  result: string | null;
  onAssign: () => void;
}

/** The default citation shown in each person's box as a hint. */
export function defaultFor(p: AssignAwardViewProps): string {
  if (p.choice === NEW_AWARD) return p.newCitation;
  return p.types.find((t) => t.id === p.choice)?.defaultCitation ?? "";
}

export function canAssign(p: AssignAwardViewProps): boolean {
  const named =
    p.choice === NEW_AWARD ? p.newName.trim() !== "" : p.choice !== "";
  return !p.readOnly && !p.assigning && named && p.recipients.length > 0;
}

/** "Assign an award": pick or create the award, add residents, Assign. */
export function AssignAwardView(p: AssignAwardViewProps) {
  const hint = defaultFor(p);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canAssign(p)) p.onAssign();
      }}
    >
      <div className="max-w-md">
        <label htmlFor="assign-award" className={FIELD_LABEL}>
          Award
        </label>
        <select
          id="assign-award"
          value={p.choice}
          disabled={p.readOnly}
          onChange={(e) => p.onChoice(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="">Choose an award</option>
          {p.types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value={NEW_AWARD}>New award</option>
        </select>
      </div>

      {p.choice === NEW_AWARD && (
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="new-award-name" className={FIELD_LABEL}>
              New award name
            </label>
            <Input
              id="new-award-name"
              value={p.newName}
              maxLength={AWARD_NAME_MAX}
              disabled={p.readOnly}
              onChange={(e) => p.onNewName(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">
              {counterText(p.newName, AWARD_NAME_MAX)}
            </p>
            <ErrorLine message={p.nameError} />
          </div>
          <div>
            <label htmlFor="new-award-citation" className={FIELD_LABEL}>
              Default citation (optional)
            </label>
            <Input
              id="new-award-citation"
              value={p.newCitation}
              maxLength={AWARD_CITATION_MAX}
              disabled={p.readOnly}
              onChange={(e) => p.onNewCitation(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">
              {counterText(p.newCitation, AWARD_CITATION_MAX)}
            </p>
          </div>
        </div>
      )}

      <div>{!p.readOnly && p.picker}</div>

      {p.recipients.length > 0 && (
        <ul className="max-w-3xl divide-y divide-gray-100 rounded-md border border-gray-200">
          {p.recipients.map((r) => (
            <li
              key={r.userID}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
            >
              <span className="min-w-[8rem] flex-1 break-words text-sm font-medium text-gray-900">
                {r.displayName ?? r.userID}
              </span>
              <label
                htmlFor={`assign-citation-${r.userID}`}
                className="sr-only"
              >{`Citation for ${r.displayName ?? r.userID}`}</label>
              <Input
                id={`assign-citation-${r.userID}`}
                className="h-8 min-w-[12rem] flex-[2]"
                value={r.citation}
                maxLength={AWARD_CITATION_MAX}
                placeholder={hint === "" ? "Citation (optional)" : hint}
                disabled={p.readOnly}
                onChange={(e) => p.onCitation(r.userID, e.target.value)}
              />
              {!p.readOnly && (
                <button
                  type="button"
                  className="rounded-full p-1 text-gray-600 hover:bg-gray-200"
                  aria-label={`Remove ${r.displayName ?? r.userID}`}
                  onClick={() => p.onRemoveRecipient(r.userID)}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canAssign(p)}>
          {p.assigning ? (
            <>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              Assigning
            </>
          ) : (
            "Assign"
          )}
        </Button>
        <p className="text-xs text-gray-500" role="status">
          {p.recipients.length} selected
        </p>
      </div>
      <ErrorLine message={p.error} />
      {p.result && (
        <p className="text-sm text-emerald-800" role="status">
          {p.result}
        </p>
      )}
    </form>
  );
}

/** Wires the form to the catalogue and awards.assign. */
export default function AssignAward({
  academicYear,
  readOnly,
  onDirty,
}: {
  academicYear: string;
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const utils = api.useUtils();
  const types = api.transcriptManage.awardTypes.list.useQuery(
    {},
    { retry: false },
  );
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [newCitation, setNewCitation] = useState("");
  const [recipients, setRecipients] = useState<AssignRecipient[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const create = api.transcriptManage.awardTypes.create.useMutation();
  const assign = api.transcriptManage.awards.assign.useMutation();

  const dirty =
    recipients.length > 0 || newName.trim() !== "" || newCitation.trim() !== "";
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => () => onDirtyRef.current(false), []);

  // A year with no such award chosen yet keeps the picker usable; a published
  // year disables everything.
  const run = async () => {
    setError(null);
    setNameError(null);
    setResult(null);
    try {
      let id = choice;
      if (choice === NEW_AWARD) {
        const made = await create.mutateAsync({
          name: newName,
          defaultCitation: newCitation.trim() === "" ? null : newCitation,
        });
        id = made.id;
        setChoice(made.id);
        setNewName("");
        setNewCitation("");
        await utils.transcriptManage.awardTypes.list.invalidate();
      }
      const done = await assign.mutateAsync({
        academicYear,
        awardTypeID: id,
        recipients: recipients.map((r) => ({
          userID: r.userID,
          citation: r.citation.trim() === "" ? null : r.citation,
        })),
      });
      const line = assignResultLine(
        done.assigned,
        done.skipped.map((s) => s.displayName ?? s.userID),
      );
      if (done.stopped) {
        // Keep the people not done yet, so Submit again finishes the rest.
        const doneIDs = new Set(done.assignedUserIDs);
        setRecipients((cur) => cur.filter((r) => !doneIDs.has(r.userID)));
        setResult(null);
        setError(`${line} ${stoppedLine(done.assigned, done.stopped)}`);
      } else {
        setRecipients([]);
        setResult(line);
      }
      await Promise.all([
        utils.transcriptManage.awards.list.invalidate(),
        utils.transcriptManage.awardTypes.list.invalidate(),
      ]);
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
      const fieldName = fieldError(zod, "name");
      if (fieldName || err.message === "AWARD_NAME_TAKEN") {
        setNameError(fieldName ?? errorText(err.message));
      } else {
        setError(fieldError(zod, "recipients") ?? errorText(err.message));
      }
    }
  };

  return (
    <AssignAwardView
      types={(types.data ?? [])
        .filter((t) => !t.archived)
        .map((t) => ({
          id: t.id,
          name: t.name,
          defaultCitation: t.defaultCitation,
        }))}
      choice={choice}
      onChoice={(c) => {
        setChoice(c);
        setResult(null);
        setError(null);
      }}
      newName={newName}
      onNewName={(v) => {
        setNewName(v);
        setNameError(null);
      }}
      newCitation={newCitation}
      onNewCitation={setNewCitation}
      recipients={recipients}
      onCitation={(userID, value) =>
        setRecipients((cur) =>
          cur.map((r) => (r.userID === userID ? { ...r, citation: value } : r)),
        )
      }
      onRemoveRecipient={(userID) =>
        setRecipients((cur) => cur.filter((r) => r.userID !== userID))
      }
      picker={
        <ResidentPicker
          idPrefix="assign"
          label="Add residents"
          selected={null}
          onSelect={(r) =>
            setRecipients((cur) =>
              cur.some((x) => x.userID === r.userID)
                ? cur
                : [
                    ...cur,
                    {
                      userID: r.userID,
                      displayName: r.displayName,
                      citation: "",
                    },
                  ],
            )
          }
          onClear={() => undefined}
          hideSelectedMatric
          disabled={readOnly}
        />
      }
      readOnly={readOnly}
      assigning={create.isPending || assign.isPending}
      error={error}
      nameError={nameError}
      result={result}
      onAssign={() => void run()}
    />
  );
}
