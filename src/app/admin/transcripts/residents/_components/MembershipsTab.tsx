"use client";

import { useState } from "react";

import { Button } from "~/components/ui/button";
import { errorText } from "~/lib/transcript/adminView";
import {
  ADMIN_ONLY_NOTE,
  MANUAL_SHADOWED_NOTE,
  MANUAL_TAG,
} from "~/lib/transcript/residentView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";
import { MembershipForm } from "./MembershipForm";
import {
  Loading,
  SELECT_CLASS,
  SubHeading,
  Tag,
  type SectionProps,
} from "./ResidentBits";

/**
 * A resident's CCA memberships for the year: the roster entries (changed with
 * the same roster.upsert the heads use) and the manual entries a manager adds
 * for a resident the membership data misses.
 */
export default function MembershipsTab(p: SectionProps) {
  const utils = api.useUtils();
  const [showRemoved, setShowRemoved] = useState(false);
  const [addKey, setAddKey] = useState(0);
  const [newCca, setNewCca] = useState<number | "">("");
  const [actionError, setActionError] = useState<string | null>(null);

  const scope = { userID: p.userID, academicYear: p.academicYear };
  const list = api.transcriptManage.corrections.memberships.list.useQuery(
    { ...scope, includeRemoved: showRemoved },
    { retry: false },
  );
  const ccas = api.transcriptManage.ccaTags.list.useQuery(undefined, {
    retry: false,
  });
  const upsert = api.transcriptManage.roster.upsert.useMutation();
  const saveManual =
    api.transcriptManage.corrections.memberships.saveManual.useMutation();
  const removeManual =
    api.transcriptManage.corrections.memberships.removeManual.useMutation();
  const restoreManual =
    api.transcriptManage.corrections.memberships.restoreManual.useMutation();

  const refresh = () => utils.transcriptManage.invalidate();

  if (list.isPending) return <Loading rows={2} />;
  if (list.error) return <ErrorLine message={errorText(list.error.message)} />;

  const taken = new Set(list.data.manual.map((m) => m.ccaID));
  const options = (ccas.data ?? []).filter((c) => !taken.has(c.ccaID));
  const flip = async (ccaID: number, remove: boolean) => {
    setActionError(null);
    try {
      await (remove ? removeManual : restoreManual).mutateAsync({
        ...scope,
        ccaID,
      });
      await refresh();
    } catch (e) {
      setActionError(errorText((e as Error).message));
    }
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="roster-heading">
        <SubHeading id="roster-heading">From the membership data</SubHeading>
        {list.data.roster.length === 0 ? (
          <p className="text-sm text-gray-500">
            No CCA memberships were recorded for this resident in{" "}
            {p.academicYear}.
          </p>
        ) : (
          <ul className="space-y-3">
            {list.data.roster.map((m) => (
              <MembershipForm
                key={`${p.academicYear}:${m.ccaID}`}
                idKey={`roster-${m.ccaID}`}
                title={m.ccaName}
                tags={
                  <>
                    <Tag>
                      {m.mode === "frozen" ? "Frozen list" : "Current list"}
                    </Tag>
                    {m.row.isHead && <Tag tone="emerald">Head</Tag>}
                  </>
                }
                saved={m.row}
                defaultRoleLabel={m.row.defaultRoleLabel}
                canReset={m.row.defaultDuration !== null}
                editable={p.editable}
                onDirty={p.onDirty}
                save={async (fields) => {
                  await upsert.mutateAsync({
                    ccaID: m.ccaID,
                    academicYear: p.academicYear,
                    userID: p.userID,
                    ...fields,
                  });
                  await refresh();
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="manual-heading">
        <SubHeading id="manual-heading">Manual entries</SubHeading>
        <p className="mb-3 max-w-3xl text-xs text-gray-500">
          For a resident the membership data misses. A manual entry counts as
          membership of that CCA on the transcript. {ADMIN_ONLY_NOTE}
        </p>
        <label className="mb-3 inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
          />
          Show removed
        </label>
        {list.data.manual.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500">No manual entries.</p>
        ) : (
          <ul className="mb-4 space-y-3">
            {list.data.manual.map((m) => (
              <MembershipForm
                key={`${p.academicYear}:manual:${m.ccaID}`}
                idKey={`manual-${m.ccaID}`}
                title={m.ccaName}
                tags={
                  <>
                    <Tag tone="amber">{MANUAL_TAG}</Tag>
                    {m.removed && <Tag>Removed</Tag>}
                  </>
                }
                note={
                  m.alsoInRoster && !m.removed ? MANUAL_SHADOWED_NOTE : null
                }
                saved={m}
                defaultRoleLabel={null}
                canReset={false}
                editable={p.editable && !m.removed}
                onDirty={p.onDirty}
                save={async (fields) => {
                  await saveManual.mutateAsync({
                    ...scope,
                    ccaID: m.ccaID,
                    ...fields,
                  });
                  await refresh();
                }}
                actions={
                  p.editable ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void flip(m.ccaID, !m.removed)}
                    >
                      {m.removed ? "Restore" : "Remove"}
                    </Button>
                  ) : null
                }
              />
            ))}
          </ul>
        )}
        <ErrorLine message={actionError} />

        {p.editable && (
          <div className="mt-4 space-y-3 rounded-lg border border-dashed border-gray-300 p-4">
            <h4 className="text-sm font-medium text-gray-900">
              Add manual CCA entry
            </h4>
            <div className="max-w-sm">
              <label htmlFor="manual-cca" className={FIELD_LABEL}>
                CCA
              </label>
              <select
                id="manual-cca"
                value={newCca}
                onChange={(e) =>
                  setNewCca(e.target.value === "" ? "" : Number(e.target.value))
                }
                className={SELECT_CLASS}
              >
                <option value="">Choose a CCA</option>
                {options.map((c) => (
                  <option key={c.ccaID} value={c.ccaID}>
                    {c.ccaName}
                  </option>
                ))}
              </select>
            </div>
            {newCca === "" ? (
              <p className="text-xs text-gray-500">
                Choose the CCA first, then its duration and role.
              </p>
            ) : (
              <ul>
                <MembershipForm
                  key={`add-${addKey}`}
                  idKey={`add-${addKey}`}
                  title="New entry"
                  saved={{
                    duration: null,
                    roleLabel: null,
                    roleDuration: null,
                    extraContribution: null,
                  }}
                  defaultRoleLabel={null}
                  canReset={false}
                  editable
                  onDirty={p.onDirty}
                  save={async (fields) => {
                    await saveManual.mutateAsync({
                      ...scope,
                      ccaID: newCca,
                      ...fields,
                    });
                    setNewCca("");
                    setAddKey((k) => k + 1);
                    await refresh();
                  }}
                />
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
