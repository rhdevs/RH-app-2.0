"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { api, type RouterOutputs } from "~/trpc/react";
import { AwardFields, awardInput, type AwardDraft } from "./AwardFields";
import { auxErrorCopy } from "./auxCopy";
import { ErrorLine, Panel, PersonCell } from "./Bits";

type Overview = RouterOutputs["aux"]["overview"];
type Detail = RouterOutputs["aux"]["detail"];
type Award = Detail["awards"][number];

/**
 * Each resident's AUX for the year. A row opens to show where it came from:
 * the AUX events they checked in to, the record-only events they are listed
 * on, and the awards, which can be edited or deleted here.
 */
export default function TotalsPanel({
  overview,
  onChanged,
}: {
  overview: Overview;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { totals, year, readOnly } = overview;
  const sum = totals.reduce((n, t) => n + t.total, 0);

  return (
    <Panel
      title={`AUX in ${year}`}
      description={
        totals.length === 0
          ? "No one has any AUX this year yet."
          : `${totals.length} ${totals.length === 1 ? "resident has" : "residents have"} ${sum} AUX between them. Open a row to see where it came from.`
      }
    >
      {totals.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Resident
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  From events
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  From awards
                </th>
                <th scope="col" className="py-2 pl-3 text-right font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => {
                const isOpen = open === t.userID;
                return (
                  <Fragment key={t.userID}>
                    <tr className="border-b border-gray-100 last:border-0">
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : t.userID)}
                          className="inline-flex items-center gap-1 rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" aria-hidden />
                          ) : (
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          )}
                          <PersonCell name={t.name} matric={t.matric} />
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {t.fromEvents}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {t.fromAwards}
                      </td>
                      <td className="py-2 pl-3 text-right font-semibold tabular-nums">
                        {t.total}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={4} className="bg-gray-50 px-4 py-3">
                          <DetailView
                            year={year}
                            userID={t.userID}
                            readOnly={readOnly}
                            onChanged={onChanged}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const when = (d: Date | null) =>
  d ? d.toLocaleDateString("en-SG", { timeZone: "Asia/Singapore" }) : "";

function DetailView({
  year,
  userID,
  readOnly,
  onChanged,
}: {
  year: string;
  userID: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const detail = api.aux.detail.useQuery({ year, userID });
  if (detail.isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" />;
  }
  if (!detail.data) {
    return <ErrorLine message="Couldn’t load where this AUX came from." />;
  }
  const { events, records, awards } = detail.data;
  const changed = () => {
    void detail.refetch();
    onChanged();
  };
  return (
    <div className="grid gap-4 text-sm md:grid-cols-3">
      <div>
        <h3 className="font-medium text-gray-900">
          AUX events ({events.length})
        </h3>
        <ul className="mt-1 space-y-0.5 text-gray-700">
          {events.map((e) => (
            <li key={e.eventID}>
              {e.title}
              <span className="text-xs text-gray-500">
                {" "}
                · {e.method === "manual" ? "added by JCRC" : "checked in"}{" "}
                {when(e.checkedInAt)}
              </span>
            </li>
          ))}
          {events.length === 0 && <li className="text-gray-500">None</li>}
        </ul>
      </div>
      <div>
        <h3 className="font-medium text-gray-900">
          Record-only events ({records.length})
        </h3>
        <ul className="mt-1 space-y-0.5 text-gray-700">
          {records.map((r) => (
            <li key={r.id}>
              {r.title}
              <span className="text-xs text-gray-500"> · {r.heldOn}</span>
            </li>
          ))}
          {records.length === 0 && <li className="text-gray-500">None</li>}
        </ul>
      </div>
      <div>
        <h3 className="font-medium text-gray-900">Awards ({awards.length})</h3>
        <ul className="mt-1 space-y-2">
          {awards.map((a) => (
            <AwardRow
              key={a.id}
              award={a}
              readOnly={readOnly}
              onChanged={changed}
            />
          ))}
          {awards.length === 0 && <li className="text-gray-500">None</li>}
        </ul>
      </div>
    </div>
  );
}

function AwardRow({
  award,
  readOnly,
  onChanged,
}: {
  award: Award;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<AwardDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = api.aux.updateAward.useMutation();
  const remove = api.aux.deleteAward.useMutation();
  const busy = update.isPending || remove.isPending;

  const save = async () => {
    const input = draft && awardInput(draft);
    if (!input) {
      setError("Fill in a whole number from 1 to 20, a reason and a date.");
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ id: award.id, ...input });
      setDraft(null);
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  const del = async () => {
    if (!window.confirm(`Delete this award of ${award.amount} AUX?`)) return;
    setError(null);
    try {
      await remove.mutateAsync({ id: award.id });
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  if (draft) {
    return (
      <li className="space-y-2 rounded-md border border-gray-200 bg-white p-3">
        <AwardFields draft={draft} onChange={setDraft} disabled={busy} />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraft(null)}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
        <ErrorLine message={error} />
      </li>
    );
  }
  return (
    <li className="text-gray-700">
      <span className="font-semibold tabular-nums">+{award.amount}</span>{" "}
      {award.reason}
      <span className="text-xs text-gray-500">
        {" "}
        · {award.awardedOn} · by {award.createdBy}
        {award.updatedBy ? `, edited by ${award.updatedBy}` : ""}
      </span>
      {!readOnly && (
        <span className="ml-2 inline-flex gap-2 text-xs">
          <button
            type="button"
            className="rounded underline underline-offset-2 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            disabled={busy}
            onClick={() =>
              setDraft({
                amount: String(award.amount),
                reason: award.reason,
                awardedOn: award.awardedOn,
              })
            }
          >
            Edit
          </button>
          <button
            type="button"
            className="rounded text-red-700 underline underline-offset-2 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            disabled={busy}
            onClick={() => void del()}
          >
            Delete
          </button>
        </span>
      )}
      <ErrorLine message={error} />
    </li>
  );
}
