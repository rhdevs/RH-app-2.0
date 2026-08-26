"use client";

import { EVENT_ANSWER_TEXT_MAX } from "~/lib/schemas/eventQuestion";
import { Label } from "~/components/ui/label";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Checkbox } from "~/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";

/**
 * The subset of `EventQuestion` that `getPublic` returns — one entry per row,
 * sorted by `order`. Matches `PUBLIC_QUESTION_FIELDS` in
 * `src/server/api/routers/event.ts` (do not edit that file from here; this
 * type just describes what it already sends over the wire).
 */
export type EventPublicQuestion = {
  questionID: number;
  order: number;
  type: string;
  label: string;
  helpText: string | null;
  required: boolean | null;
  options: string[];
  maxLength: number | null;
};

/**
 * The draft answer map this component reads and writes. ONE ENTRY PER
 * ANSWERED QUESTION, keyed by `questionID` — an unanswered question is simply
 * absent, not `[]`. `EventDetail` is the thing that turns this into the
 * `EventAnswerValue[]` the mutation wants and that `validateAnswers` checks;
 * this component never talks to tRPC itself.
 */
export type EventAnswerDraft = Record<number, string[]>;

/**
 * The resident's half of a custom-question form. NO MUTATION OF ITS OWN — the
 * parent (`EventDetail`) owns `signup` and calls `validateAnswers`; `errors`
 * arrives already keyed by `questionID` from that same function, so it can be
 * rendered directly under the right field without this component knowing
 * anything about validation rules.
 *
 * The answer serialisation (every value is a `string[]`) is defined once in
 * `src/lib/schemas/eventQuestion.ts` and followed here without re-deriving it:
 * short_text/long_text/number/date carry at most one string, single_choice
 * carries the one chosen option, multi_choice carries the ticked options, and
 * checkbox carries `["yes"]` when ticked and `[]` when not.
 */
export default function EventSignupQuestions({
  questions,
  value,
  onChange,
  errors,
}: {
  questions: EventPublicQuestion[];
  value: EventAnswerDraft;
  onChange: (questionID: number, values: string[]) => void;
  errors: Record<number, string>;
}) {
  return (
    <div className="space-y-5">
      {questions.map((q) => {
        const current = value[q.questionID] ?? [];
        const error = errors[q.questionID];
        const fieldID = `event-question-${q.questionID}`;
        const labelNode = (
          <Label htmlFor={fieldID} className="font-medium text-gray-900">
            {q.label}
            {q.required === true && (
              <span className="ml-1.5 align-middle text-xs font-normal text-red-600">
                Required
              </span>
            )}
          </Label>
        );

        if (q.type === "checkbox") {
          return (
            <div key={q.questionID} className="space-y-1.5">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={fieldID}
                  className="mt-0.5"
                  checked={current.length > 0}
                  onCheckedChange={(checked) =>
                    onChange(q.questionID, checked === true ? ["yes"] : [])
                  }
                />
                <div className="grid gap-0.5 leading-snug">
                  {labelNode}
                  {q.helpText && (
                    <p className="text-xs text-gray-500">{q.helpText}</p>
                  )}
                </div>
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
          );
        }

        return (
          <div key={q.questionID} className="space-y-1.5">
            {labelNode}
            {q.helpText && (
              <p className="text-xs text-gray-500">{q.helpText}</p>
            )}

            {(q.type === "short_text" || q.type === "long_text") &&
              (q.type === "short_text" ? (
                <Input
                  id={fieldID}
                  value={current[0] ?? ""}
                  maxLength={q.maxLength ?? EVENT_ANSWER_TEXT_MAX}
                  onChange={(e) =>
                    onChange(
                      q.questionID,
                      e.target.value ? [e.target.value] : [],
                    )
                  }
                />
              ) : (
                <Textarea
                  id={fieldID}
                  value={current[0] ?? ""}
                  maxLength={q.maxLength ?? EVENT_ANSWER_TEXT_MAX}
                  onChange={(e) =>
                    onChange(
                      q.questionID,
                      e.target.value ? [e.target.value] : [],
                    )
                  }
                />
              ))}

            {q.type === "number" && (
              <Input
                id={fieldID}
                type="number"
                value={current[0] ?? ""}
                onChange={(e) =>
                  onChange(
                    q.questionID,
                    e.target.value ? [e.target.value] : [],
                  )
                }
              />
            )}

            {q.type === "date" && (
              <Input
                id={fieldID}
                type="date"
                value={current[0] ?? ""}
                onChange={(e) =>
                  onChange(
                    q.questionID,
                    e.target.value ? [e.target.value] : [],
                  )
                }
              />
            )}

            {q.type === "single_choice" && (
              <RadioGroup
                value={current[0] ?? ""}
                onValueChange={(v) => onChange(q.questionID, v ? [v] : [])}
              >
                {q.options.map((opt) => (
                  <div key={opt} className="flex items-center gap-2">
                    <RadioGroupItem id={`${fieldID}-${opt}`} value={opt} />
                    <Label
                      htmlFor={`${fieldID}-${opt}`}
                      className="font-normal text-gray-700"
                    >
                      {opt}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            )}

            {q.type === "multi_choice" && (
              <div className="space-y-1.5">
                {q.options.map((opt) => {
                  const checked = current.includes(opt);
                  return (
                    <div key={opt} className="flex items-center gap-2">
                      <Checkbox
                        id={`${fieldID}-${opt}`}
                        checked={checked}
                        onCheckedChange={(next) => {
                          if (next === true) {
                            onChange(q.questionID, [...current, opt]);
                          } else {
                            onChange(
                              q.questionID,
                              current.filter((v) => v !== opt),
                            );
                          }
                        }}
                      />
                      <Label
                        htmlFor={`${fieldID}-${opt}`}
                        className="font-normal text-gray-700"
                      >
                        {opt}
                      </Label>
                    </div>
                  );
                })}
              </div>
            )}

            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}
