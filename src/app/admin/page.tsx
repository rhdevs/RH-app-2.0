"use client";

import { Users, ShieldCheck, Landmark, UserCog, Building2 } from "lucide-react";

import { api } from "~/trpc/react";
import AdminStatCard from "./_components/AdminStatCard";
import SystemHealthPanel from "./_components/health/SystemHealthPanel";
import { useCapabilities } from "./_components/AdminCapabilityContext";

export default function AdminOverviewPage() {
  const cap = useCapabilities();
  const { data } = api.admin.getStats.useQuery();

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <AdminStatCard
          label="Total users"
          value={data?.totalUsers ?? "—"}
          icon={Users}
        />
        <AdminStatCard label="JCRC" value={data?.jcrc ?? "—"} icon={Landmark} />
        <AdminStatCard
          label="CCA heads"
          value={data?.ccaHead ?? "—"}
          icon={UserCog}
        />
        {/* Hall Office. Shown to every manager as a plain count, unlike the
            Admins card below: how many accounts can appoint the JCRC is
            ordinary operational information, and a jcrc who cannot see that
            number cannot notice it going from 2 to 5. It is a COUNT only —
            WHO holds it is /admin/users' role filter, which is a different
            question with its own guard. */}
        <AdminStatCard
          label="Hall Office"
          value={data?.scrc ?? "—"}
          icon={Building2}
        />
        {/* getStats returns `admins: null` for a caller without
            seeAdminIdentities, so the card is omitted because the DATA is
            absent — not hidden by a client-side test. Do not hand a jcrc an
            enumeration of who holds admin (D-2). */}
        {data?.admins != null && (
          <AdminStatCard
            label="Admins"
            value={data.admins}
            icon={ShieldCheck}
            tone="danger"
          />
        )}
      </div>

      {cap.viewSystemHealth && <SystemHealthPanel />}
    </div>
  );
}
