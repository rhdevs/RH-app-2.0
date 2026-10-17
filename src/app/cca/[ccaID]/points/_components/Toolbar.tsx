"use client";

import { Search } from "lucide-react";

import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import type { ListView, SortKey } from "./listView";

/** Search, the "Unscored only" filter and the sort order. */
export default function Toolbar({
  view,
  onChange,
}: {
  view: ListView;
  onChange: (view: ListView) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="relative min-w-0 flex-1 basis-48">
        <span className="sr-only">Search by name or matric</span>
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          type="search"
          value={view.search}
          onChange={(e) => onChange({ ...view, search: e.target.value })}
          placeholder="Search name or matric"
          className="pl-8"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <Checkbox
          checked={view.unscoredOnly}
          onCheckedChange={(v) =>
            onChange({ ...view, unscoredOnly: v === true })
          }
        />
        Unscored only
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        Sort
        <select
          value={view.sort}
          onChange={(e) =>
            onChange({ ...view, sort: e.target.value as SortKey })
          }
          className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <option value="name">Name</option>
          <option value="score">Score</option>
        </select>
      </label>
    </div>
  );
}
