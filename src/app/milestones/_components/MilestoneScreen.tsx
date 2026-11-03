"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import type { MilestoneRef } from "~/lib/milestones/open";
import {
  MILESTONE_SCORE_MAX,
  MILESTONE_SCORE_MIN,
  MILESTONE_TEXT_MAX,
} from "~/lib/schemas/milestone";
import type { MilestoneView } from "~/server/api/services/milestones/view";
import EvidencePanel from "~/app/cca/_components/EvidencePanel";
import { describeMilestoneError, SELF_RATED_LABEL } from "../_lib/errors";
import MilestonesFlag from "./MilestonesFlag";

const SCORES = Array.from(
  { length: MILESTONE_SCORE_MAX - MILESTONE_SCORE_MIN + 1 },
  (_, i) => i + MILESTONE_SCORE_MIN,
);

/**
 * One milestone, as the signed-in person may see it. The server builds the
 * response so a rating this person may not see is not in it at all: this
 * screen only draws what it is given. A head files a self-rating and photos
 * until a director rates; a director rates once, independently, after looking
 * at the photos.
 */
export default function MilestoneScreen({
  milestoneRef,
}: {
  milestoneRef: MilestoneRef;
}) {
  return (
    <MilestonesFlag>
      <Milestone milestoneRef={milestoneRef} />
    </MilestonesFlag>
  );
}

