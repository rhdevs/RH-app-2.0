"use client";

import { useState } from "react";
import { CaretSortIcon, CheckIcon } from "@radix-ui/react-icons";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";

import DisabledNotice, { disabledCopy } from "./DisabledNotice";

export type ScrcCcaOption =
  RouterOutputs["cca"]["listAllForOversight"]["ccas"][number];

/**
 * The hall office's CCA picker. Visually identical to
 * admin/_components/bulk/CcaPicker — a searchable combobox rather than a
 * <Select>, because there are 89 CCAs and a plain 89-item dropdown is a
 * scroll-and-hope control; typing filters on the NAME and on the ID because an
 * operator working from a spreadsheet usually has one or the other.
 *
 * A SEPARATE COMPONENT AND NOT A REUSE OF CcaPicker, deliberately. CcaPicker
 * reads api.admin.listCcas, which sits behind roleManagerProcedure — the hall
 * office would get a flat FORBIDDEN and an empty dropdown with no explanation.
 * cca.listAllForOversight exists exactly so this surface has a CCA list of its
 * own; it also means the picker goes dark with the `scrc.enabled` switch, which
 * is correct, and which is why it renders the switched-off state itself rather
 * than an error.
 *
 * The list is NOT an authorization. Every ccaID it hands back is authorised
 * again, per-CCA, by assertMayViewCcaRoster inside cca.getRoster.
 */
export default function ScrcCcaPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (cca: ScrcCcaOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data, isPending, error } = api.cca.listAllForOversight.useQuery(
    undefined,
    // A FORBIDDEN is a settled answer, and the kill switch being off is the
    // expected first-run state — retrying it three times is log noise.
    { retry: false },
  );

  const ccas = data?.ccas ?? [];
  const selected = ccas.find((c) => c.ccaID === value) ?? null;

  if (error) {
    if (disabledCopy(error.message)) {
      return <DisabledNotice message={error.message} />;
    }
    return (
      <p className="text-sm text-red-600">
        The CCA list couldn’t be loaded. Reload the page.
      </p>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={isPending}
          className="w-full justify-between bg-white sm:w-96"
        >
          {isPending
            ? "Loading CCAs…"
            : selected
              ? `${selected.ccaName} (${selected.ccaID})`
              : "Choose a CCA"}
          <CaretSortIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search by name or id…" />
          <CommandList>
            <CommandEmpty>No CCA matches that.</CommandEmpty>
            <CommandGroup>
              {ccas.map((c) => (
                <CommandItem
                  key={c.ccaID}
                  // The searchable text. Name AND id, so "142" finds it too.
                  value={`${c.ccaName} ${c.ccaID} ${c.category}`}
                  onSelect={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === c.ccaID ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex-1">{c.ccaName}</span>
                  <span className="ml-2 font-mono text-xs text-gray-400">
                    {c.ccaID}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
