"use client";

import { Loader2, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  errorText,
  fieldError,
  isWritable,
  yearOptions,
} from "~/lib/transcript/adminView";
import {
  CONTRIBUTIONS_MAX_ITEMS,
  CONTRIBUTION_MAX,
  DESCRIPTION_MAX,
  NOT_JCRC_NOTE,
  PORTFOLIO_MAX,
  POSITION_MAX,
  PUBLISHED_NOTE,
  SIGNATURE_PLACEHOLDER_NOTE,
  TESTIMONIAL_MAX,
  counterText,
} from "~/lib/transcript/headView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL, SectionCard, YearSelect } from "./Bits";
import { previewHref } from "./PreviewPicker";

export interface JcrcDraft {
  portfolio: string;
  position: string;
  description: string;
  contributions: string[];
  testimonial: string;
}

export const EMPTY_JCRC: JcrcDraft = {
  portfolio: "",
  position: "",
  description: "",
  contributions: [],
  testimonial: "",
};

export interface JcrcSelfViewProps {
  academicYear: string;
  years: string[];
  onYear: (year: string) => void;
  readOnly: boolean;
  draft: JcrcDraft;
  onDraft: (patch: Partial<JcrcDraft>) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  dirty: boolean;
  error: string | null;
  fieldErrors: Partial<Record<keyof JcrcDraft, string | null>>;
  previewUrl: string;
}

