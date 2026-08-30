"use client";

import { useEffect, useRef, useState } from "react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  EVENT_QUESTION_TYPES,
  EVENT_MAX_QUESTIONS,
  EVENT_QUESTION_LABEL_MAX,
  EVENT_QUESTION_HELP_MAX,
  EVENT_MAX_OPTIONS,
  EVENT_OPTION_LABEL_MAX,
  EVENT_ANSWER_DEFAULT_MAXLENGTH,
  EVENT_ANSWER_TEXT_MAX,
  QUESTION_TYPE_COPY,
  questionDraftSchema,
  isEventQuestionType,
  typeHasOptions,
  typeHasMaxLength,
  type EventQuestionType,
  type QuestionDraft,
} from "~/lib/schemas/eventQuestion";
import { mapError } from "./EventManage";

type OwnerQuestion =
  RouterOutputs["event"]["getQuestionsForOwner"]["questions"][number];

/**
 * One question row as the builder edits it. `key` is a CLIENT-ONLY react key,
 * separate from `questionID`, because a brand-new question has `questionID:
 * null` and there can be more than one of those in the list at once — two
 * `null` ids cannot both be react keys.
 */
type QuestionRow = {
  key: string;
  questionID: number | null;
  type: EventQuestionType;
  label: string;
  helpText: string;
  required: boolean;
  options: string[];
  maxLength: number | null;
};

type RowErrors = {
  label?: string;
  options?: string;
  optionErrors: Record<number, string>;
  maxLength?: string;
};

const EMPTY_ROW_ERRORS: RowErrors = { optionErrors: {} };

function rowFromServer(q: OwnerQuestion, key: string): QuestionRow {
  return {
    key,
    questionID: q.questionID,
    // The DB column is a plain String (see eventQuestion.ts's header comment),
    // so a hand-edited row could hold something outside the vocabulary. Falling
    // back to short_text is the same posture `validateAnswers` takes for an
    // unrecognised type: refuse to pretend, but do not crash the screen.
    type: isEventQuestionType(q.type) ? q.type : "short_text",
    label: q.label,
    helpText: q.helpText ?? "",
    required: q.required ?? false,
    options: q.options,
    maxLength: q.maxLength,
  };
}

function toDraft(row: QuestionRow): QuestionDraft {
  return {
    questionID: row.questionID,
    type: row.type,
    label: row.label,
    helpText: row.helpText.trim() ? row.helpText : undefined,
    required: row.required,
    options: typeHasOptions(row.type) ? row.options : undefined,
    maxLength: typeHasMaxLength(row.type) ? row.maxLength : undefined,
  };
}

function validateRow(row: QuestionRow): RowErrors {
  const parsed = questionDraftSchema.safeParse(toDraft(row));
  if (parsed.success) return EMPTY_ROW_ERRORS;
  const errors: RowErrors = { optionErrors: {} };
  for (const issue of parsed.error.issues) {
    const [field, index] = issue.path;
    if (field === "label") errors.label = issue.message;
    else if (field === "options" && typeof index === "number") {
      errors.optionErrors[index] = issue.message;
    } else if (field === "options") errors.options = issue.message;
    else if (field === "maxLength") errors.maxLength = issue.message;
  }
  return errors;
}

function rowHasErrors(e: RowErrors): boolean {
  return !!e.label || !!e.options || !!e.maxLength || Object.keys(e.optionErrors).length > 0;
}

/**
 * The CCA head's signup-question builder. Mounted as an ordinary child of
 * `DetailsEditor` in EventManage.tsx — which is already `"use client"` — so
 * there is no server/client boundary being crossed here and nothing to pass
 * but a plain `eventID` number. See EventManage.tsx's own warning on this
 * before adding a `page.tsx` anywhere near this component.
 *
 * Owns its own query and mutation: the parent does not thread any of
 * `questions` / `frozen` / `signupCount` through props, so a co-head editing
 * in another tab can never hand this component stale data through a prop that
 * outlives its own refetch.
 */
