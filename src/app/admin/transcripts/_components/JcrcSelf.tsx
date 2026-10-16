"use client";

import { Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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
  CONTRIBUTION_ACTIVITY_MAX,
  CONTRIBUTION_DESCRIPTION_MAX,
  CONTRIBUTION_ROLE_MAX,
  DESCRIPTION_MAX,
  NOT_JCRC_NOTE,
  PORTFOLIO_MAX,
  POSITION_MAX,
  PUBLISHED_NOTE,
  SIGNATURE_PLACEHOLDER_NOTE,
  TESTIMONIAL_MAX,
  blankContribution,
  canMoveContribution,
  contributionsPayload,
  contributionsProblem,
  counterText,
  liveContributions,
  moveContribution,
  reconcileAfterSave,
  sameContributions,
  type ContributionDraft,
} from "~/lib/transcript/headView";
import { useUnsavedChangesGuard } from "~/lib/transcript/useUnsavedChangesGuard";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL, SectionCard, YearSelect } from "./Bits";
import { previewHref } from "./PreviewPicker";

export interface JcrcDraft {
  portfolio: string;
  position: string;
  description: string;
  contributions: ContributionDraft[];
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
  const live = liveContributions(draft.contributions);
  const canAddContribution = !p.readOnly;
  const patchRow = (index: number, patch: Partial<ContributionDraft>) =>
    p.onDraft({
      contributions: draft.contributions.map((r, j) =>
        j === index ? { ...r, ...patch } : r,
      ),
    });

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
          <ul className="space-y-3">
            {draft.contributions.map((c, i) =>
              c.removed ? (
                <li
                  key={i}
                  className="flex items-center justify-between gap-3 rounded-md border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600"
                >
                  <span>
                    Removed.{" "}
                    {c.activity.trim() !== ""
                      ? c.activity.trim()
                      : `Contribution ${i + 1}`}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={p.readOnly}
                    onClick={() => patchRow(i, { removed: false })}
                  >
                    Undo
                  </Button>
                </li>
              ) : (
                <li
                  key={i}
                  className="space-y-3 rounded-md border border-gray-200 p-3"
                >
                  <div>
                    <label
                      htmlFor={`jcrc-activity-${i}`}
                      className={FIELD_LABEL}
                    >
                      Activity
                    </label>
                    <Input
                      id={`jcrc-activity-${i}`}
                      value={c.activity}
                      maxLength={CONTRIBUTION_ACTIVITY_MAX}
                      disabled={p.readOnly}
                      onChange={(e) =>
                        patchRow(i, { activity: e.target.value })
                      }
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {counterText(c.activity, CONTRIBUTION_ACTIVITY_MAX)}
                    </p>
                  </div>
                  <div>
                    <label htmlFor={`jcrc-role-${i}`} className={FIELD_LABEL}>
                      Role (optional)
                    </label>
                    <Input
                      id={`jcrc-role-${i}`}
                      value={c.role}
                      maxLength={CONTRIBUTION_ROLE_MAX}
                      disabled={p.readOnly}
                      onChange={(e) => patchRow(i, { role: e.target.value })}
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {counterText(c.role, CONTRIBUTION_ROLE_MAX)}
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor={`jcrc-contribution-description-${i}`}
                      className={FIELD_LABEL}
                    >
                      Description (optional)
                    </label>
                    <Textarea
                      id={`jcrc-contribution-description-${i}`}
                      rows={2}
                      value={c.description}
                      maxLength={CONTRIBUTION_DESCRIPTION_MAX}
                      disabled={p.readOnly}
                      onChange={(e) =>
                        patchRow(i, { description: e.target.value })
                      }
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {counterText(c.description, CONTRIBUTION_DESCRIPTION_MAX)}
                    </p>
                  </div>
                  {!p.readOnly && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          !canMoveContribution(draft.contributions, i, -1)
                        }
                        onClick={() =>
                          p.onDraft({
                            contributions: moveContribution(
                              draft.contributions,
                              i,
                              -1,
                            ),
                          })
                        }
                      >
                        Move up
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          !canMoveContribution(draft.contributions, i, 1)
                        }
                        onClick={() =>
                          p.onDraft({
                            contributions: moveContribution(
                              draft.contributions,
                              i,
                              1,
                            ),
                          })
                        }
                      >
                        Move down
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => patchRow(i, { removed: true })}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
          <div className="mt-2 flex items-center gap-3">
            {!p.readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canAddContribution}
                onClick={() =>
                  p.onDraft({
                    contributions: [
                      ...draft.contributions,
                      blankContribution(),
                    ],
                  })
                }
              >
                <Plus className="mr-1 h-4 w-4" />
                Add contribution
              </Button>
            )}
            <span className="text-xs text-gray-500">
              {`${live.length} ${live.length === 1 ? "contribution" : "contributions"}`}
            </span>
          </div>
          <ErrorLine
            message={
              contributionsProblem(draft.contributions) ??
              p.fieldErrors.contributions
            }
          />
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
  sameContributions(a.contributions, b.contributions);

