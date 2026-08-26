import { z } from "zod";

/**
 * Shared custom-signup-question validation. Deliberately NOT under `src/server/`:
 * the client mirrors this validation with a real `safeParse`, so it needs the
 * runtime VALUE, and a `"use client"` component value-importing from the server
 * tree risks pulling Prisma into the browser bundle (and breaks outright if a
 * `server-only` guard is ever added). Same reasoning, same location, as
 * `cca.ts`, `event.ts` and `profile.ts` beside it.
 *
 * ZERO PRISMA IMPORTS, DELIBERATELY. `EVENT_QUESTION_TYPES` is a hand-written
 * `as const` tuple and NOT an enum imported from `@prisma/client` —
 * `EventQuestion.type` is a plain `String` in the schema for the same reason
 * `Event.status` is (the DB cannot police it, so the router does), and importing
 * the generated client here would defeat the whole point of this directory.
 *
 * TWO THINGS ARE SHARED AND THEY ARE DIFFERENT THINGS. Conflating them is how
 * this goes wrong:
 *
 *   - `questionDraftSchema` / `saveQuestionsInput` validate the SHAPE of a
 *     payload. Static, `safeParse`d identically on both sides.
 *   - `validateAnswers` validates the CONTENT of a submission against the
 *     STORED questions. It is a plain function, NOT a zod schema built at
 *     runtime, for four reasons: (1) this repo has never built a schema at
 *     runtime — `z.record`, `z.lazy`, `z.any`, `.catchall` and `.passthrough`
 *     return zero hits across `src/`; (2) the client does not know the
 *     authoritative question list, only what it last fetched, which a co-head
 *     may have changed since — the identical argument `updateEventInput` already
 *     makes for not encoding the per-status field subset, and the identical
 *     posture `completeProfileInput` takes; (3) errors must be keyed by
 *     `questionID`, not by array index, so they render under the right field;
 *     (4) both sides import the SAME function, so "the client mirrors the
 *     server" is enforced by the module system rather than by discipline.
 *
 * The server runs both, against the stored questions, inside `withEventLock`.
 * The client runs both too — but its result is a convenience, never a gate.
 */

/* -------------------------------------------------------------------------- */
/* The type vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The seven question types. Enforced HERE, in code — `EventQuestion.type` is a
 * plain `String` in `schema.prisma`, never a DB enum, for the same reason
 * `Event.status` is one.
 *
 * THE SERIALISATION OF EVERY TYPE IS DEFINED IN `ANSWER_SERIALISATION` BELOW
 * AND NOWHERE ELSE. Every answer, whatever the type, is a `string[]`.
 */
export const EVENT_QUESTION_TYPES = [
  "short_text",
  "long_text",
  "single_choice",
  "multi_choice",
  "checkbox",
  "number",
  "date",
] as const;
export type EventQuestionType = (typeof EVENT_QUESTION_TYPES)[number];

export function isEventQuestionType(v: string): v is EventQuestionType {
  return (EVENT_QUESTION_TYPES as readonly string[]).includes(v);
}

/**
 * ONE FIELD, `values: string[]`, FOR EVERY TYPE. The rules, written once:
 *
 *   short_text, long_text   [text]                        empty: []
 *   single_choice           [chosenOption], one of options    empty: []
 *   multi_choice            [a, b, …], each in options, no dups   empty: []
 *   checkbox                ["yes"] when ticked           empty: [] when not
 *   number                  [String(n)], n finite         empty: []
 *   date                    ["YYYY-MM-DD"], a CALENDAR DATE   empty: []
 *
 * WHY ONE STRING LIST RATHER THAN TYPED COLUMNS. A composite with `text?`,
 * `number?` and `choices[]` would have three ways to spell an empty answer and
 * would need a discriminated read at every consumer. One list has one empty
 * value (`[]`) and one CSV serialisation (`values.join("; ")`).
 *
 * WHY `date` IS A CALENDAR DATE AND NOT AN EPOCH. `Event.startTime` is epoch
 * SECONDS because it names an INSTANT. "Which day can you make?" names a DATE,
 * and storing it as an instant makes it shift across timezones — the answer a
 * resident typed on 3 March reads back as 2 March for a reader an hour west.
 * Every other date in this repo is an instant; this one deliberately is not.
 */
export const ANSWER_SERIALISATION: Record<EventQuestionType, string> = {
  short_text: "[text]",
  long_text: "[text]",
  single_choice: "[chosenOption] — must be one of options",
  multi_choice: "[a, b, …] — each must be in options, no duplicates",
  checkbox: '["yes"] when ticked, [] when not',
  number: "[String(n)] — n parses as a finite number",
  date: '["YYYY-MM-DD"] — a calendar date, no time, no zone',
};

