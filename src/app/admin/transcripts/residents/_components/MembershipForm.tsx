"use client";

import { Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  EXTRA_MAX,
  ROLE_MAX,
  counterText,
  draftOf,
  durationOptions,
  effectiveMembership,
  fitRolePeriod,
  isDirty,
  roleDurationOptions,
  roleDurationValue,
  rowProblem,
  upsertFields,
  type DurationChoice,
  type RowDraft,
} from "~/lib/transcript/headView";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";
import {
  FIELD_GRID,
  RECORD_CARD,
  SELECT_CLASS,
  SaveButton,
  useReportDirty,
  type SectionProps,
} from "./ResidentBits";

export interface StoredMembership {
  duration: string | null;
  roleLabel: string | null;
  roleDuration: string | null;
  extraContribution: string | null;
}

export const BLANK_DRAFT: RowDraft = {
  duration: "",
  roleLabel: "",
  roleDuration: "",
  extra: "",
};

const TEXT_BUTTON =
  "text-xs font-medium text-emerald-800 underline underline-offset-2 hover:text-emerald-900 disabled:opacity-50";

const hasOverrides = (d: RowDraft) =>
  d.duration !== "" ||
  d.roleLabel.trim() !== "" ||
  d.roleDuration !== "" ||
  d.extra.trim() !== "";

export interface MembershipFormViewProps {
  idKey: string;
  title: string;
  tags?: ReactNode;
  note?: ReactNode;
  draft: RowDraft;
  saved: RowDraft;
  defaultRoleLabel: string | null;
  /** True where there is a default to go back to (a live list). */
  canReset: boolean;
  editable: boolean;
  onDraft: (patch: Partial<RowDraft>) => void;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
  savedNow: boolean;
  error: string | null;
  roleNote: string | null;
  actions?: ReactNode;
}