/** Rows from the API, as editor rows. */
const toDrafts = (
  rows: ReadonlyArray<{ activity: string; role: string; description: string }>,
): ContributionDraft[] => rows.map((r) => ({ ...r, removed: false }));

export default function JcrcSelf({
  userID,
  isMember,
}: {
  userID: string;
  /** Holds the live jcrc role; an admin alone is not a JCRC member. */
  isMember: boolean;
}) {
  const utils = api.useUtils();
  const periods = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const [year, setYear] = useState<string | null>(null);
  const current = periods.data?.currentAcademicYear ?? "";
  const selected = year ?? current;

  const mine = api.transcriptManage.jcrc.mine.useQuery(
    { academicYear: selected },
    { enabled: isMember && selected !== "", retry: false },
  );

  const savedDraft: JcrcDraft = mine.data
    ? {
        portfolio: mine.data.portfolio,
        position: mine.data.position,
        description: mine.data.description,
        contributions: toDrafts(mine.data.contributions),
        testimonial: mine.data.testimonial,
      }
    : EMPTY_JCRC;

  const [draft, setDraft] = useState<JcrcDraft>(EMPTY_JCRC);
  const [saved, setSaved] = useState(false);
  const dirty = !same(draft, savedDraft);
  const confirmLeave = useUnsavedChangesGuard(dirty);
  // Reload the form when the saved record changes (a year change, or a save
  // from elsewhere). Unsaved typing is never overwritten: the form is replaced
  // only if it still matched what was loaded before, or the year changed.
  const loaded = useRef<{ year: string; draft: JcrcDraft }>({
    year: "",
    draft: EMPTY_JCRC,
  });
  useEffect(() => {
    if (!mine.isSuccess) return;
    const previous = loaded.current;
    setDraft((d) =>
      previous.year !== selected || same(d, previous.draft) ? savedDraft : d,
    );
    loaded.current = { year: selected, draft: savedDraft };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.data, mine.isSuccess, selected]);

  const submitted = useRef<JcrcDraft>(EMPTY_JCRC);
  const save = api.transcriptManage.jcrc.saveMine.useMutation({
    onSuccess: async (stored) => {
      // Keep showing what was saved, as the server stored it.
      const fromServer: JcrcDraft = stored
        ? {
            portfolio: stored.portfolio,
            position: stored.position,
            description: stored.description,
            contributions: toDrafts(stored.contributions),
            testimonial: stored.testimonial,
          }
        : submitted.current;
      setDraft((current) =>
        reconcileAfterSave(current, submitted.current, fromServer, same),
      );
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
  if (!isMember || mine.error?.message === "JCRC_MEMBER_REQUIRED") {
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
        if (y !== selected && !confirmLeave()) return;
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
      onSave={() => {
        submitted.current = draft;
        save.mutate({
          academicYear: selected,
          ...draft,
          contributions: contributionsPayload(draft.contributions),
        });
      }}
      saving={save.isPending}
      saved={saved}
      dirty={dirty}
      error={
        save.error && !hasFieldError ? errorText(save.error.message) : null
      }
      fieldErrors={fieldErrors}
      previewUrl={previewHref(userID, selected)}
    />
  );
}