function Milestone({ milestoneRef: ref }: { milestoneRef: MilestoneRef }) {
  const utils = api.useUtils();
  const get = api.milestone.get.useQuery({ ref }, { retry: false });
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    await utils.milestone.get.invalidate({ ref });
    await utils.milestoneEvidence.list.invalidate();
  };
  const fail = async (e: unknown) => {
    setError(describeMilestoneError(e instanceof Error ? e.message : ""));
    await reload();
  };

  if (get.isLoading)
    return (
      <p className="text-sm text-gray-500 dark:text-muted-foreground">
        Loading…
      </p>
    );
  if (get.isError || !get.data) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {describeMilestoneError(get.error?.message ?? "")}
      </p>
    );
  }
  const m = get.data;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/milestones/${m.ccaID}`}
          className="text-sm text-emerald-700 hover:underline dark:text-emerald-300"
        >
          All milestones
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-foreground">
          {m.title}
        </h1>
        <p className="text-sm text-gray-500 dark:text-muted-foreground">
          {m.state === "canceled"
            ? "This event was canceled. What was filed is kept; nothing more can be added."
            : m.locked
              ? "A director has rated this milestone. It can no longer change."
              : "Open for filing and rating."}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <Photos milestoneRef={ref} m={m} onChange={reload} onError={fail} />

      {m.viewer.head && (
        <HeadSection
          milestoneRef={ref}
          m={m}
          onChange={reload}
          onError={fail}
        />
      )}
      {!m.viewer.head && m.head && <HeadResult head={m.head} />}

      {m.viewer.director && (
        <DirectorSection
          milestoneRef={ref}
          m={m}
          onChange={reload}
          onError={fail}
        />
      )}
      {!m.viewer.director && m.assessment && (
        <AssessmentResult assessment={m.assessment} />
      )}
    </div>
  );
}

type View = MilestoneView;
type SectionProps = {
  milestoneRef: MilestoneRef;
  m: View;
  onChange: () => Promise<void>;
  onError: (e: unknown) => Promise<void>;
};

function HeadResult({ head }: { head: NonNullable<View["head"]> }) {
  return (
    <section aria-labelledby="head-result" className="space-y-1">
      <h2 id="head-result" className="text-base font-semibold">
        Head&apos;s rating
      </h2>
      <p className="text-sm text-gray-900 dark:text-foreground">
        {head.score} of 5
      </p>
      <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-foreground">
        {head.text}
      </p>
    </section>
  );
}

function AssessmentResult({
  assessment,
}: {
  assessment: NonNullable<View["assessment"]>;
}) {
  return (
    <section aria-labelledby="assessment-result" className="space-y-1">
      <h2 id="assessment-result" className="text-base font-semibold">
        Director&apos;s rating
      </h2>
      <p className="text-sm text-gray-900 dark:text-foreground">
        {assessment.score} of 5
      </p>
      <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-foreground">
        {assessment.text}
      </p>
      {assessment.selfRated && (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {SELF_RATED_LABEL}
        </p>
      )}
    </section>
  );
}

function Photos({ milestoneRef: ref, m, onChange, onError }: SectionProps) {
  const detach = api.milestone.detach.useMutation();
  const canRemove = m.viewer.head && !m.locked && m.state === "open";
  return (
    <section aria-labelledby="photos-heading" className="space-y-2">
      <h2 id="photos-heading" className="text-base font-semibold">
        Photos
      </h2>
      {m.evidence.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-muted-foreground">
          No photos attached yet.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {m.evidence.map((p) => (
            <li
              key={p.id}
              className="space-y-1 rounded-md border border-gray-200 bg-white p-2 dark:border-border dark:bg-card"
            >
              <div className="relative h-32 w-full overflow-hidden rounded bg-gray-50 dark:bg-muted">
                <Image
                  src={`/api/milestone-evidence/${p.id}`}
                  alt="Evidence photo"
                  fill
                  className="object-contain"
                  sizes="200px"
                  unoptimized
                />
              </div>
              {canRemove && m.version != null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={detach.isPending}
                  onClick={() =>
                    void detach
                      .mutateAsync({
                        ref,
                        expectedVersion: m.version!,
                        evidenceID: p.id,
                      })
                      .then(onChange, onError)
                  }
                >
                  Remove from milestone
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RatingForm({
  label,
  initial,
  busy,
  submitLabel,
  onSubmit,
}: {
  label: string;
  initial?: { score: number; text: string } | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: (score: number, text: string) => void;
}) {
  const [score, setScore] = useState<number>(initial?.score ?? 3);
  const [text, setText] = useState(initial?.text ?? "");
  const ok = text.trim().length > 0 && text.length <= MILESTONE_TEXT_MAX;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit(score, text.trim());
      }}
    >
      <label className="block text-sm text-gray-700 dark:text-foreground">
        {label} score
        <select
          value={score}
          onChange={(e) => setScore(Number(e.target.value))}
          className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-border dark:bg-card"
        >
          {SCORES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="ml-1 text-xs text-gray-500 dark:text-muted-foreground">
          (1 lowest, 5 highest)
        </span>
      </label>
      <label className="block text-sm text-gray-700 dark:text-foreground">
        Comment
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MILESTONE_TEXT_MAX}
          rows={4}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-border"
        />
        <span className="text-xs text-gray-500 dark:text-muted-foreground">
          {text.length} of {MILESTONE_TEXT_MAX}
        </span>
      </label>
      <Button type="submit" size="sm" disabled={busy || !ok}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

function HeadSection({
  milestoneRef: ref,
  m,
  onChange,
  onError,
}: SectionProps) {
  const save = api.milestone.saveRating.useMutation();
  const attach = api.milestone.attach.useMutation();
  const pool = api.milestoneEvidence.list.useQuery(
    { ccaID: m.ccaID },
    { retry: false, enabled: m.canFile || (m.state === "open" && !m.locked) },
  );
  const editable = m.state === "open" && !m.locked;

  if (!editable) {
    return m.head ? <HeadResult head={m.head} /> : null;
  }
  return (
    <div className="space-y-6">
      <section aria-labelledby="file-heading" className="space-y-3">
        <h2 id="file-heading" className="text-base font-semibold">
          Your rating
        </h2>
        <p className="text-sm text-gray-500 dark:text-muted-foreground">
          Rate how this went. You can change it until a director rates. The
          director cannot see your rating until they have given theirs.
        </p>
        <RatingForm
          key={m.version ?? "new"}
          label="Your"
          initial={m.head}
          busy={save.isPending}
          submitLabel={m.head ? "Update rating" : "Save rating"}
          onSubmit={(score, text) =>
            void save
              .mutateAsync({
                ref,
                expectedVersion: m.version ?? null,
                score,
                text,
              })
              .then(onChange, onError)
          }
        />
      </section>

      <section aria-labelledby="attach-heading" className="space-y-3">
        <h2 id="attach-heading" className="text-base font-semibold">
          Add photos
        </h2>
        <EvidencePanel ccaID={m.ccaID} />
        {(pool.data ?? []).length > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-gray-700 dark:text-foreground">
              Attach unused photos to this milestone:
            </p>
            <ul className="flex flex-wrap gap-2">
              {(pool.data ?? []).map((p) => (
                <li key={p.id}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={attach.isPending}
                    onClick={() =>
                      void attach
                        .mutateAsync({
                          ref,
                          expectedVersion: m.version ?? null,
                          evidenceIDs: [p.id],
                        })
                        .then(onChange, onError)
                    }
                  >
                    Attach photo from{" "}
                    {new Date(p.createdAt).toLocaleDateString()}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function DirectorSection({
  milestoneRef: ref,
  m,
  onChange,
  onError,
}: SectionProps) {
  const rate = api.milestone.rate.useMutation();
  if (m.assessment) return <AssessmentResult assessment={m.assessment} />;
  if (!m.canRate) {
    return (
      <section aria-labelledby="rate-heading" className="space-y-1">
        <h2 id="rate-heading" className="text-base font-semibold">
          Your rating
        </h2>
        <p className="text-sm text-gray-500 dark:text-muted-foreground">
          {m.state !== "open"
            ? "This milestone can no longer be rated."
            : m.evidence.length === 0
              ? "Waiting for the heads to attach photos. You can rate once there is at least one."
              : "This milestone cannot be rated now."}
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="rate-heading" className="space-y-3">
      <h2 id="rate-heading" className="text-base font-semibold">
        Your rating
      </h2>
      <p className="text-sm text-gray-500 dark:text-muted-foreground">
        Look at the photos, then rate. This is final: once you submit, the
        heads&apos; filing is locked and the heads can see your rating. Your
        rating is of the photos you loaded; if a head changes them first, you
        will be asked to reload.
      </p>
      <RatingForm
        label="Your"
        busy={rate.isPending}
        submitLabel="Submit rating"
        onSubmit={(score, text) =>
          m.seen !== undefined &&
          void rate
            .mutateAsync({ ref, seen: m.seen, score, text })
            .then(onChange, onError)
        }
      />
    </section>
  );
}