/** One membership, as a card: duration, role, role period and contribution. */
export function MembershipFormView(p: MembershipFormViewProps) {
  const { draft } = p;
  const dirty = isDirty(draft, p.saved);
  const problem = rowProblem(draft);
  const hasRole = draft.roleLabel.trim() !== "" || p.defaultRoleLabel !== null;
  const off = !p.editable;
  return (
    <li className={`${RECORD_CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-900">{p.title}</h4>
        {p.tags}
      </div>
      {p.note ? <p className="text-xs text-gray-600">{p.note}</p> : null}
      <div className={FIELD_GRID}>
        <div>
          <label htmlFor={`duration-${p.idKey}`} className={FIELD_LABEL}>
            Duration
          </label>
          <select
            id={`duration-${p.idKey}`}
            value={draft.duration}
            disabled={off}
            onChange={(e) =>
              p.onDraft({ duration: e.target.value as DurationChoice })
            }
            className={SELECT_CLASS}
          >
            {durationOptions().map((o) => (
              <option key={o.value || "default"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`role-${p.idKey}`} className={FIELD_LABEL}>
            Role
          </label>
          <Input
            id={`role-${p.idKey}`}
            value={draft.roleLabel}
            maxLength={ROLE_MAX}
            disabled={off}
            placeholder={
              p.defaultRoleLabel
                ? `Default: ${p.defaultRoleLabel}`
                : "Leave blank for member"
            }
            onChange={(e) => p.onDraft({ roleLabel: e.target.value })}
          />
          {!off && draft.roleLabel.trim() !== "" && (
            <button
              type="button"
              className={`${TEXT_BUTTON} mt-1`}
              aria-label={`Clear role for ${p.title}`}
              onClick={() => p.onDraft({ roleLabel: "", roleDuration: "" })}
            >
              Clear role
            </button>
          )}
        </div>
        {hasRole && (
          <div>
            <label htmlFor={`roleDuration-${p.idKey}`} className={FIELD_LABEL}>
              Role period
            </label>
            <select
              id={`roleDuration-${p.idKey}`}
              value={roleDurationValue(
                effectiveMembership(draft.duration),
                draft.roleDuration,
              )}
              disabled={off}
              onChange={(e) =>
                p.onDraft({ roleDuration: e.target.value as DurationChoice })
              }
              className={SELECT_CLASS}
            >
              {roleDurationOptions(effectiveMembership(draft.duration)).map(
                (o) => (
                  <option key={o.value || "default"} value={o.value}>
                    {o.label}
                  </option>
                ),
              )}
            </select>
          </div>
        )}
      </div>
      <div>
        <label htmlFor={`extra-${p.idKey}`} className={FIELD_LABEL}>
          Additional contribution
        </label>
        <Textarea
          id={`extra-${p.idKey}`}
          rows={2}
          value={draft.extra}
          maxLength={EXTRA_MAX}
          disabled={off}
          onChange={(e) => p.onDraft({ extra: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(draft.extra, EXTRA_MAX)}
        </p>
        {!off && draft.extra.trim() !== "" && (
          <button
            type="button"
            className={TEXT_BUTTON}
            aria-label={`Clear contribution for ${p.title}`}
            onClick={() => p.onDraft({ extra: "" })}
          >
            Clear contribution
          </button>
        )}
      </div>
      {p.roleNote && (
        <p className="text-xs text-gray-600" role="status">
          {p.roleNote}
        </p>
      )}
      <ErrorLine message={problem ?? p.error} />
      <div className="flex flex-wrap items-center gap-3">
        {!off && (
          <SaveButton
            pending={p.saving}
            disabled={!dirty || problem !== null}
            onClick={p.onSave}
          />
        )}
        {!off && p.canReset && hasOverrides(draft) && (
          <button
            type="button"
            className={TEXT_BUTTON}
            aria-label={`Reset to default for ${p.title}`}
            onClick={p.onReset}
          >
            Reset to default
          </button>
        )}
        {p.savedNow && !dirty && (
          <span
            className="inline-flex items-center gap-1 text-xs text-emerald-700"
            role="status"
          >
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
        {p.actions}
      </div>
    </li>
  );
}

/** The server's message for one failed save, field errors first. */
export function saveErrorText(error: unknown): string {
  const e = error as {
    message?: string;
    data?: {
      zodError?: { fieldErrors?: Record<string, string[] | undefined> } | null;
    };
  };
  const zod = e.data?.zodError ?? null;
  return (
    fieldError(zod, "roleLabel") ??
    fieldError(zod, "extraContribution") ??
    errorText(e.message)
  );
}

export interface MembershipFormProps {
  idKey: string;
  title: string;
  tags?: ReactNode;
  note?: ReactNode;
  saved: StoredMembership;
  defaultRoleLabel: string | null;
  canReset: boolean;
  editable: boolean;
  /** Store the fields; rejects with the server's error. */
  save: (fields: ReturnType<typeof upsertFields>) => Promise<void>;
  onDirty: SectionProps["onDirty"];
  actions?: ReactNode;
}

/** The container: owns the draft, the save and the unsaved report. */
export function MembershipForm(p: MembershipFormProps) {
  const savedDraft = draftOf(p.saved);
  const savedKey = JSON.stringify(savedDraft);
  const [draft, setDraft] = useState<RowDraft>(savedDraft);
  const [saving, setSaving] = useState(false);
  const [savedNow, setSavedNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleNote, setRoleNote] = useState<string | null>(null);

  // A refetch after a save brings the stored values; adopt them.
  useEffect(() => {
    setDraft(JSON.parse(savedKey) as RowDraft);
  }, [savedKey]);

  useReportDirty(
    `membership:${p.idKey}`,
    isDirty(draft, savedDraft),
    p.onDirty,
  );

  const onDraft = (patch: Partial<RowDraft>) => {
    setError(null);
    setSavedNow(false);
    setRoleNote(null);
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (patch.duration === undefined) return next;
      const fitted = fitRolePeriod(next);
      setRoleNote(fitted.note);
      return fitted.draft;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await p.save(upsertFields(draft));
      setSavedNow(true);
    } catch (e) {
      setError(saveErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <MembershipFormView
      idKey={p.idKey}
      title={p.title}
      tags={p.tags}
      note={p.note}
      draft={draft}
      saved={savedDraft}
      defaultRoleLabel={p.defaultRoleLabel}
      canReset={p.canReset}
      editable={p.editable}
      onDraft={onDraft}
      onReset={() => {
        setSavedNow(false);
        setRoleNote(null);
        setDraft(BLANK_DRAFT);
      }}
      onSave={() => void save()}
      saving={saving}
      savedNow={savedNow}
      error={error}
      roleNote={roleNote}
      actions={p.actions}
    />
  );
}
