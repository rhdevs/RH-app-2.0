"use client";

import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";

import { useCapabilities } from "../AdminCapabilityContext";
import { guessColumnKind, parseCsv, type CsvColumnKind } from "../../_lib/csv";
import { splitPasted } from "../../_lib/planClient";
import CsvColumnMapper from "./CsvColumnMapper";

export type BulkRow = { lineNo: number; identifier: string; roles: string[] };

const MAX_ROWS = 1000;

export default function BulkInputStep({
  onPreview,
  isPending,
}: {
  onPreview: (rows: BulkRow[], mode: "add" | "set") => void;
  isPending: boolean;
}) {
  const cap = useCapabilities();
  const [paste, setPaste] = useState("");
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<CsvColumnKind[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [mode, setMode] = useState<"add" | "set">("add");

  const headers = csvRows?.[0] ?? [];
  const identifierCol = mapping.findIndex((m) =>
    ["identifier", "email", "nusnet"].includes(m),
  );

  const rows: BulkRow[] = csvRows
    ? csvRows
        .slice(1)
        .map((r, i) => ({
          lineNo: i + 2,
          identifier:
            (identifierCol >= 0 ? r[identifierCol] : "")?.trim() ?? "",
          roles: selectedRoles,
        }))
        .filter((r) => r.identifier !== "")
    : splitPasted(paste).map((identifier, i) => ({
        lineNo: i + 1,
        identifier,
        roles: selectedRoles,
      }));

  const tooMany = rows.length > MAX_ROWS;
  const canPreview =
    rows.length > 0 && !tooMany && selectedRoles.length > 0 && !isPending;

  const handleFile = async (file: File) => {
    const parsed = parseCsv(await file.text());
    setCsvRows(parsed);
    setMapping((parsed[0] ?? []).map(guessColumnKind));
  };

  return (
    <div className="space-y-6">
      {/**
       * cap.assignableRoles is derived from ASSIGNABLE_BY, where jcrc maps to []
       * (D-3) and cca_head is absent for everyone (I-14). For a jcrc that array
       * is EMPTY, so this surface has nothing it can grant. Say so plainly
       * rather than rendering an empty picker that looks broken.
       */}
      {cap.assignableRoles.length === 0 && (
        <Alert className="border-amber-300 bg-amber-50">
          <AlertTitle className="text-amber-900">
            No roles are assignable from this surface
          </AlertTitle>
          <AlertDescription className="text-amber-800">
            Bulk import grants roles through the generic role path, and no role
            is assignable by your account there. CCA headship is managed from
            the CCAs surface so its scoped record stays in sync, and only an
            administrator can grant JCRC.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="paste">
        <TabsList>
          <TabsTrigger value="paste">Paste</TabsTrigger>
          <TabsTrigger value="csv">CSV</TabsTrigger>
        </TabsList>

        <TabsContent value="paste" className="pt-4">
          <Textarea
            rows={8}
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              setCsvRows(null);
            }}
            placeholder={"E1234567\nE7654321\nalice@u.nus.edu"}
            className="font-mono text-sm"
          />
          <p className="mt-2 text-xs text-gray-500">
            One identifier per line, or separated by spaces, commas or
            semicolons. NUSNET ids and @u.nus.edu addresses resolve; names and
            matric numbers do not.
          </p>
        </TabsContent>

        <TabsContent value="csv" className="space-y-4 pt-4">
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          {csvRows && headers.length > 0 && (
            <>
              <CsvColumnMapper
                headers={headers}
                sample={csvRows.slice(1)}
                mapping={mapping}
                onChange={setMapping}
              />
              {identifierCol < 0 && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Map one column to <code>identifier</code>,{" "}
                    <code>email</code> or <code>nusnet</code> before previewing.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-700">Roles to apply</p>
        <div className="flex flex-wrap gap-4">
          {/* Options are cap.assignableRoles ONLY. `admin` is ABSENT rather
              than rendered-disabled for a jcrc: do not leak the ladder.
              `resident` is never an option (D-1/I-8e) — it is unrepresentable
              in the payload schema server-side too. */}
          {cap.assignableRoles.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedRoles.includes(r)}
                onCheckedChange={(v) =>
                  setSelectedRoles((prev) =>
                    v ? [...prev, r] : prev.filter((x) => x !== r),
                  )
                }
              />
              {r}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-700">Mode</p>
        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as "add" | "set")}
          className="space-y-2"
        >
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="add" /> Add roles
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="set" /> Replace roles
          </label>
        </RadioGroup>
        {mode === "set" && (
          <Alert variant="destructive" className="mt-3">
            <AlertTitle>Replace mode removes roles</AlertTitle>
            <AlertDescription>
              Every listed user ends up holding exactly the roles selected
              above. Any other role they currently hold — and that you are
              permitted to revoke — will be removed. The Resident baseline is
              preserved regardless: the server&apos;s write cannot express its
              removal, so this is a statement of fact, not a promise this screen
              keeps.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {tooMany && (
        <Alert variant="destructive">
          <AlertDescription>
            {rows.length} rows — the limit is {MAX_ROWS} per import. Split the
            list.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button
          className="bg-emerald-700 text-white hover:bg-emerald-800"
          disabled={!canPreview}
          onClick={() => onPreview(rows, mode)}
        >
          {isPending ? "Previewing…" : `Preview ${rows.length} rows`}
        </Button>
        {selectedRoles.length === 0 && rows.length > 0 && (
          <span className="text-xs text-gray-500">
            Select at least one role.
          </span>
        )}
      </div>
    </div>
  );
}