/* -------------------------------------------------------------------------- */
/* Caps                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * ARBITRARY, AND STATED AS ARBITRARY. They exist so a crafted payload cannot
 * make one signup document unbounded, and so the CSV export cannot grow a
 * hundred columns. Change them here, in one place, if a real event needs more.
 */
export const EVENT_MAX_QUESTIONS = 20;
export const EVENT_QUESTION_LABEL_MAX = 200;
export const EVENT_QUESTION_HELP_MAX = 300;
export const EVENT_MAX_OPTIONS = 20;
export const EVENT_OPTION_LABEL_MAX = 120;

/**
 * The HARD CEILING on one answer value, which a question's own `maxLength` may
 * not exceed. Enforced by `answerValueSchema` on shape, so it binds even for a
 * question whose `maxLength` is null.
 */
export const EVENT_ANSWER_TEXT_MAX = 2000;

/**
 * What the BUILDER pre-fills into a new text question's length limit. It is NOT
 * the validation fallback: a question with `maxLength: null` is bounded by
 * `EVENT_ANSWER_TEXT_MAX` and by nothing else, because rejecting a 300-character
 * answer to a question that never advertised a limit would be a refusal the
 * resident could not have anticipated.
 */
export const EVENT_ANSWER_DEFAULT_MAXLENGTH = 200;

/** Belt-and-braces bound on the number of values in one answer. */
export const EVENT_MAX_ANSWER_VALUES = 64;

/* -------------------------------------------------------------------------- */
/* Builder copy                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A `Record` OVER THE UNION, not a partial map: adding a type to
 * `EVENT_QUESTION_TYPES` without copy is then a COMPILE ERROR rather than a
 * blank label in the picker. The same trick `PROFILE_COMPLETION_COPY` uses.
 */
export const QUESTION_TYPE_COPY: Record<
  EventQuestionType,
  { label: string; hint: string }
> = {
  short_text: { label: "Short answer", hint: "One line of text" },
  long_text: { label: "Long answer", hint: "A paragraph" },
  single_choice: {
    label: "Pick one",
    hint: "A list where they choose one",
  },
  multi_choice: {
    label: "Pick several",
    hint: "A list where they can choose more than one",
  },
  checkbox: { label: "Tick box", hint: "A single yes/no tick" },
  number: { label: "Number", hint: "Digits only" },
  date: { label: "Date", hint: "A calendar date, no time" },
};

/** The two types that carry `options`. Asked in three places; defined in one. */
export function typeHasOptions(type: string): boolean {
  return type === "single_choice" || type === "multi_choice";
}

/** The two types that carry `maxLength`. */
export function typeHasMaxLength(type: string): boolean {
  return type === "short_text" || type === "long_text";
}

/* -------------------------------------------------------------------------- */
/* The builder payload — SHAPE                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One question as the builder sends it.
 *
 * `questionID: null` MEANS A NEW QUESTION. A non-null id must already exist on
 * the event; the router refuses `NO_SUCH_QUESTION` otherwise. Ids are allocated
 * server-side as `max(existing) + 1` and are NEVER REUSED — an answer references
 * one, and recycling a deleted id would silently rebind an old answer to a new
 * question.
 *
 * `label` and `helpText` are TRIMMED HERE, in zod, not in the router — the same
 * precedent `update` sets for `publicDescription`.
 */
export const questionDraftSchema = z
  .object({
    questionID: z.number().int().positive().nullable(),
    type: z.enum(EVENT_QUESTION_TYPES),
    label: z
      .string()
      .trim()
      .min(1, "Every question needs a label")
      .max(EVENT_QUESTION_LABEL_MAX),
    helpText: z.string().trim().max(EVENT_QUESTION_HELP_MAX).optional(),
    required: z.boolean().optional(),
    options: z
      .array(z.string().trim().min(1).max(EVENT_OPTION_LABEL_MAX))
      .max(EVENT_MAX_OPTIONS)
      .optional(),
    maxLength: z
      .number()
      .int()
      .positive()
      .max(EVENT_ANSWER_TEXT_MAX)
      .nullable()
      .optional(),
  })
  .superRefine((q, ctx) => {
    const needsOptions = typeHasOptions(q.type);
    if (needsOptions && (q.options ?? []).length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "A choice question needs at least two options",
      });
    }
    if (!needsOptions && (q.options ?? []).length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Only choice questions have options",
      });
    }
    if (needsOptions) {
      const seen = new Set<string>();
      (q.options ?? []).forEach((o, i) => {
        const k = o.toLowerCase();
        if (seen.has(k)) {
          // INDEXED PATH, so the builder can show the error on the right row.
          // Same shape `photoUrls` already uses in schemas/event.ts.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", i],
            message: "Two options can’t be the same",
          });
        }
        seen.add(k);
      });
    }
    if (!typeHasMaxLength(q.type) && q.maxLength != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxLength"],
        message: "Only text questions have a length limit",
      });
    }
  });
