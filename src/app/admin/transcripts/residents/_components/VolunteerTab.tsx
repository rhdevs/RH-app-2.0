"use client";

import { Check } from "lucide-react";
import { useState } from "react";

import { Input } from "~/components/ui/input";
import { errorText } from "~/lib/transcript/adminView";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { formatVolunteerHours, KIND_LABEL } from "~/lib/transcript/volunteer";
import {
  cellChanges,
  draftOfCell,
  draftTotal,
  type CellDraft,
  type SavedCell,
} from "~/lib/transcript/residentView";
import { api } from "~/trpc/react";
import { ErrorLine } from "../../_components/Bits";
import {
  Loading,
  RECORD_CARD,
  SaveButton,
  SubHeading,
  Tag,
  useReportDirty,
  type SectionProps,
} from "./ResidentBits";

interface Item {
  activityID: string;
  ccaID: number;
  ccaName: string;
  title: string;
  kind: "regular" | "oneoff";
  totalHours: number;
  sessions: Array<{
    sessionID: string;
    date: string;
    hours: number;
    ticked: boolean;
    hoursOverride: number | null;
  }>;
}

/** One volunteer activity: a tick and an optional hours override per session. */
function ActivityCard({
  item,
  userID,
  editable,
  onDirty,
  onSaved,
}: {
  item: Item;
  userID: string;
  editable: boolean;
  onDirty: SectionProps["onDirty"];
  onSaved: () => Promise<void>;
}) {
  const save = api.transcriptManage.volunteer.attendance.save.useMutation();
  const saved: SavedCell[] = item.sessions;
  const [draft, setDraft] = useState<Record<string, CellDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cellOf = (c: SavedCell) => draft[c.sessionID] ?? draftOfCell(c);
  const planned = cellChanges(saved, draft, userID);
  const dirty = planned.changes.length > 0 || planned.error !== null;
  useReportDirty(`volunteer:${item.activityID}`, dirty, onDirty);

  const edit = (c: SavedCell, patch: Partial<CellDraft>) => {
    setDone(false);
    setError(null);
    setDraft((d) => ({ ...d, [c.sessionID]: { ...cellOf(c), ...patch } }));
  };

  const run = async () => {
    if (planned.error) {
      setError(planned.error);
      return;
    }
    setError(null);
    try {
      await save.mutateAsync({
        activityID: item.activityID,
        ccaID: item.ccaID,
        changes: planned.changes,
      });
      setDraft({});
      setDone(true);
      await onSaved();
    } catch (e) {
      setError(errorText((e as Error).message));
    }
  };

  return (
    <li className={`${RECORD_CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-900">{item.title}</h4>
        <span className="text-xs text-gray-500">{item.ccaName}</span>
        <Tag>{KIND_LABEL[item.kind]}</Tag>
        <span className="ml-auto text-sm text-gray-700" role="status">
          {formatVolunteerHours(draftTotal(saved, draft))} hours
        </span>
      </div>
      {item.sessions.length === 0 ? (
        <p className="text-sm text-gray-500">This activity has no sessions.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {item.sessions.map((c) => {
            const d = cellOf(c);
            const id = `${item.activityID}-${c.sessionID}`;
            return (
              <li
                key={c.sessionID}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2"
              >
                <label
                  htmlFor={`tick-${id}`}
                  className="inline-flex min-w-[11rem] items-center gap-2 text-sm text-gray-900"
                >
                  <input
                    id={`tick-${id}`}
                    type="checkbox"
                    checked={d.ticked}
                    disabled={!editable}
                    onChange={(e) =>
                      edit(c, {
                        ticked: e.target.checked,
                        override: e.target.checked ? d.override : "",
                      })
                    }
                  />
                  {formatSgDate(c.date)}
                </label>
                <span className="text-xs text-gray-500">
                  {formatVolunteerHours(c.hours)} h session
                </span>
                {d.ticked && (
                  <span className="inline-flex items-center gap-2">
                    <label
                      htmlFor={`hrs-${id}`}
                      className="text-xs text-gray-700"
                    >
                      Hours override
                    </label>
                    <Input
                      id={`hrs-${id}`}
                      inputMode="decimal"
                      className="h-8 w-24"
                      value={d.override}
                      disabled={!editable}
                      placeholder={formatVolunteerHours(c.hours)}
                      onChange={(e) => edit(c, { override: e.target.value })}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ErrorLine message={error} />
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <SaveButton
            pending={save.isPending}
            disabled={!dirty}
            onClick={() => void run()}
          />
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
      )}
    </li>
  );
}

/**
 * Volunteer hours of one resident. They tick sessions and set an hours
 * override for themselves only; adding or removing a person from an activity is
 * done in the CCA's own volunteering screen.
 */
export default function VolunteerTab(p: SectionProps) {
  const utils = api.useUtils();
  const list = api.transcriptManage.corrections.volunteer.useQuery(
    { userID: p.userID, academicYear: p.academicYear },
    { retry: false },
  );
  if (list.isPending) return <Loading rows={2} />;
  if (list.error) return <ErrorLine message={errorText(list.error.message)} />;

  return (
    <section aria-labelledby="vol-heading">
      <SubHeading id="vol-heading">Volunteer hours</SubHeading>
      {list.data.length === 0 ? (
        <p className="text-sm text-gray-500">
          This resident has no volunteer activities in {p.academicYear}.
        </p>
      ) : (
        <ul className="space-y-3">
          {list.data.map((item) => (
            <ActivityCard
              key={`${p.academicYear}:${item.activityID}`}
              item={item}
              userID={p.userID}
              editable={p.editable}
              onDirty={p.onDirty}
              onSaved={() => utils.transcriptManage.invalidate()}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
