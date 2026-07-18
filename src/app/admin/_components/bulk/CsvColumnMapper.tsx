"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { CSV_COLUMN_KINDS, type CsvColumnKind } from "../../_lib/csv";

/**
 * Shows the first 5 rows with a <Select> in each header cell. The guess from
 * guessColumnKind() is a starting point and is ALWAYS overridable — a header
 * called "ID" could be a NUSNET id or a matric, and only the operator knows.
 */
export default function CsvColumnMapper({
  headers,
  sample,
  mapping,
  onChange,
}: {
  headers: string[];
  sample: string[][];
  mapping: CsvColumnKind[];
  onChange: (next: CsvColumnKind[]) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((h, i) => (
              <TableHead key={i} className="min-w-[10rem] align-top">
                <div className="space-y-1.5 py-2">
                  <p className="truncate text-xs font-medium text-gray-500">
                    {h || `Column ${i + 1}`}
                  </p>
                  <Select
                    value={mapping[i] ?? "ignore"}
                    onValueChange={(v) => {
                      const next = [...mapping];
                      next[i] = v as CsvColumnKind;
                      onChange(next);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CSV_COLUMN_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sample.slice(0, 5).map((r, ri) => (
            <TableRow key={ri}>
              {headers.map((_, ci) => (
                <TableCell key={ci} className="truncate text-xs text-gray-600">
                  {r[ci] ?? ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
