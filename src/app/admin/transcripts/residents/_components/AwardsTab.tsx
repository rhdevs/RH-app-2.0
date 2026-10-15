"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { errorText } from "~/lib/transcript/adminView";
import { AWARD_CITATION_MAX, AWARD_NAME_MAX } from "~/lib/transcript/awards";
import { counterText } from "~/lib/transcript/headView";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";
import {
  FIELD_GRID,
  Loading,
  RECORD_CARD,
  SELECT_CLASS,
  SaveButton,
  SubHeading,
  Tag,
  useReportDirty,
  type SectionProps,
} from "./ResidentBits";

interface Award {
  id: string;
  title: string;
  citation: string;
  removed: boolean;
  recordedByName: string | null;
  recordedAt: Date | string | null;
  updatedByName: string | null;
  removedByName: string | null;
  removedAt: Date | string | null;
}

/** One award: its name and citation, with Remove or Restore. */
function AwardCard({
  award,
  editable,
  onDirty,
  onSave,
  onFlip,
}: {
  award: Award;
  editable: boolean;
  onDirty: SectionProps["onDirty"];
  onSave: (title: string, citation: string) => Promise<void>;
  onFlip: () => Promise<void>;
}) {
  const [title, setTitle] = useState(award.title);
  const [citation, setCitation] = useState(award.citation);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTitle(award.title);
    setCitation(award.citation);
  }, [award.title, award.citation]);

  const dirty =
    title.trim() !== award.title.trim() ||
    citation.trim() !== award.citation.trim();
  useReportDirty(`award:${award.id}`, dirty, onDirty);
  const off = !editable || award.removed;

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      setDone(true);
    } catch (e) {
      setError(errorText((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`${RECORD_CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-900">{award.title}</h4>
        {award.removed && <Tag>Removed</Tag>}
        <span className="text-xs text-gray-500">
          {award.recordedAt
            ? `Recorded ${formatSgDate(award.recordedAt)}${award.recordedByName ? ` by ${award.recordedByName}` : ""}`
            : null}
          {award.removed && award.removedAt
            ? `. Removed ${formatSgDate(award.removedAt)}${award.removedByName ? ` by ${award.removedByName}` : ""}`
            : null}
        </span>
      </div>
      <div className={FIELD_GRID}>
        <div>
          <label htmlFor={`atitle-${award.id}`} className={FIELD_LABEL}>
            Award
          </label>
          <Input
            id={`atitle-${award.id}`}
            value={title}
            maxLength={AWARD_NAME_MAX}
            disabled={off}
            onChange={(e) => {
              setDone(false);
              setTitle(e.target.value);
            }}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`acite-${award.id}`} className={FIELD_LABEL}>
          Citation
        </label>
        <Textarea
          id={`acite-${award.id}`}
          rows={2}
          value={citation}
          maxLength={AWARD_CITATION_MAX}
          disabled={off}
          onChange={(e) => {
            setDone(false);
            setCitation(e.target.value);
          }}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(citation, AWARD_CITATION_MAX)}
        </p>
      </div>
      <ErrorLine message={error} />
      <div className="flex flex-wrap items-center gap-3">
        {!off && (
          <SaveButton
            pending={busy}
            disabled={!dirty || title.trim() === ""}
            onClick={() =>
              void run(() => onSave(title.trim(), citation.trim()))
            }
          />
        )}
        {editable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(onFlip)}
          >
            {award.removed ? "Restore" : "Remove"}
          </Button>
        )}
        {done && !dirty && (
          <span
            className="inline-flex items-center gap-1 text-xs text-emerald-700"
            role="status"
          >
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
      </div>
    </li>
  );
}

/** A resident's awards for the year: edit, remove, restore, assign from the catalogue. */
export default function AwardsTab(p: SectionProps) {
  const utils = api.useUtils();
  const [showRemoved, setShowRemoved] = useState(false);
  const scope = { userID: p.userID, academicYear: p.academicYear };
  const list = api.transcriptManage.corrections.awards.useQuery(
    { ...scope, includeRemoved: showRemoved },
    { retry: false },
  );
  const types = api.transcriptManage.awardTypes.list.useQuery(
    {},
    { retry: false, enabled: p.editable },
  );
  const update = api.transcriptManage.awards.update.useMutation();
  const remove = api.transcriptManage.awards.remove.useMutation();
  const restore = api.transcriptManage.awards.restore.useMutation();
  const assign = api.transcriptManage.awards.assign.useMutation();

  const [typeID, setTypeID] = useState("");
  const [citation, setCitation] = useState("");
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignNote, setAssignNote] = useState<string | null>(null);
  useReportDirty(
    "award:assign",
    typeID !== "" || citation.trim() !== "",
    p.onDirty,
  );

  const refresh = () => utils.transcriptManage.invalidate();

  if (list.isPending) return <Loading rows={2} />;
  if (list.error) return <ErrorLine message={errorText(list.error.message)} />;

  const doAssign = async () => {
    setAssignError(null);
    setAssignNote(null);
    try {
      const result = await assign.mutateAsync({
        academicYear: p.academicYear,
        awardTypeID: typeID,
        recipients: [
          { userID: p.userID, citation: citation.trim() || undefined },
        ],
      });
      setAssignNote(
        result.assigned > 0
          ? "Award assigned."
          : "This resident already has that award for the year, so nothing was added.",
      );
      setTypeID("");
      setCitation("");
      await refresh();
    } catch (e) {
      setAssignError(errorText((e as Error).message));
    }
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="awards-heading">
        <SubHeading id="awards-heading">Awards for {p.academicYear}</SubHeading>
        <label className="mb-3 inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
          />
          Show removed
        </label>
        {list.data.length === 0 ? (
          <p className="text-sm text-gray-500">No awards for this resident.</p>
        ) : (
          <ul className="space-y-3">
            {list.data.map((a) => (
              <AwardCard
                key={a.id}
                award={a}
                editable={p.editable}
                onDirty={p.onDirty}
                onSave={async (title, cite) => {
                  await update.mutateAsync({
                    id: a.id,
                    title,
                    citation: cite === "" ? null : cite,
                  });
                  await refresh();
                }}
                onFlip={async () => {
                  await (a.removed ? restore : remove).mutateAsync({
                    id: a.id,
                  });
                  await refresh();
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {p.editable && (
        <section
          aria-labelledby="assign-heading"
          className="space-y-3 rounded-lg border border-dashed border-gray-300 p-4"
        >
          <SubHeading id="assign-heading">Assign from the catalogue</SubHeading>
          <div className="max-w-md">
            <label htmlFor="assign-type" className={FIELD_LABEL}>
              Award
            </label>
            <select
              id="assign-type"
              value={typeID}
              onChange={(e) => setTypeID(e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">Choose an award</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {typeID !== "" && (
            <>
              <div>
                <label htmlFor="assign-citation" className={FIELD_LABEL}>
                  Citation (blank uses the award&rsquo;s default)
                </label>
                <Textarea
                  id="assign-citation"
                  rows={2}
                  value={citation}
                  maxLength={AWARD_CITATION_MAX}
                  onChange={(e) => setCitation(e.target.value)}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {counterText(citation, AWARD_CITATION_MAX)}
                </p>
              </div>
              <SaveButton
                pending={assign.isPending}
                label="Assign"
                onClick={() => void doAssign()}
              />
            </>
          )}
          <ErrorLine message={assignError} />
          {assignNote && (
            <p className="text-sm text-gray-700" role="status">
              {assignNote}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