export type QuestionDraft = z.input<typeof questionDraftSchema>;

/**
 * ONE WHOLE-LIST SAVE. There is deliberately no per-question add / edit /
 * delete / reorder mutation: reordering is the operation a builder does most,
 * and a per-question `order` patch is N writes that can half-apply. One list,
 * one reconciliation, one lock.
 */
export const saveQuestionsInput = z.object({
  eventID: z.number().int().positive(),
  questions: z.array(questionDraftSchema).max(EVENT_MAX_QUESTIONS),
});
export type SaveQuestionsInput = z.input<typeof saveQuestionsInput>;

/* -------------------------------------------------------------------------- */
/* The answer payload — SHAPE                                                   */
/* -------------------------------------------------------------------------- */

/**
 * PERMISSIVE BY DESIGN. This checks that an answer is well-formed, never that
 * it is CORRECT for the question it names — the client's copy of the question
 * list can be stale, so only the server, holding the stored questions, can
 * decide that. `validateAnswers` is where content is judged.
 */
export const answerValueSchema = z.object({
  questionID: z.number().int().positive(),
  values: z
    .array(z.string().max(EVENT_ANSWER_TEXT_MAX))
    .max(EVENT_MAX_ANSWER_VALUES),
});
export type EventAnswerValue = z.infer<typeof answerValueSchema>;

/**
 * The subset of a stored `EventQuestion` that `validateAnswers` needs. Spelled
 * structurally rather than as the Prisma row type, so this module stays free of
 * `@prisma/client` and the client can build one from what `getPublic` returned.
 */
export type QuestionForValidation = {
  questionID: number;
  type: string;
  required?: boolean | null;
  options?: readonly string[] | null;
  maxLength?: number | null;
};

