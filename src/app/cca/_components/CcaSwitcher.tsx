"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { CaretSortIcon, CheckIcon } from "@radix-ui/react-icons";

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

export type SwitchableCca = {
  ccaID: number;
  ccaName: string | null;
  category: string | null;
};

/**
 * Switch between the CCAs you head, from anywhere in the dashboard.
 *
 * SWITCHING PRESERVES THE SECTION. On /cca/12/members, picking another CCA
 * lands on /cca/34/members — not back at its overview. Losing your place on
 * every switch is exactly what makes a switcher annoying enough to ignore.
 *
 * Uses the same Popover + Command combobox as the admin CcaPicker rather than a
 * <Select>, so it stays usable for a head of many CCAs, but it is a SEPARATE
 * component: CcaPicker queries admin.listCcas (all 89, manager-gated) and
 * reports a selection upward, while this one navigates and is fed the caller's
 * own headships. Sharing them would mean one component with two data sources
 * and two behaviours.
 */
export default function CcaSwitcher({
  ccas,
  currentCcaID,
}: {
  ccas: SwitchableCca[];
  currentCcaID: number;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const current = ccas.find((c) => c.ccaID === currentCcaID) ?? null;
  const label = current
    ? (current.ccaName ?? `Unknown CCA (#${current.ccaID})`)
    : `CCA #${currentCcaID}`;

  /**
   * The section suffix of the current path, if any.
   *
   * Takes only the FIRST segment after the ccaID, not the whole tail: a future
   * deeper route (/cca/12/members/export) must switch to /cca/34/members, which
   * exists, rather than to a nested path that may not.
   */
  const section = (() => {
    const m = /^\/cca\/\d+\/([^/]+)/.exec(pathname);
    return m ? `/${m[1]}` : "";
  })();

  // One CCA and no way to switch — render the name as a plain heading rather
  // than a control that does nothing when clicked.
  if (ccas.length <= 1) {
    return (
      <div className="px-2 py-1.5">
        <p className="truncate text-sm font-semibold text-gray-900">{label}</p>
        {current?.category && (
          <p className="truncate text-xs text-gray-500">{current.category}</p>
        )}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Switch CCA"
          className="w-full justify-between bg-white"
        >
          <span className="truncate">{label}</span>
          <CaretSortIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search your CCAs…" />
          <CommandList>
            <CommandEmpty>No CCA matches that.</CommandEmpty>
            <CommandGroup>
              {ccas.map((c) => (
                <CommandItem
                  key={c.ccaID}
                  value={`${c.ccaName ?? ""} ${c.ccaID} ${c.category ?? ""}`}
                  onSelect={() => {
                    setOpen(false);
                    router.push(`/cca/${c.ccaID}${section}`);
                  }}
                >
                  <CheckIcon
                    className={cn(
                      "mr-2 h-4 w-4",
                      c.ccaID === currentCcaID ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex-1 truncate">
                    {c.ccaName ?? `Unknown CCA (#${c.ccaID})`}
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
