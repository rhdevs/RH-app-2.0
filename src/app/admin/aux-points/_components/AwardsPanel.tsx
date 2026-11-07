"use client";

import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, type RouterOutputs } from "~/trpc/react";
import { AwardFields, awardInput, type AwardDraft } from "./AwardFields";
import { auxErrorCopy, sgtToday } from "./auxCopy";
import { ErrorLine, Panel, PasteBox, StatusLine, UnresolvedList } from "./Bits";

type ImportResult = RouterOutputs["aux"]["importAwards"];

const blank = (): AwardDraft => ({
  amount: "1",
  reason: "",
  awardedOn: sgtToday(new Date()),
});

/**
 * AUX given by hand: one award to one resident (a fire warden's +1 a
 * semester), or many at once from an "identifier, amount" paste, which is how
 * totals kept before the app are carried over.
 */
export default function AwardsPanel({ onChanged }: { onChanged: () => void }) {
  return (
    <Panel
      title="Awards"
      description="AUX that didn’t come from an event: fire wardens, and totals carried over from before. Every award is logged with who gave it."
    >
      <div className="space-y-6">
        <SingleAward onChanged={onChanged} />
        <div className="border-t border-gray-100" />
        <ImportAwards onChanged={onChanged} />
      </div>
    </Panel>
  );
}

function SingleAward({ onChanged }: { onChanged: () => void }) {
  const id = useId();
  const [who, setWho] = useState("");
  const [draft, setDraft] = useState<AwardDraft>(blank);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const create = api.aux.createAward.useMutation();

  const save = async () => {
    const input = awardInput(draft);
    if (!who.trim() || !input) {
      setError(
        "Fill in who it is for, a whole number from 1 to 20, a reason and a date.",
      );
      return;
    }
    setError(null);
    setDone(null);
    try {
      await create.mutateAsync({ userID: who.trim(), ...input });
      setDone(`Gave ${input.amount} AUX to ${who.trim()}.`);
      setWho("");
      setDraft(blank());
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Give one award</h3>
      <div className="max-w-sm space-y-1">
        <label
          htmlFor={`${id}-who`}
          className="text-sm font-medium text-gray-800"
        >
          Resident
        </label>
        <Input
          id={`${id}-who`}
          value={who}
          placeholder="Matric, email or NUSNET id"
          disabled={create.isPending}
          onChange={(e) => setWho(e.target.value)}
        />
      </div>
      <AwardFields
        draft={draft}
        onChange={setDraft}
        disabled={create.isPending}
      />
      <Button size="sm" onClick={() => void save()} disabled={create.isPending}>
        Give award
      </Button>
      <ErrorLine message={error} />
      <StatusLine message={done} />
    </div>
  );
}

function ImportAwards({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<AwardDraft>({
    ...blank(),
    reason: "Carried over",
  });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const run = api.aux.importAwards.useMutation();

  const save = async () => {
    // The amount comes from each line, so any valid number stands in here.
    const input = awardInput({ ...draft, amount: "1" });
    if (!text.trim() || !input) {
      setError("Paste at least one line, and fill in a reason and a date.");
      return;
    }
    setError(null);
    setResult(null);
    try {
      const r = await run.mutateAsync({
        text,
        reason: input.reason,
        awardedOn: input.awardedOn,
      });
      setResult(r);
      if (r.added.length > 0) {
        setText(
          // Keep only the lines that failed, so they can be fixed and re-sent.
          text
            .split(/\r?\n/)
            .filter((_, i) =>
              [...r.unknown, ...r.badAmount].some((u) => u.line === i + 1),
            )
            .join("\n"),
        );
        onChanged();
      }
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">
        Import many (carried-over totals)
      </h3>
      <PasteBox
        label="One resident per line, then their AUX"
        hint="For example “A0123456X, 3”. A header row is skipped. Each line becomes one award with the reason and date below."
        value={text}
        onChange={setText}
        disabled={run.isPending}
      />
      <AwardFields
        draft={draft}
        onChange={setDraft}
        disabled={run.isPending}
        showAmount={false}
      />
      <Button size="sm" onClick={() => void save()} disabled={run.isPending}>
        Import awards
      </Button>
      <ErrorLine message={error} />
      {result && (
        <>
          <StatusLine
            message={`Added ${result.added.length} ${result.added.length === 1 ? "award" : "awards"} (${result.added.reduce((n, a) => n + a.amount, 0)} AUX).${result.already.length > 0 ? ` ${result.already.length} already had this award and were skipped.` : ""}`}
          />
          <UnresolvedList lines={[...result.unknown, ...result.badAmount]} />
        </>
      )}
    </div>
  );
}
