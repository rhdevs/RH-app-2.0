"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { FACILITY_ROLES } from "~/server/api/services/roles";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import RoleBadge from "../RoleBadge";

type Facility = {
  facilityID: number;
  facilityName: string | null;
  requiredRoles: string[];
  unconfigured: boolean;
};

const ROLE_LABEL: Record<string, string> = {
  resident: "Residents only",
  jcrc: "JCRC only",
  cca_head: "CCA heads only",
};

/**
 * D-1 inverts v1's copy here, and this is the single highest-risk string on the
 * page. v1 described an absent FacilityAccess row as open to every user. That
 * is now wrong AND dangerous: under D-1 a missing row means ["resident"], and
 * no open-to-all state exists anywhere in the system. The exact v1 phrasing is
 * deliberately not repeated here — a merge gate greps src/ for it.
 */
function describe(f: Facility) {
  if (f.unconfigured) return "Not configured — defaults to Residents only";
  if (f.requiredRoles.length === 1) {
    return ROLE_LABEL[f.requiredRoles[0]!] ?? f.requiredRoles.join(", ");
  }
  return f.requiredRoles.join(" or ");
}

export default function FacilityAccessTable() {
  const utils = api.useUtils();
  const {
    data,
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = api.admin.listFacilityAccess.useQuery();
  /** Initial-load failure only — a later refetch blip keeps the previous rows
   *  (09 §2.8). */
  const loadFailed = isError && !data;
  const [editing, setEditing] = useState<Facility | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const save = api.admin.setFacilityAccess.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await utils.admin.listFacilityAccess.invalidate();
      await utils.admin.systemHealth.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const open = (f: Facility) => {
    setError(null);
    setSelected(f.requiredRoles);
    setEditing(f);
  };

  const facilities = data ?? [];
  const unconfigured = facilities.filter((f) => f.unconfigured);

  return (
    <div className="space-y-6">
      {/* Before anything derived from `data ?? []`. The amber "N facilities have
          no access rule" warning below comes from the SAME array as the
          all-clear, so on a failed read the fail-safe warning disappears
          exactly when the data is unavailable (09 §2.8). Say so instead. */}
      {loadFailed && (
        <Alert variant="destructive">
          <AlertTitle>Could not load facility access rules</AlertTitle>
          <AlertDescription>
            The table below is empty because the rules could not be fetched, not
            because no facilities are configured. Any facility missing an access
            rule will not be flagged here until this loads.{" "}
            {loadError?.message ?? "Something went wrong."}
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refetch()}
              >
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* The operational half of the fail-safe default: this is what keeps a
          silent config gap from becoming a permanent one. */}
      {unconfigured.length > 0 && (
        <div className="space-y-3 rounded-xl bg-white p-4 shadow-lg">
          <Alert className="border-amber-300 bg-amber-50">
            <AlertTitle className="text-amber-900">
              {unconfigured.length} facilities have no access rule
            </AlertTitle>
            <AlertDescription className="text-amber-800">
              They default to residents-only. Configure them so &quot;configured
              normal&quot; is distinguishable from &quot;never configured&quot;.
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            {unconfigured.map((f) => (
              <Button
                key={f.facilityID}
                size="sm"
                variant="outline"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    facilityID: f.facilityID,
                    requiredRoles: ["resident"],
                  })
                }
              >
                {f.facilityName ?? f.facilityID} → Residents only
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl bg-white shadow-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Facility</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Required roles</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadFailed ? (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-red-700">
                  Could not load facility access rules. This is not a list of
                  zero facilities — nothing could be read.
                </TableCell>
              </TableRow>
            ) : (
              isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-gray-500">
                    Loading…
                  </TableCell>
                </TableRow>
              )
            )}
            {facilities.map((f) => (
              <TableRow key={f.facilityID}>
                <TableCell className="font-medium text-gray-900">
                  {f.facilityName ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {f.facilityID}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {f.requiredRoles.map((r) => (
                      <RoleBadge key={r} role={r} />
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-gray-600">
                  <span className="flex items-center gap-2">
                    {f.unconfigured && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                    )}
                    {describe(f)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => open(f)}>
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editing.facilityName ?? `Facility ${editing.facilityID}`}
              </DialogTitle>
              <DialogDescription>
                Anyone holding at least one of the selected roles may book this
                facility. Admins bypass this gate implicitly and are therefore
                not listed.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              {/* FACILITY_ROLES is a SECOND, DISTINCT enum from GRANTABLE_ROLES.
                  `resident` must be selectable — the seed writes an explicit
                  ["resident"] row for every normal facility, and a dashboard
                  that cannot round-trip its own seeded state is broken.
                  `admin` must NOT be selectable — it is an implicit bypass, and
                  storing it invites someone to delete it and lock every admin
                  out of a room. */}
              {FACILITY_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={selected.includes(r)}
                    onCheckedChange={(v) =>
                      setSelected((prev) =>
                        v ? [...prev, r] : prev.filter((x) => x !== r),
                      )
                    }
                  />
                  {ROLE_LABEL[r] ?? r}
                </label>
              ))}
              {selected.length === 0 && (
                <p className="text-xs text-amber-700">
                  Pick at least one role. To make a room open to all residents,
                  select Residents.
                </p>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                className="bg-emerald-700 text-white hover:bg-emerald-800"
                // min(1) is enforced by zod server-side too: since a missing row
                // and an empty array mean the same thing, forcing an explicit
                // array removes the ambiguous state from the write path.
                disabled={selected.length === 0 || save.isPending}
                onClick={() =>
                  save.mutate({
                    facilityID: editing.facilityID,
                    requiredRoles: selected as (
                      | "resident"
                      | "jcrc"
                      | "cca_head"
                    )[],
                  })
                }
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