/** Your own JCRC page: portfolio, role, contributions and testimonial. */
export function JcrcSelfView(p: JcrcSelfViewProps) {
  const { draft } = p;
  const canAddContribution =
    !p.readOnly && draft.contributions.length < CONTRIBUTIONS_MAX_ITEMS;

  return (
    <SectionCard
      title="Your JCRC page"
      description="This is the JCRC service page of your own transcript."
    >
      <YearSelect
        id="jcrc-year"
        label="Academic year"
        value={p.academicYear}
        options={p.years}
        onChange={p.onYear}
      />
      {p.readOnly && (
        <p className="mt-3 text-sm text-amber-800" role="status">
          {PUBLISHED_NOTE(p.academicYear)}
        </p>
      )}
      <p className="mt-3 text-sm text-gray-600">{SIGNATURE_PLACEHOLDER_NOTE}</p>

      <form
        className="mt-5 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!p.readOnly && p.dirty && !p.saving) p.onSave();
        }}
      >
        <div className="max-w-md">
          <label htmlFor="jcrc-portfolio" className={FIELD_LABEL}>
            Portfolio
          </label>
          <Input
            id="jcrc-portfolio"
            value={draft.portfolio}
            maxLength={PORTFOLIO_MAX}
            disabled={p.readOnly}
            onChange={(e) => p.onDraft({ portfolio: e.target.value })}
          />
          <ErrorLine message={p.fieldErrors.portfolio} />
        </div>
        <div className="max-w-md">
          <label htmlFor="jcrc-position" className={FIELD_LABEL}>
            Position
          </label>
          <Input
            id="jcrc-position"
            value={draft.position}
            maxLength={POSITION_MAX}
            disabled={p.readOnly}
            onChange={(e) => p.onDraft({ position: e.target.value })}
          />
          <ErrorLine message={p.fieldErrors.position} />
        </div>
        <div className="max-w-2xl">
          <label htmlFor="jcrc-description" className={FIELD_LABEL}>
            What this role covers
          </label>
          <Textarea
            id="jcrc-description"
            rows={4}
            value={draft.description}
            maxLength={DESCRIPTION_MAX}
            disabled={p.readOnly}
            onChange={(e) => p.onDraft({ description: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(draft.description, DESCRIPTION_MAX)}
          </p>
          <ErrorLine message={p.fieldErrors.description} />
        </div>

        <fieldset className="max-w-2xl">
          <legend className={FIELD_LABEL}>Contributions during the year</legend>
          {draft.contributions.length === 0 && (
            <p className="text-sm text-gray-500">No contributions added.</p>
          )}
          <ul className="space-y-2">
            {draft.contributions.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <label htmlFor={`jcrc-contribution-${i}`} className="sr-only">
                  {`Contribution ${i + 1}`}
                </label>
                <Input
                  id={`jcrc-contribution-${i}`}
                  value={c}
                  maxLength={CONTRIBUTION_MAX}
                  disabled={p.readOnly}
                  onChange={(e) =>
                    p.onDraft({
                      contributions: draft.contributions.map((x, j) =>
                        j === i ? e.target.value : x,
                      ),
                    })
                  }
                />
                {!p.readOnly && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove contribution ${i + 1}`}
                    onClick={() =>
                      p.onDraft({
                        contributions: draft.contributions.filter(
                          (_, j) => j !== i,
                        ),
                      })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-3">
            {!p.readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canAddContribution}
                onClick={() =>
                  p.onDraft({ contributions: [...draft.contributions, ""] })
                }
              >
                <Plus className="mr-1 h-4 w-4" />
                Add contribution
              </Button>
            )}
            <span className="text-xs text-gray-500">
              {`${draft.contributions.length} of ${CONTRIBUTIONS_MAX_ITEMS}, up to ${CONTRIBUTION_MAX} characters each`}
            </span>
          </div>
          <ErrorLine message={p.fieldErrors.contributions} />
        </fieldset>

        <div className="max-w-2xl">
          <label htmlFor="jcrc-testimonial" className={FIELD_LABEL}>
            Testimonial
          </label>
          <Textarea
            id="jcrc-testimonial"
            rows={8}
            value={draft.testimonial}
            maxLength={TESTIMONIAL_MAX}
            disabled={p.readOnly}
            onChange={(e) => p.onDraft({ testimonial: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(draft.testimonial, TESTIMONIAL_MAX)}
          </p>
          <ErrorLine message={p.fieldErrors.testimonial} />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {!p.readOnly && (
            <Button type="submit" disabled={!p.dirty || p.saving}>
              {p.saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          )}
          {p.saved && !p.dirty && (
            <span className="text-sm text-emerald-700" role="status">
              Saved
            </span>
          )}
          <Link
            href={p.previewUrl}
            className="text-sm font-medium text-emerald-800 underline underline-offset-2"
          >
            Preview my transcript
          </Link>
        </div>
        <ErrorLine message={p.error} />
      </form>
    </SectionCard>
  );
}

const same = (a: JcrcDraft, b: JcrcDraft) =>
  a.portfolio.trim() === b.portfolio.trim() &&
  a.position.trim() === b.position.trim() &&
  a.description.trim() === b.description.trim() &&
  a.testimonial.trim() === b.testimonial.trim() &&
  a.contributions.length === b.contributions.length &&
  a.contributions.every((c, i) => c.trim() === b.contributions[i]?.trim());

export default function JcrcSelf({ userID }: { userID: string }) {
  const utils = api.useUtils();
  const periods = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const [year, setYear] = useState<string | null>(null);
  const current = periods.data?.currentAcademicYear ?? "";
  const selected = year ?? current;

  const mine = api.transcriptManage.jcrc.mine.useQuery(
    { academicYear: selected },
    { enabled: selected !== "", retry: false },
  );

  const savedDraft: JcrcDraft = mine.data
    ? {
        portfolio: mine.data.portfolio,
        position: mine.data.position,
        description: mine.data.description,
        contributions: mine.data.contributions,
        testimonial: mine.data.testimonial,
      }
    : EMPTY_JCRC;

  const [draft, setDraft] = useState<JcrcDraft>(EMPTY_JCRC);
  const [saved, setSaved] = useState(false);
  // Reload the form when the saved record changes (a year change or a save).
  // `mine.data` keeps its identity across identical refetches, so a refetch on
  // window focus never overwrites what is being typed.
  useEffect(() => {
    if (mine.isSuccess) setDraft(savedDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.data, mine.isSuccess, selected]);

  const save = api.transcriptManage.jcrc.saveMine.useMutation({
    onSuccess: async () => {
      setSaved(true);
      await utils.transcriptManage.jcrc.mine.invalidate();
    },
  });

  if (periods.isPending || (mine.isPending && mine.fetchStatus !== "idle")) {
    return (
      <div
        className="h-64 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }
  if (mine.error?.message === "JCRC_MEMBER_REQUIRED") {
    return (
      <SectionCard title="Your JCRC page">
        <p className="text-sm text-gray-700" role="status">
          {NOT_JCRC_NOTE}
        </p>
      </SectionCard>
    );
  }
  if (mine.error) {
    return (
      <SectionCard title="Your JCRC page">
        <ErrorLine message={errorText(mine.error.message)} />
      </SectionCard>
    );
  }

  const status =
    periods.data?.periods.find((x) => x.academicYear === selected)?.status ??
    null;
  const zod = save.error?.data?.zodError ?? null;
  const fieldErrors = {
    portfolio: fieldError(zod, "portfolio"),
    position: fieldError(zod, "position"),
    description: fieldError(zod, "description"),
    contributions: fieldError(zod, "contributions"),
    testimonial: fieldError(zod, "testimonial"),
  };
  const hasFieldError = Object.values(fieldErrors).some(Boolean);

  return (
    <JcrcSelfView
      academicYear={selected}
      years={yearOptions(periods.data?.periods ?? [], current)}
      onYear={(y) => {
        setYear(y);
        setSaved(false);
        save.reset();
      }}
      readOnly={!isWritable(status)}
      draft={draft}
      onDraft={(patch) => {
        setDraft((d) => ({ ...d, ...patch }));
        setSaved(false);
        save.reset();
      }}
      onSave={() =>
        save.mutate({
          academicYear: selected,
          ...draft,
          contributions: draft.contributions
            .map((c) => c.trim())
            .filter((c) => c !== ""),
        })
      }
      saving={save.isPending}
      saved={saved}
      dirty={!same(draft, savedDraft)}
      error={
        save.error && !hasFieldError ? errorText(save.error.message) : null
      }
      fieldErrors={fieldErrors}
      previewUrl={previewHref(userID, selected)}
    />
  );
}