/* -------------------------------------------------------------------------- */
/* The answer CONTENT validator                                                 */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD`, and a real calendar date — 2026-02-31 is neither. */
function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Date.UTC normalises an overflowing day (Feb 31 -> Mar 3), so a round trip
  // that changes any component means the date does not exist.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

export type ValidateAnswersResult =
  | { ok: true; normalized: EventAnswerValue[] }
  | { ok: false; errors: Record<number, string> };

/**
 * THE content validator, shared verbatim by the resident's form and by
 * `event.signup`. Errors are keyed by `questionID` so they render under the
 * right field.
 *
 * `normalized` carries ONE ENTRY PER STORED QUESTION, in the questions' own
 * order, with `values: []` for anything unanswered. That is what makes the CSV
 * export's columns line up without a lookup, and it is why an unanswered
 * optional question is `[]` rather than absent.
 *
 * AN ANSWER NAMING A QUESTION THAT IS NOT ON THIS EVENT IS AN ERROR, not
 * something to ignore: it means the client is holding a form that has changed,
 * and silently dropping the value would store an incomplete submission while
 * telling the resident it worked.
 */
export function validateAnswers(
  questions: readonly QuestionForValidation[],
  answers: readonly EventAnswerValue[],
): ValidateAnswersResult {
  const errors: Record<number, string> = {};
  const byID = new Map<number, EventAnswerValue>();
  const known = new Set(questions.map((q) => q.questionID));

  for (const a of answers) {
    if (!known.has(a.questionID)) {
      errors[a.questionID] = "This form has changed. Reload the page.";
      continue;
    }
    // A duplicate entry for the same question is the same staleness signal.
    if (byID.has(a.questionID)) {
      errors[a.questionID] = "This form has changed. Reload the page.";
      continue;
    }
    byID.set(a.questionID, a);
  }

  const normalized: EventAnswerValue[] = [];

  for (const q of questions) {
    const raw = byID.get(q.questionID)?.values ?? [];
    // Empty strings are not answers. Trimming here means "   " does not satisfy
    // a required question, which is the behaviour a resident expects.
    const given = raw.map((v) => v.trim()).filter((v) => v.length > 0);
    let values: string[] = [];

    if (given.length === 0) {
      if (q.required === true) {
        errors[q.questionID] = "Please answer this";
      }
      normalized.push({ questionID: q.questionID, values: [] });
      continue;
    }

    switch (q.type) {
      case "short_text":
      case "long_text": {
        const text = given.join(" ");
        // THE CAP IS `maxLength` WHEN THERE IS ONE AND `EVENT_ANSWER_TEXT_MAX`
        // WHEN THERE IS NOT — and the fallback is NOT optional.
        //
        // `answerValueSchema` bounds each ELEMENT of `values` at
        // EVENT_ANSWER_TEXT_MAX and the list at EVENT_MAX_ANSWER_VALUES, but
        // this branch JOINS them, so a crafted payload of 64 x 2000 characters
        // arrives here as one 128,063-character string. With no fallback a
        // `maxLength: null` question stored all of it: measured, not
        // hypothesised. Twenty such questions is ~2.5 MB on one signup
        // document, and every byte flows into the head's table and the CSV.
        // The docblock on EVENT_ANSWER_TEXT_MAX says the ceiling "binds even
        // for a question whose maxLength is null"; this line is what makes
        // that sentence true.
        //
        // The legitimate client can never reach this: EventSignupQuestions
        // sets maxLength={q.maxLength ?? EVENT_ANSWER_TEXT_MAX} on the input
        // and sends at most one value. Behaviour for a question that HAS a
        // maxLength is unchanged, byte for byte.
        const cap = q.maxLength ?? EVENT_ANSWER_TEXT_MAX;
        if (text.length > cap) {
          errors[q.questionID] = `Keep this under ${cap} characters`;
          break;
        }
        values = [text];
        break;
      }

      case "single_choice": {
        if (given.length > 1) {
          errors[q.questionID] = "Pick just one";
          break;
        }
        const opts = q.options ?? [];
        const chosen = given[0]!;
        if (!opts.includes(chosen)) {
          errors[q.questionID] =
            "That option isn’t available any more. Reload the page.";
          break;
        }
        values = [chosen];
        break;
      }

      case "multi_choice": {
        const opts = q.options ?? [];
        const seen = new Set<string>();
        const kept: string[] = [];
        let bad = false;
        for (const v of given) {
          if (!opts.includes(v)) {
            bad = true;
            break;
          }
          // Duplicates are DEDUPED, not refused. The plan gives no copy for a
          // duplicate answer, and a repeated tick is a client bug the resident
          // cannot act on — keeping the first occurrence is the honest repair.
          if (seen.has(v)) continue;
          seen.add(v);
          kept.push(v);
        }
        if (bad) {
          errors[q.questionID] =
            "That option isn’t available any more. Reload the page.";
          break;
        }
        values = kept;
        break;
      }

      case "checkbox": {
        // Any non-empty value means ticked. Normalised to the one spelling so
        // every consumer tests `values.length > 0` and nothing else.
        values = ["yes"];
        break;
      }

      case "number": {
        if (given.length > 1) {
          errors[q.questionID] = "Please enter a number";
          break;
        }
        const n = Number(given[0]);
        if (!Number.isFinite(n)) {
          errors[q.questionID] = "Please enter a number";
          break;
        }
        values = [String(n)];
        break;
      }

      case "date": {
        if (given.length > 1 || !isCalendarDate(given[0]!)) {
          errors[q.questionID] = "Please pick a date";
          break;
        }
        values = [given[0]!];
        break;
      }

      default: {
        // A stored type outside the vocabulary. The DB cannot police `type`, so
        // this is reachable by a hand-edited row, and refusing is the only safe
        // answer — accepting would store a value nothing knows how to render.
        errors[q.questionID] = "This form has changed. Reload the page.";
        break;
      }
    }

    normalized.push({ questionID: q.questionID, values });
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, normalized };
}

/* -------------------------------------------------------------------------- */
/* Retention — LAYER 1, the read cutoff                                         */
/* -------------------------------------------------------------------------- */

export const EVENT_ANSWER_RETENTION_DAYS = 60;

/**
 * THE READ CUTOFF, AND IT IS UNCONDITIONAL. `getAttendees`, `exportAttendees`
 * and `getSignupAnswers` return NO ANSWERS AT ALL once this is false — whether
 * or not the rows still hold them, and whether or not `answersPurgedAt` is set.
 *
 * THIS IS THE HALF THE APPLICATION GUARANTEES. The erasure itself
 * (`scripts/remediation/purge-event-answers.mjs`) is a script a human runs;
 * THERE IS NO CRON IN THIS REPOSITORY. That is exactly why the resident-facing
 * copy says the answers "stop being available" rather than "are deleted": what
 * the code guarantees on time, with no operator, is that it stops handing them
 * out. Do not strengthen that sentence unless and until something automatic
 * performs the deletion.
 *
 * Client-safe, so the resident's form and the head's table agree about the same
 * boundary rather than each computing their own.
 *
 * `endTime`/`startTime` are UNIX epoch SECONDS (`Event.startTime`), and so is
 * `nowSec`. An event with NO date on file is retained: there is nothing to count
 * sixty days from, and guessing would hide answers early.
 */
export function answersAreRetained(
  endTime: number | null,
  startTime: number | null,
  nowSec: number,
): boolean {
  const ref = endTime ?? startTime;
  if (ref == null) return true;
  return nowSec < ref + EVENT_ANSWER_RETENTION_DAYS * 86_400;
}

/** The CSV/table cell for an answer that is no longer available (T-29). */
export const ANSWER_WITHHELD_CELL = "—";
