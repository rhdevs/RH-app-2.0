"use client";

import { Check, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import {
  CONTRIBUTION_ACTIVITY_MAX,
  CONTRIBUTION_DESCRIPTION_MAX,
  CONTRIBUTION_ROLE_MAX,
  DESCRIPTION_MAX,
  NOT_JCRC_NOTE,
  PORTFOLIO_MAX,
  POSITION_MAX,
  SIGNATURE_PLACEHOLDER_NOTE,
  TESTIMONIAL_MAX,
  blankContribution,
  canMoveContribution,
  contributionsPayload,
  contributionsProblem,
  counterText,
  liveContributions,
  moveContribution,
  sameContributions,
  type ContributionDraft,
} from "~/lib/transcript/headView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";
import {
  Loading,
  RECORD_CARD,
  SaveButton,
  SubHeading,
  Tag,
  useReportDirty,
  type SectionProps,
} from "./ResidentBits";

interface Saved {
  portfolio: string;
  position: string;
  description: string;
  contributions: Array<{ activity: string; role: string; description: string }>;
  testimonial: string;
  removed: boolean;
}

interface Draft {
  portfolio: string;
  position: string;
  description: string;
  contributions: ContributionDraft[];
  testimonial: string;
}

const draftOf = (s: Saved | null): Draft => ({
  portfolio: s?.portfolio ?? "",
  position: s?.position ?? "",
  description: s?.description ?? "",
  contributions: (s?.contributions ?? []).map((c) => ({
    ...c,
    removed: false,
  })),
  testimonial: s?.testimonial ?? "",
});

const sameDraft = (a: Draft, b: Draft) =>
  a.portfolio.trim() === b.portfolio.trim() &&
  a.position.trim() === b.position.trim() &&
  a.description.trim() === b.description.trim() &&
  a.testimonial.trim() === b.testimonial.trim() &&
  sameContributions(a.contributions, b.contributions);

/** One resident's JCRC page: edit, remove (soft) and restore. */
function JcrcForm({
  saved,
  userID,
  academicYear,
  editable,
  onDirty,
}: {
  saved: Saved | null;
  userID: string;
  academicYear: string;
} & Pick<SectionProps, "editable" | "onDirty">) {
  const utils = api.useUtils();
  const save = api.transcriptManage.jcrc.saveFor.useMutation();
  const remove = api.transcriptManage.corrections.jcrc.remove.useMutation();
  const restore = api.transcriptManage.corrections.jcrc.restore.useMutation();

  const base = draftOf(saved);
  const baseKey = JSON.stringify(base);
  const [draft, setDraft] = useState<Draft>(base);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string | null>>({});
  const [done, setDone] = useState(false);
  useEffect(() => {
    setDraft(JSON.parse(baseKey) as Draft);
  }, [baseKey]);

  const removed = saved?.removed ?? false;
  const off = !editable || removed;
  const dirty = !sameDraft(draft, base);
  useReportDirty("jcrc", dirty, onDirty);

  const live = liveContributions(draft.contributions);
  const problem = contributionsProblem(draft.contributions);
  const patch = (p: Partial<Draft>) => {
    setDone(false);
    setError(null);
    setDraft((d) => ({ ...d, ...p }));
  };
  const patchRow = (i: number, p: Partial<ContributionDraft>) =>
    patch({
      contributions: draft.contributions.map((r, j) =>
        j === i ? { ...r, ...p } : r,
      ),
    });

  const refresh = () => utils.transcriptManage.invalidate();
  const run = async (job: () => Promise<unknown>) => {
    setError(null);
    setFields({});
    try {
      await job();
      setDone(true);
      await refresh();
    } catch (e) {
      const zod = (
        e as {
          data?: {
            zodError?: {
              fieldErrors?: Record<string, string[] | undefined>;
            } | null;
          };
        }
      ).data?.zodError;
      setFields({
        portfolio: fieldError(zod, "portfolio"),
        position: fieldError(zod, "position"),
        description: fieldError(zod, "description"),
        testimonial: fieldError(zod, "testimonial"),
      });
      setError(errorText((e as Error).message));
    }
  };

  const saveNow = () =>
    run(() =>
      save.mutateAsync({
        userID,
        academicYear,
        portfolio: draft.portfolio.trim(),
        position: draft.position.trim(),
        description: draft.description.trim(),
        contributions: contributionsPayload(draft.contributions),
        testimonial: draft.testimonial.trim(),
      }),
    );

  return (
    <div className={`${RECORD_CARD} space-y-5`}>
      <div className="flex flex-wrap items-center gap-2">
        {removed && <Tag>Removed</Tag>}
        {!saved && <Tag>No page yet</Tag>}
        <p className="text-xs text-gray-600">{SIGNATURE_PLACEHOLDER_NOTE}</p>
      </div>
      <div className="max-w-md">
        <label htmlFor="rjcrc-portfolio" className={FIELD_LABEL}>
          Portfolio
        </label>
        <Input
          id="rjcrc-portfolio"
          value={draft.portfolio}
          maxLength={PORTFOLIO_MAX}
          disabled={off}
          onChange={(e) => patch({ portfolio: e.target.value })}
        />
        <ErrorLine message={fields.portfolio} />
      </div>
      <div className="max-w-md">
        <label htmlFor="rjcrc-position" className={FIELD_LABEL}>
          Position
        </label>
        <Input
          id="rjcrc-position"
          value={draft.position}
          maxLength={POSITION_MAX}
          disabled={off}
          onChange={(e) => patch({ position: e.target.value })}
        />
        <ErrorLine message={fields.position} />
      </div>
      <div className="max-w-2xl">
        <label htmlFor="rjcrc-description" className={FIELD_LABEL}>
          What this role covers
        </label>
        <Textarea
          id="rjcrc-description"
          rows={3}
          value={draft.description}
          maxLength={DESCRIPTION_MAX}
          disabled={off}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(draft.description, DESCRIPTION_MAX)}
        </p>
        <ErrorLine message={fields.description} />
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
                  disabled={off}
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
                  <label htmlFor={`rjcrc-act-${i}`} className={FIELD_LABEL}>
                    Activity
                  </label>
                  <Input
                    id={`rjcrc-act-${i}`}
                    value={c.activity}
                    maxLength={CONTRIBUTION_ACTIVITY_MAX}
                    disabled={off}
                    onChange={(e) => patchRow(i, { activity: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor={`rjcrc-role-${i}`} className={FIELD_LABEL}>
                    Role
                  </label>
                  <Input
                    id={`rjcrc-role-${i}`}
                    value={c.role}
                    maxLength={CONTRIBUTION_ROLE_MAX}
                    disabled={off}
                    onChange={(e) => patchRow(i, { role: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor={`rjcrc-desc-${i}`} className={FIELD_LABEL}>
                    Description
                  </label>
                  <Textarea
                    id={`rjcrc-desc-${i}`}
                    rows={2}
                    value={c.description}
                    maxLength={CONTRIBUTION_DESCRIPTION_MAX}
                    disabled={off}
                    onChange={(e) =>
                      patchRow(i, { description: e.target.value })
                    }
                  />
                </div>
                {!off && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        !canMoveContribution(draft.contributions, i, -1)
                      }
                      onClick={() =>
                        patch({
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
                      disabled={!canMoveContribution(draft.contributions, i, 1)}
                      onClick={() =>
                        patch({
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
        {!off && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() =>
              patch({
                contributions: [...draft.contributions, blankContribution()],
              })
            }
          >
            <Plus className="mr-1 h-4 w-4" />
            Add a contribution
          </Button>
        )}
        <p className="mt-2 text-xs text-gray-500">
          {live.length} {live.length === 1 ? "contribution" : "contributions"}.
        </p>
      </fieldset>

      <div className="max-w-2xl">
        <label htmlFor="rjcrc-testimonial" className={FIELD_LABEL}>
          Testimonial
        </label>
        <Textarea
          id="rjcrc-testimonial"
          rows={4}
          value={draft.testimonial}
          maxLength={TESTIMONIAL_MAX}
          disabled={off}
          onChange={(e) => patch({ testimonial: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(draft.testimonial, TESTIMONIAL_MAX)}
        </p>
        <ErrorLine message={fields.testimonial} />
      </div>

      <ErrorLine message={problem ?? error} />
      <div className="flex flex-wrap items-center gap-3">
        {!off && (
          <SaveButton
            pending={save.isPending}
            disabled={!dirty || problem !== null}
            onClick={() => void saveNow()}
          />
        )}
        {editable && saved && !removed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() =>
              void run(() => remove.mutateAsync({ userID, academicYear }))
            }
          >
            Remove page
          </Button>
        )}
        {editable && removed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={restore.isPending}
            onClick={() =>
              void run(() => restore.mutateAsync({ userID, academicYear }))
            }
          >
            Restore page
          </Button>
        )}
        {done && !dirty && (
          <span
            className="inline-flex items-center gap-1 text-xs text-emerald-700"
            role="status"
          >
            <Check className="h-3 w-3" />
            Done
          </span>
        )}
      </div>
    </div>
  );
}

/** The resident's JCRC page for the year. */
export default function JcrcTab(p: SectionProps & { isJcrcMember: boolean }) {
  const page = api.transcriptManage.corrections.jcrc.get.useQuery(
    { userID: p.userID, academicYear: p.academicYear },
    { retry: false },
  );
  if (page.isPending) return <Loading />;
  if (page.error) return <ErrorLine message={errorText(page.error.message)} />;
  if (!page.data && !p.isJcrcMember) {
    return <p className="text-sm text-gray-600">{NOT_JCRC_NOTE}</p>;
  }
  return (
    <section aria-labelledby="jcrc-heading">
      <SubHeading id="jcrc-heading">JCRC page for {p.academicYear}</SubHeading>
      <JcrcForm
        key={`${p.userID}:${p.academicYear}`}
        saved={page.data}
        userID={p.userID}
        academicYear={p.academicYear}
        editable={p.editable}
        onDirty={p.onDirty}
      />
    </section>
  );
}
