"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  PARTICIPANT_DESCRIPTION_MAX,
  PARTICIPANT_ROLE_MAX,
} from "~/lib/transcript/activities";
import { errorText } from "~/lib/transcript/adminView";
import { counterText } from "~/lib/transcript/headView";
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

interface Item {
  activityID: string;
  ccaName: string;
  title: string;
  role: string;
  description: string;
  removed: boolean;
  activityRemoved: boolean;
  isMember: boolean;
  addedByName: string | null;
  updatedByName: string | null;
}

/** "Added by A, edited by B": who added the participation, and who changed it. */
function authorLine(item: Item): string | null {
  const edited =
    item.updatedByName && item.updatedByName !== item.addedByName
      ? item.updatedByName
      : null;
  if (!item.addedByName) return edited ? `Edited by ${edited}` : null;
  return `Added by ${item.addedByName}${edited ? `, edited by ${edited}` : ""}`;
}

/** One participation: role and description, saved on their own. */
export function ParticipationCard({
  item,
  idKey,
  editable,
  onDirty,
  onSave,
  onRemove,
}: {
  item: Item;
  idKey: string;
  editable: boolean;
  onDirty: SectionProps["onDirty"];
  onSave: (role: string, description: string) => Promise<void>;
  /** Null for a card with nothing to remove. */
  onRemove: (() => Promise<void>) | null;
}) {
  const [role, setRole] = useState(item.role);
  const [description, setDescription] = useState(item.description);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRole(item.role);
    setDescription(item.description);
  }, [item.role, item.description]);

  const dirty =
    role.trim() !== item.role.trim() ||
    description.trim() !== item.description.trim();
  useReportDirty(`activity:${idKey}`, dirty, onDirty);
  const off = !editable || item.removed || item.activityRemoved;

  const run = async (job: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await job();
      setSaved(true);
    } catch (e) {
      setError(errorText((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className={`${RECORD_CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-900">{item.title}</h4>
        <span className="text-xs text-gray-500">{item.ccaName}</span>
        <Tag tone={item.isMember ? "emerald" : "gray"}>
          {item.isMember ? "Member of this CCA" : "Other involvement"}
        </Tag>
        {item.removed && <Tag>Removed</Tag>}
        {item.activityRemoved && <Tag>Activity removed</Tag>}
      </div>
      {authorLine(item) && (
        <p className="text-xs text-gray-500">{authorLine(item)}</p>
      )}
      <div className={FIELD_GRID}>
        <div>
          <label htmlFor={`prole-${idKey}`} className={FIELD_LABEL}>
            Role
          </label>
          <Input
            id={`prole-${idKey}`}
            value={role}
            maxLength={PARTICIPANT_ROLE_MAX}
            disabled={off}
            placeholder="Leave blank for no role"
            onChange={(e) => {
              setSaved(false);
              setRole(e.target.value);
            }}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`pdesc-${idKey}`} className={FIELD_LABEL}>
          Description (blank uses the activity&rsquo;s general description)
        </label>
        <Textarea
          id={`pdesc-${idKey}`}
          rows={3}
          value={description}
          maxLength={PARTICIPANT_DESCRIPTION_MAX}
          disabled={off}
          onChange={(e) => {
            setSaved(false);
            setDescription(e.target.value);
          }}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(description, PARTICIPANT_DESCRIPTION_MAX)}
        </p>
      </div>
      <ErrorLine message={error} />
      <div className="flex flex-wrap items-center gap-3">
        {!off && (
          <SaveButton
            pending={saving}
            disabled={!dirty}
            onClick={() =>
              void run(() => onSave(role.trim(), description.trim()))
            }
          />
        )}
        {editable && !item.activityRemoved && onRemove && !item.removed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void run(onRemove)}
          >
            Remove
          </Button>
        )}
        {editable && !item.activityRemoved && item.removed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() =>
              void run(() => onSave(item.role.trim(), item.description.trim()))
            }
          >
            Restore
          </Button>
        )}
        {saved && !dirty && (
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

/** The CCA activities a resident took part in, of any CCA. */
export default function ActivitiesTab(p: SectionProps) {
  const utils = api.useUtils();
  const scope = { userID: p.userID, academicYear: p.academicYear };
  const list = api.transcriptManage.corrections.participation.list.useQuery(
    scope,
    { retry: false },
  );
  const options =
    api.transcriptManage.corrections.participation.options.useQuery(
      { academicYear: p.academicYear },
      { retry: false, enabled: p.editable },
    );
  const set = api.transcriptManage.corrections.participation.set.useMutation();
  const remove =
    api.transcriptManage.corrections.participation.remove.useMutation();

  const [pick, setPick] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useReportDirty(
    "activity:add",
    pick !== "" || role.trim() !== "" || description.trim() !== "",
    p.onDirty,
  );

  const refresh = () => utils.transcriptManage.invalidate();

  if (list.isPending) return <Loading rows={2} />;
  if (list.error) return <ErrorLine message={errorText(list.error.message)} />;

  const have = new Set(
    list.data.filter((i) => !i.removed).map((i) => i.activityID),
  );
  const choices = (options.data ?? []).filter((o) => !have.has(o.id));

  const add = async () => {
    setAdding(true);
    setAddError(null);
    try {
      await set.mutateAsync({
        ...scope,
        activityID: pick,
        role: role.trim(),
        description: description.trim(),
      });
      setPick("");
      setRole("");
      setDescription("");
      await refresh();
    } catch (e) {
      setAddError(errorText((e as Error).message));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="part-heading">
        <SubHeading id="part-heading">Activities they take part in</SubHeading>
        {list.data.length === 0 ? (
          <p className="text-sm text-gray-500">
            This resident is on no activity in {p.academicYear}.
          </p>
        ) : (
          <ul className="space-y-3">
            {list.data.map((item) => (
              <ParticipationCard
                key={`${p.academicYear}:${item.activityID}`}
                item={item}
                idKey={item.activityID}
                editable={p.editable}
                onDirty={p.onDirty}
                onSave={async (r, d) => {
                  await set.mutateAsync({
                    ...scope,
                    activityID: item.activityID,
                    role: r,
                    description: d,
                  });
                  await refresh();
                }}
                onRemove={async () => {
                  await remove.mutateAsync({
                    ...scope,
                    activityID: item.activityID,
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
          aria-labelledby="add-part-heading"
          className="space-y-3 rounded-lg border border-dashed border-gray-300 p-4"
        >
          <SubHeading id="add-part-heading">
            Add to an existing activity
          </SubHeading>
          <div className="max-w-md">
            <label htmlFor="add-activity" className={FIELD_LABEL}>
              Activity (any CCA)
            </label>
            <select
              id="add-activity"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">Choose an activity</option>
              {choices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.ccaName}: {o.title}
                </option>
              ))}
            </select>
          </div>
          {pick !== "" && (
            <>
              <div className="max-w-md">
                <label htmlFor="add-role" className={FIELD_LABEL}>
                  Role
                </label>
                <Input
                  id="add-role"
                  value={role}
                  maxLength={PARTICIPANT_ROLE_MAX}
                  placeholder="Leave blank for no role"
                  onChange={(e) => setRole(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="add-desc" className={FIELD_LABEL}>
                  Description
                </label>
                <Textarea
                  id="add-desc"
                  rows={3}
                  value={description}
                  maxLength={PARTICIPANT_DESCRIPTION_MAX}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {counterText(description, PARTICIPANT_DESCRIPTION_MAX)}
                </p>
              </div>
              <ErrorLine message={addError} />
              <SaveButton
                pending={adding}
                label="Add to activity"
                onClick={() => void add()}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}
