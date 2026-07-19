"use client";

import { useState } from "react";
import { CaretSortIcon, CheckIcon } from "@radix-ui/react-icons";

import { api } from "~/trpc/react";
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

export type CcaOption = { ccaID: number; ccaName: string; category: string };

/**
 * A searchable combobox rather than a <Select>: there are 89 CCAs, and a plain
 * 89-item dropdown is a scroll-and-hope control. Typing filters on the NAME and
 * on the ID, because an operator working from a spreadsheet usually has one or
 * the other and not both.
 *
 * The id is shown next to every name on purpose. It is the value that actually
 * gets written to CcaHead.ccaID, so it is the thing worth confirming before a
 * list of thirty people is attached to it.
 */
export default function CcaPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (cca: CcaOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: ccas, isPending, error } = api.admin.listCcas.useQuery();

  const selected = ccas?.find((c) => c.ccaID === value) ?? null;

  if (error) {
    return (
      <p className="text-sm text-red-600">
        The CCA list could not be loaded, so there is nothing safe to assign
        against. Reload the page.
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
          className="w-full justify-between sm:w-96"
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
            itemValue.toLowerCase().includes(search.toLowerCase().trim())
              ? 1
              : 0
          }
        >
          <CommandInput placeholder="Search by name or id…" />
          <CommandList>
            <CommandEmpty>No CCA matches that.</CommandEmpty>
            <CommandGroup>
              {(ccas ?? []).map((c) => (
                <CommandItem
                  // The searchable text. Name AND id, so "142" finds it too.
                  key={c.ccaID}
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