export default function EventQuestionBuilder({ eventID }: { eventID: number }) {
  const utils = api.useUtils();
  const query = api.event.getQuestionsForOwner.useQuery({ eventID });
  const save = api.event.saveQuestions.useMutation();

  const [rows, setRows] = useState<QuestionRow[] | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, RowErrors>>({});
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextKey = useRef(0);

  // Populate local rows from the server ONCE per fetch cycle. `rows` is reset
  // to null right after a successful save (below), which is what makes this
  // effect re-run and pick up the server's real ids and order rather than the
  // client's own guesses.
  useEffect(() => {
    if (query.data && rows === null) {
      setRows(
        query.data.questions.map((q) =>
          rowFromServer(q, String(nextKey.current++)),
        ),
      );
    }
  }, [query.data, rows]);

  if (query.isPending || rows === null) {
    return <div className="h-24 animate-pulse rounded-lg bg-gray-100" />;
  }
  if (query.error || !query.data) {
    return (
      <p className="text-sm text-gray-500">Signup questions couldn’t load.</p>
    );
  }

  const { signupCount, frozen } = query.data;

  /* ---------------------------------------------------------------------- */
  /* FROZEN — replaces the whole builder, not a disabled form.               */
  /* ---------------------------------------------------------------------- */
  if (frozen) {
    // Same irregular-plural idiom as EventAttendees.tsx and
    // EventsListPanel.tsx: a ternary inline in the template, not a helper.
    const peopleHave = signupCount === 1 ? "person has" : "people have";
    return (
      <section className="space-y-2 rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Signup questions
        </h3>
        <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
          <p className="text-sm font-medium text-gray-900">
            These questions are locked
          </p>
          <p className="mt-1 text-sm text-gray-600">
            {signupCount} {peopleHave} already signed up and answered these
            questions. Changing them now would leave those answers pointing at
            questions that no longer exist, so the form is fixed for this
            event. If you need a different form, cancel this event and
            duplicate it.
          </p>
        </div>
      </section>
    );
  }

  function setRow(index: number, patch: Partial<QuestionRow>) {
    setRows((prev) =>
      (prev ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
    setDirty(true);
    setSaved(false);
  }

  function handleTypeChange(index: number, type: EventQuestionType) {
    setRows((prev) =>
      (prev ?? []).map((r, i) =>
        i === index
          ? {
              ...r,
              type,
              // Clearing on a type change that no longer carries the field is
              // not cosmetic — questionDraftSchema refuses the save otherwise
              // ("Only choice questions have options" / "Only text questions
              // have a length limit") and the head would have no visible
              // reason why.
              options: typeHasOptions(type) ? r.options : [],
              maxLength: typeHasMaxLength(type) ? r.maxLength : null,
            }
          : r,
      ),
    );
    setDirty(true);
    setSaved(false);
  }

  function addQuestion() {
    setRows((prev) => {
      const list = prev ?? [];
      if (list.length >= EVENT_MAX_QUESTIONS) return list;
      return [
        ...list,
        {
          key: String(nextKey.current++),
          questionID: null,
          type: "short_text",
          label: "",
          helpText: "",
          required: false,
          options: [],
          // The builder's own prefill, not a validation fallback — a saved
          // question with maxLength: null is bounded only by
          // EVENT_ANSWER_TEXT_MAX, and that is a legitimate choice, just not
          // the default one for a fresh question.
          maxLength: EVENT_ANSWER_DEFAULT_MAXLENGTH,
        },
      ];
    });
    setDirty(true);
    setSaved(false);
  }

  function removeQuestion(index: number) {
    setRows((prev) => (prev ?? []).filter((_, i) => i !== index));
    setDirty(true);
    setSaved(false);
  }

  function moveQuestion(index: number, dir: -1 | 1) {
    setRows((prev) => {
      const list = [...(prev ?? [])];
      const target = index + dir;
      if (target < 0 || target >= list.length) return list;
      const [row] = list.splice(index, 1);
      list.splice(target, 0, row!);
      return list;
    });
    setDirty(true);
    setSaved(false);
  }

  function addOption(index: number) {
    const row = (rows ?? [])[index];
    setRow(index, {
      options: [...(row?.options ?? []), ""].slice(0, EVENT_MAX_OPTIONS),
    });
  }

  function updateOption(index: number, optIndex: number, value: string) {
    const row = (rows ?? [])[index];
    if (!row) return;
    const options = row.options.map((o, i) => (i === optIndex ? value : o));
    setRow(index, { options });
  }

  function removeOption(index: number, optIndex: number) {
    const row = (rows ?? [])[index];
    if (!row) return;
    setRow(index, { options: row.options.filter((_, i) => i !== optIndex) });
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    const currentRows = rows ?? [];
    const results: Record<string, RowErrors> = {};
    let hasErrors = false;
    for (const row of currentRows) {
      const e = validateRow(row);
      results[row.key] = e;
      if (rowHasErrors(e)) hasErrors = true;
    }
    setRowErrors(results);
    if (hasErrors) return;

    try {
      await save.mutateAsync({
        eventID,
        questions: currentRows.map(toDraft),
      });
      setSaved(true);
      setDirty(false);
      setRowErrors({});
      // Force a resync from the server on the next render: new questions need
      // their server-allocated ids, and `frozen` may have flipped if a signup
      // landed while this save was in flight.
      setRows(null);
      await utils.event.getQuestionsForOwner.invalidate({ eventID });
    } catch (e) {
      setError(mapError(e));
    }
  }

  const atCap = rows.length >= EVENT_MAX_QUESTIONS;
  const busy = save.isPending;

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-5">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Signup questions
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          Ask residents anything you need when they sign up. Leave this empty
          and signing up stays one tap.
        </p>
      </div>

      {rows.length > 0 && (
        <div className="space-y-4">
          {rows.map((row, index) => {
            const errs = rowErrors[row.key] ?? EMPTY_ROW_ERRORS;
            return (
              <div
                key={row.key}
                className="space-y-3 rounded-md border border-gray-200 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <Select
                    value={row.type}
                    onValueChange={(v) =>
                      handleTypeChange(index, v as EventQuestionType)
                    }
                    disabled={busy}
                  >
                    <SelectTrigger className="w-56 bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EVENT_QUESTION_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {QUESTION_TYPE_COPY[t].label} —{" "}
                          {QUESTION_TYPE_COPY[t].hint}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || index === 0}
                      onClick={() => moveQuestion(index, -1)}
                      aria-label="Move up"
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || index === rows.length - 1}
                      onClick={() => moveQuestion(index, 1)}
                      aria-label="Move down"
                    >
                      Move down
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => removeQuestion(index)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-gray-700">
                    Question
                  </label>
                  <Input
                    value={row.label}
                    maxLength={EVENT_QUESTION_LABEL_MAX}
                    disabled={busy}
                    onChange={(e) => setRow(index, { label: e.target.value })}
                  />
                  {errs.label && (
                    <p className="text-sm text-red-600">{errs.label}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-gray-700">
                    Help text (optional)
                  </label>
                  <Textarea
                    value={row.helpText}
                    maxLength={EVENT_QUESTION_HELP_MAX}
                    rows={2}
                    disabled={busy}
                    onChange={(e) =>
                      setRow(index, { helpText: e.target.value })
                    }
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <Checkbox
                    checked={row.required}
                    disabled={busy}
                    onCheckedChange={(v) =>
                      setRow(index, { required: v === true })
                    }
                  />
                  Required
                </label>

                {typeHasOptions(row.type) && (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-gray-700">
                      Options
                    </label>
                    <div className="space-y-2">
                      {row.options.map((opt, optIndex) => (
                        <div key={optIndex} className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <Input
                              value={opt}
                              maxLength={EVENT_OPTION_LABEL_MAX}
                              disabled={busy}
                              onChange={(e) =>
                                updateOption(index, optIndex, e.target.value)
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              onClick={() => removeOption(index, optIndex)}
                            >
                              Remove
                            </Button>
                          </div>
                          {errs.optionErrors[optIndex] && (
                            <p className="text-sm text-red-600">
                              {errs.optionErrors[optIndex]}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                    {errs.options && (
                      <p className="text-sm text-red-600">{errs.options}</p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || row.options.length >= EVENT_MAX_OPTIONS}
                      onClick={() => addOption(index)}
                    >
                      Add an option
                    </Button>
                  </div>
                )}

                {typeHasMaxLength(row.type) && (
                  <div className="max-w-xs space-y-1.5">
                    <label className="block text-sm font-medium text-gray-700">
                      Maximum length (optional)
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={EVENT_ANSWER_TEXT_MAX}
                      value={row.maxLength ?? ""}
                      disabled={busy}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRow(index, {
                          maxLength: v.trim() ? Number(v) : null,
                        });
                      }}
                    />
                    {errs.maxLength && (
                      <p className="text-sm text-red-600">{errs.maxLength}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        disabled={busy || atCap}
        onClick={addQuestion}
      >
        {atCap
          ? `You’ve reached the limit of ${EVENT_MAX_QUESTIONS} questions`
          : "Add a question"}
      </Button>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
        <Button type="button" disabled={busy || !dirty} onClick={handleSave}>
          {busy ? "Saving…" : "Save questions"}
        </Button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </section>
  );
}
