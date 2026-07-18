"use client";

import { useState } from "react";
import Link from "next/link";

import { api } from "~/trpc/react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { useCapabilities } from "../AdminCapabilityContext";

function Line({
  label,
  value,
  tone = "default",
  indent,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "red" | "amber";
  indent?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1.5 ${
        indent ? "pl-5" : ""
      }`}
    >
      <span
        className={`text-sm ${
          tone === "red"
            ? "font-medium text-red-700"
            : tone === "amber"
              ? "text-amber-700"
              : "text-gray-600"
        }`}
      >
        {label}
      </span>
      <span className="flex-1 border-b border-dotted border-gray-200" />
      <span
        className={`font-mono text-sm ${
          tone === "red"
            ? "font-semibold text-red-700"
            : tone === "amber"
              ? "text-amber-700"
              : "text-gray-900"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export default function SystemHealthPanel() {
  const cap = useCapabilities();
  const utils = api.useUtils();
  const { data, isLoading } = api.admin.systemHealth.useQuery();

  const [explainUser, setExplainUser] = useState("");
  const [explainFacility, setExplainFacility] = useState("");
  const [explainArgs, setExplainArgs] = useState<{
    userID: string;
    facilityID: number;
  } | null>(null);

  const explain = api.admin.explainAccess.useQuery(explainArgs!, {
    enabled: explainArgs !== null,
    retry: false,
  });

  const setMode = api.admin.setEnforcementMode.useMutation({
    onSuccess: async () => {
      await utils.admin.systemHealth.invalidate();
    },
  });

  if (isLoading || !data) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-lg text-sm text-gray-500">
        Loading health…
      </div>
    );
  }

  const missing = data.residentBaselineMissing;
  const blocked = missing > 0;

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          System health
        </h2>

        <Line label="Enforcement mode" value={data.enforcementMode} />
        {/* THE one red tile, and it gates the enforcement flip. Under a stored
            baseline a non-zero value is not a materialisation gap — it is that
            many eligible users who cannot book RIGHT NOW. Red, never amber. */}
        <Line
          label="Eligible users MISSING the resident baseline"
          value={missing}
          tone={blocked ? "red" : "default"}
        />
        <Line label="Shadow denials, last 24h" value={data.shadowDenials24h} />
        <Line
          label="Baseline repair failures, last 24h"
          value={
            data.baselineRepairFailures24h ?? (
              <span
                className="text-gray-400"
                title="baseline_repair_failed is a structured console log today. Until those logs reach a queryable sink, grep the platform logs for that evt."
              >
                n/a
              </span>
            )
          }
        />
        <Line label="Facilities" value={data.facilities} />
        <Line
          label="UNCONFIGURED (defaulting to resident)"
          value={data.unconfiguredFacilities}
          tone={data.unconfiguredFacilities > 0 ? "amber" : "default"}
          indent
        />
        <Line
          label='Facilities storing "admin" in requiredRoles'
          value={data.adminRolesStoredOnFacilities}
          tone={data.adminRolesStoredOnFacilities > 0 ? "amber" : "default"}
        />

        {blocked && (
          <Alert variant="destructive" className="mt-4">
            <AlertTitle>Enforcement flip is blocked</AlertTitle>
            <AlertDescription>
              {missing} eligible accounts do not hold the stored Resident
              baseline and cannot book anything. Do not switch enforcement to{" "}
              <code>enforce</code> while this is non-zero. They should self-heal
              at their next sign-in; anyone who does not is a genuine UserRole
              write failure and needs the backfill re-run.
            </AlertDescription>
          </Alert>
        )}

        {data.unconfiguredFacilities > 0 && (
          <Alert className="mt-4 border-amber-300 bg-amber-50">
            <AlertDescription className="text-amber-800">
              {data.unconfiguredFacilities} facilities have no access rule and
              default to residents-only.{" "}
              <Link href="/admin/facilities" className="underline">
                Configure them.
              </Link>
            </AlertDescription>
          </Alert>
        )}

        {/* Per-user identifier lists are account-integrity disclosures about
            named individuals. The server returns `detail: null` for anyone
            without viewSystemHealthDetail, so this is a render of what arrived,
            not a client-side filter of data a jcrc already received. */}
        {data.detail && data.detail.unconfigured.length > 0 && (
          <div className="mt-4 rounded-lg bg-gray-50 p-3">
            <p className="mb-1 text-xs font-medium text-gray-700">
              Unconfigured facilities
            </p>
            <p className="font-mono text-xs text-gray-600">
              {data.detail.unconfigured
                .map((f) => f.facilityName ?? f.facilityID)
                .join(", ")}
            </p>
          </div>
        )}
      </div>

      {cap.manageEnforcementFlag && (
        <div className="rounded-xl bg-white p-6 shadow-lg">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">
            Enforcement mode
          </h3>
          <p className="mb-3 text-xs text-gray-500">
            <code>off</code> means LEGACY semantics, not blanket-allow.{" "}
            <code>permissive</code> evaluates and audits the would-be denial but
            allows. <code>enforce</code> denies. Takes effect within 15s — no
            redeploy.
          </p>
          <div className="flex items-center gap-3">
            <Select
              value={data.enforcementMode}
              onValueChange={(v) =>
                setMode.mutate({ mode: v as "off" | "permissive" | "enforce" })
              }
              // The red line is a GATE, not a warning: refuse the flip while
              // eligible users are locked out.
              disabled={setMode.isPending}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">off (legacy)</SelectItem>
                <SelectItem value="permissive">permissive (shadow)</SelectItem>
                <SelectItem value="enforce" disabled={blocked}>
                  enforce {blocked ? "— blocked" : ""}
                </SelectItem>
              </SelectContent>
            </Select>
            {blocked && (
              <span className="text-xs text-red-700">
                Blocked while the missing-baseline count is non-zero.
              </span>
            )}
          </div>
        </div>
      )}

      {cap.reachDashboard && (
        <div className="rounded-xl bg-white p-6 shadow-lg">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">
            Explain access
          </h3>
          {/* Runs the booking evaluation AS THE TARGET, so an admin can see a
              non-admin outcome without holding a non-admin session — the
              admin-bypass blind spot. It is an enumeration primitive over the
              whole user base, so every call is audited with caller and target
              server-side. */}
          <p className="mb-3 text-xs text-gray-500">
            Evaluates booking as the target user. Every call is audited with
            your id and theirs.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={explainUser}
              onChange={(e) => setExplainUser(e.target.value.toUpperCase())}
              placeholder="E1234567"
              className="w-40 font-mono text-sm"
            />
            <Input
              value={explainFacility}
              onChange={(e) => setExplainFacility(e.target.value)}
              placeholder="Facility ID"
              className="w-32 text-sm"
            />
            <Button
              variant="outline"
              disabled={
                !/^E\d{7}$/.test(explainUser) ||
                !/^\d+$/.test(explainFacility)
              }
              onClick={() =>
                setExplainArgs({
                  userID: explainUser,
                  facilityID: Number(explainFacility),
                })
              }
            >
              Explain
            </Button>
          </div>
          {explain.data && (
            <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">
              {JSON.stringify(explain.data, null, 2)}
            </pre>
          )}
          {explain.error && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{explain.error.message}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
