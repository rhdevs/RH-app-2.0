"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  CCA_TYPES,
  IHG_RESULTS,
  type CcaType,
  type IhgResult,
} from "~/lib/points/constants";
import { CAP_ERROR, decideCapCommit } from "./capInput";
import { pointsErrorCopy } from "./errorCopy";

/** One entry of `getConfig.ccas`. */
export type CcaSettingsRow = {
  ccaID: number;
  ccaName: string;
  isSport: boolean;
  sportSource: "jcrc" | "category";
  type: CcaType | null;
  ihgResult: IhgResult | null;
  ihgCap: number | null;
  isFlat: boolean;
  hasWaiver: boolean;
};

const NOT_SET = "none";
const IHG_LABELS: Record<IhgResult, string> = {
  "1st": "1st",
  "2nd": "2nd",
  "3rd": "3rd",
  "3rd4th_no_match": "3rd–4th, no placement match",
};

type RowStatus = { kind: "saving" | "saved" | "error"; text: string };

function errorText(err: unknown): string {
  const e = err as { message?: string; data?: { code?: string } | null };
  return pointsErrorCopy(e.message ?? "", e.data?.code);
}

function CcaSettingsRowItem({
  cca,
  onChanged,
}: {
  cca: CcaSettingsRow;
  onChanged: () => Promise<boolean>;
}) {
  const [status, setStatus] = useState<RowStatus | null>(null);
  const [capText, setCapText] = useState(cca.ihgCap?.toString() ?? "");
  const [capInvalid, setCapInvalid] = useState(false);
  const [capLowered, setCapLowered] = useState(false);

  // The stored value is the truth: follow it after every re-read.
  useEffect(() => {
    setCapText(cca.ihgCap?.toString() ?? "");
    setCapInvalid(false);
  }, [cca.ihgCap]);

  const setType = api.ccaPoints.setType.useMutation();
  const setIhg = api.ccaPoints.setIhg.useMutation();
  const setSport = api.ccaPoints.setSport.useMutation();

  // The whole row is locked from the start of a save until the reload has
  // finished, so no control can write back a stale value of another field.
  // The ref is the synchronous guard (Enter then blur); the state drives the UI.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const save = async (write: () => Promise<unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setStatus({ kind: "saving", text: "Saving…" });
    try {
      try {
        await write();
      } catch (err) {
        setStatus({ kind: "error", text: errorText(err) });
        return false;
      }
      const reloaded = await onChanged();
      setStatus(
        reloaded
          ? { kind: "saved", text: "Saved" }
          : {
              kind: "error",
              text: "Saved, but couldn't reload the current settings. Reload the page.",
            },
      );
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const saveIhg = async (
    result: IhgResult | null,
    cap: number | null,
  ): Promise<boolean> => {
    const lowered = cap !== null && cca.ihgCap !== null && cap < cca.ihgCap;
    const saved = await save(() =>
      setIhg.mutateAsync({ ccaID: cca.ccaID, result, cap }),
    );
    if (saved) {
      setCapLowered(lowered);
    } else {
      // Never leave the box showing a number that wasn't stored.
      setCapText(cca.ihgCap?.toString() ?? "");
      setCapInvalid(false);
    }
    return saved;
  };

  const commitCap = async () => {
    if (busyRef.current) return;
    const decision = decideCapCommit(capText, cca.ihgCap);
    if (decision.kind === "invalid") {
      setCapInvalid(true);
      return;
    }
    setCapInvalid(false);
    if (decision.kind === "noop") {
      setCapText(cca.ihgCap?.toString() ?? "");
      return;
    }
    if (await saveIhg(cca.ihgResult, decision.cap)) {
      setCapText(decision.cap === null ? "" : String(decision.cap));
    }
  };

  const idBase = `cca-settings-${cca.ccaID}`;
  const showIhg = cca.isSport && !cca.isFlat;

  return (
    <li className="space-y-2 px-3 py-3 text-sm sm:grid sm:grid-cols-[minmax(0,1.4fr)_auto_9rem_minmax(0,2fr)] sm:items-start sm:gap-x-4 sm:space-y-0">
      <p className="font-medium text-gray-900">
        {cca.ccaName}
        <span className="ml-2 font-mono text-xs text-gray-400">
          {cca.ccaID}
        </span>
      </p>

      <div className="flex items-center gap-2 py-1.5 sm:py-2">
        <Checkbox
          id={`${idBase}-sport`}
          checked={cca.isSport}
          disabled={cca.isFlat || busy}
          onCheckedChange={(v) =>
            void save(() =>
              setSport.mutateAsync({ ccaID: cca.ccaID, isSport: v === true }),
            )
          }
        />
        <label htmlFor={`${idBase}-sport`} className="text-gray-700">
          Sport
        </label>
        {cca.sportSource === "category" && (
          <span className="text-xs text-gray-400">from category</span>
        )}
      </div>

      <Select
        value={cca.type ?? NOT_SET}
        disabled={cca.isFlat || busy}
        onValueChange={(v) =>
          void save(() =>
            setType.mutateAsync({
              ccaID: cca.ccaID,
              type: v === NOT_SET ? null : (v as CcaType),
            }),
          )
        }
      >
        <SelectTrigger aria-label={`Type for ${cca.ccaName}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_SET}>— not set —</SelectItem>
          {CCA_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="mt-2 space-y-1.5 sm:mt-0">
        {cca.isFlat && (
          <p className="py-2 text-xs text-gray-500">
            Flat: not used while flat
          </p>
        )}
        {showIhg && (
          <div className="flex flex-wrap items-start gap-2">
            <div className="w-full min-w-0 sm:w-56">
              <Select
                value={cca.ihgResult ?? NOT_SET}
                disabled={busy}
                onValueChange={(v) =>
                  void saveIhg(
                    v === NOT_SET ? null : (v as IhgResult),
                    cca.ihgCap,
                  )
                }
              >
                <SelectTrigger aria-label={`IHG result for ${cca.ccaName}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOT_SET}>— not set —</SelectItem>
                  {IHG_RESULTS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {IHG_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-24">
              <Input
                inputMode="numeric"
                placeholder="Cap"
                aria-label={`IHG cap for ${cca.ccaName}`}
                aria-invalid={capInvalid}
                value={capText}
                disabled={busy}
                onChange={(e) => setCapText(e.target.value)}
                onBlur={() => void commitCap()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitCap();
                }}
                className="h-9"
              />
            </div>
          </div>
        )}
        {capInvalid && (
          <p className="text-xs text-red-700" role="alert">
            {CAP_ERROR}
          </p>
        )}
        {showIhg && capLowered && (
          <p className="text-xs text-amber-700">
            Heads who already exported more ticks than this will need to export
            again
          </p>
        )}
        {status && (
          <p
            className={`text-xs ${
              status.kind === "error" ? "text-red-700" : "text-emerald-700"
            }`}
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.text}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Every CCA's type, sport tick and (sports only) IHG result and cap. CONFIG
 * ONLY: it is carried to the sandbox in the bundle, never any points. Each
 * control saves on its own and the row only changes after the server value is
 * re-read — nothing renders optimistically.
 */
export default function CcaSettingsPanel({
  ccas,
  onChanged,
}: {
  ccas: CcaSettingsRow[];
  onChanged: () => Promise<boolean>;
}) {
  const [filter, setFilter] = useState("");
  const [sportsOnly, setSportsOnly] = useState(false);

  const counted = ccas.filter((c) => !c.isFlat);
  const sports = counted.filter((c) => c.isSport);
  const withType = counted.filter((c) => c.type !== null).length;
  const sportsReady = sports.filter(
    (c) => c.ihgResult !== null && c.ihgCap !== null,
  ).length;

  const needle = filter.trim().toLowerCase();
  const shown = ccas.filter(
    (c) =>
      (!sportsOnly || c.isSport) &&
      (needle === "" ||
        c.ccaName.toLowerCase().includes(needle) ||
        String(c.ccaID).includes(needle)),
  );

  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <h3 className="mb-1 text-sm font-semibold text-gray-900">CCA settings</h3>
      <p className="mb-4 max-w-3xl text-xs text-gray-500">
        Type says whether the CCA counts in full (1x) or half (0.5x). For sports
        CCAs, the IHG result is this year&rsquo;s placing and the cap is the
        most members the head may tick for the IHG points; the head ticks them
        on the points page. All of this goes to the points sandbox in the
        bundle; the point amounts and levels are set in the sandbox. Points
        entry can only be opened once every sport has an IHG result and cap.
      </p>

      <p className="mb-3 text-sm tabular-nums text-gray-700">
        {withType} of {counted.length} CCAs have a type · {sportsReady} of{" "}
        {sports.length} sports have an IHG result and cap
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-4">
        <Input
          aria-label="Filter CCAs by name or id"
          placeholder="Filter by name or id"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-9 w-full sm:w-72"
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="cca-settings-sports-only"
            checked={sportsOnly}
            onCheckedChange={(v) => setSportsOnly(v === true)}
          />
          <label
            htmlFor="cca-settings-sports-only"
            className="text-sm text-gray-700"
          >
            Sports only
          </label>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">
          No CCAs match.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {shown.map((c) => (
            <CcaSettingsRowItem key={c.ccaID} cca={c} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}
