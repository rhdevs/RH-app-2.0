"use client";

import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";

import { api } from "~/trpc/react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Checkbox } from "~/components/ui/checkbox";
import { Textarea } from "~/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import { useCapabilities } from "../AdminCapabilityContext";
import RoleBadge from "../RoleBadge";
import EmptyState from "../EmptyState";
import { splitPasted } from "../../_lib/planClient";

const DAY = 24 * 3600 * 1000;

function ExpiryBadge({ expiresAt }: { expiresAt: Date }) {
  const ms = expiresAt.getTime() - Date.now();
  const cls =
    ms <= 0
      ? "border-red-300 bg-red-100 text-red-800"
      : ms <= 7 * DAY
        ? "border-amber-300 bg-amber-100 text-amber-800"
        : "border-emerald-300 bg-emerald-100 text-emerald-800";
  return (
    <Badge variant="outline" className={cls} title={format(expiresAt, "PPpp")}>
      {ms <= 0 ? "Expired" : `in ${formatDistanceToNow(expiresAt)}`}
    </Badge>
  );
}

export default function PendingGrantsPanel() {
  const cap = useCapabilities();
  const utils = api.useUtils();
  const {
    data,
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = api.admin.listPendingGrants.useQuery({
    limit: 50,
  });

  /** A failed FIRST load, not a later blip: react-query keeps previous data, and
   *  a transient refetch failure must not blank a working page (09 §2.8). */
  const loadFailed = isError && !data;

  const [identifiers, setIdentifiers] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = async () => {
    await utils.admin.listPendingGrants.invalidate();
  };

  const create = api.admin.createPendingGrants.useMutation({
    onSuccess: async () => {
      setIdentifiers("");
      await invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const revoke = api.admin.revokePendingGrant.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });
  const purge = api.admin.purgeExpiredPendingGrants.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  const rows = data ?? [];
  const anyExpiring = rows.some(
    (r) => new Date(r.expiresAt).getTime() - Date.now() <= 7 * DAY,
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Deferred grants</h2>
        {/* The keying rule is enforced server-side; stating it here is what
            stops an operator wasting a roster on identifiers that cannot work.
            A matric is self-asserted and a display name is neither unique nor
            non-null, so neither can key a bearer credential against a mailbox
            nobody has claimed yet. */}
        <p className="text-sm text-gray-500">
          For people who have not signed up yet. Keyed on a NUSNET id or an
          @u.nus.edu address only — never a matric number and never a name. The
          roles apply automatically at their first sign-in. Resident is never
          deferred: it is granted at account creation.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* A SECOND surface, deliberately not the Alert above: that one reports a
          failed revoke or create. A failed read is a different fact and needs
          its own message. */}
      {loadFailed && (
        <Alert variant="destructive">
          <AlertDescription>
            The list of deferred grants could not be loaded, so this page cannot
            tell you whether any are outstanding. Do not read the table below as
            &quot;none&quot;. {loadError?.message ?? "Something went wrong."}{" "}
            <Button
              size="sm"
              variant="outline"
              className="ml-2"
              onClick={() => void refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {anyExpiring && (
        <Alert className="border-amber-300 bg-amber-50">
          <AlertDescription className="text-amber-800">
            Some grants are expired or expire within 7 days. Expiry is lazy —
            the claim path ignores expired rows and purging is manual.
          </AlertDescription>
        </Alert>
      )}

      {cap.createPendingGrants && cap.assignableRoles.length > 0 && (
        <div className="space-y-3 rounded-xl bg-white p-4 shadow-lg">
          <Textarea
            rows={3}
            value={identifiers}
            onChange={(e) => setIdentifiers(e.target.value)}
            placeholder={"E1234567\nalice@u.nus.edu"}
            className="font-mono text-sm"
          />
          <div className="flex flex-wrap items-center gap-4">
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
            <label className="flex items-center gap-2 text-sm">
              Expires in
              <Input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-20"
              />
              days
            </label>
          </div>
          {/* admin-bearing grants additionally require a reason and <= 14 days
              server-side; the field is shown always so the requirement is not a
              surprise refusal. */}
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required for admin grants, which are also capped at 14 days)"
            maxLength={500}
          />
          <Button
            className="bg-emerald-700 text-white hover:bg-emerald-800"
            disabled={
              create.isPending ||
              selectedRoles.length === 0 ||
              splitPasted(identifiers).length === 0
            }
            onClick={() => {
              setError(null);
              create.mutate({
                rows: splitPasted(identifiers).map((identifier) => ({
                  identifier,
                  roles: selectedRoles as ("admin" | "jcrc" | "cca_head")[],
                })),
                expiresInDays: days,
                reason: reason.trim() || undefined,
              });
            }}
          >
            {create.isPending ? "Creating…" : "Create deferred grants"}
          </Button>
          {create.data && (
            <div className="space-y-1 text-xs">
              {create.data.results.map((r, i) => (
                <p
                  key={i}
                  className={
                    r.status === "ok" ? "text-emerald-700" : "text-red-600"
                  }
                >
                  {r.identifier}: {r.status === "ok" ? "created" : r.denyReason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl bg-white shadow-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>NUSNET id</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Created by</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* The error branch comes FIRST, so `data ?? []` can never reach the
                EmptyState and turn a failed read into an all-clear about
                outstanding privileged bearer credentials (09 §2.8). */}
            {loadFailed ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <EmptyState
                    title="Could not load deferred grants"
                    hint="There may or may not be grants outstanding — the list could not be fetched. Use Try again above."
                  />
                </TableCell>
              </TableRow>
            ) : (
              !isLoading &&
              rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyState title="No deferred grants outstanding." />
                  </TableCell>
                </TableRow>
              )
            )}
            {rows.map((r) => (
              <TableRow key={r.userID}>
                <TableCell className="font-mono text-xs">{r.userID}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {r.roles.map((x) => (
                      <RoleBadge key={x} role={x} />
                    ))}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.createdBy}
                </TableCell>
                <TableCell className="text-xs text-gray-500">
                  {formatDistanceToNow(new Date(r.createdAt), {
                    addSuffix: true,
                  })}
                </TableCell>
                <TableCell>
                  <ExpiryBadge expiresAt={new Date(r.expiresAt)} />
                </TableCell>
                <TableCell className="text-right">
                  {cap.createPendingGrants && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoke.isPending}
                      onClick={() => {
                        setError(null);
                        revoke.mutate({ userID: r.userID });
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* purgeExpiredPendingGrants is an adminProcedure. There is no scheduler
          in this repo and one must not be built for this — expiry is lazy by
          design and the purge is a deliberate manual act. */}
      {cap.manageEnforcementFlag && (
        <Button
          variant="outline"
          disabled={purge.isPending}
          onClick={() => purge.mutate()}
        >
          {purge.isPending ? "Purging…" : "Purge expired"}
        </Button>
      )}
    </div>
  );
}
