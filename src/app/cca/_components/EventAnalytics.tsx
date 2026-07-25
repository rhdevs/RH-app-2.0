"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "~/trpc/react";

/**
 * Light signup analytics for the head's monitor page — cumulative signups over
 * time and a by-block breakdown. Deliberately nothing fancy. recharts is already
 * in the bundle (src/components/ui/chart.tsx); used directly here for two small
 * charts.
 */
export default function EventAnalytics({ eventID }: { eventID: number }) {
  const stats = api.event.getSignupStats.useQuery({ eventID }, { retry: false });

  if (stats.isPending) {
    return <div className="h-40 animate-pulse rounded-lg bg-gray-100" />;
  }
  if (stats.error || !stats.data) {
    return (
      <p className="text-sm text-gray-500">Signup analytics couldn’t load.</p>
    );
  }

  const { total, byDay, byBlock } = stats.data;

  // Cumulative running total for the area chart.
  let running = 0;
  const cumulative = byDay.map((d) => {
    running += d.count;
    return { date: d.date.slice(5), total: running };
  });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Total signups
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-gray-900">
            {total}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Blocks represented
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-gray-900">
            {byBlock.filter((b) => b.block !== "Unknown").length}
          </p>
        </div>
      </div>

      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-500">
          No signups yet — charts appear once people register.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="mb-3 text-sm font-medium text-gray-700">
              Signups over time
            </p>
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={cumulative}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" fontSize={11} tickLine={false} />
                  <YAxis allowDecimals={false} fontSize={11} width={28} />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="total"
                    stroke="#059669"
                    fill="#a7f3d0"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="mb-3 text-sm font-medium text-gray-700">
              Signups by block
            </p>
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byBlock}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="block" fontSize={11} tickLine={false} />
                  <YAxis allowDecimals={false} fontSize={11} width={28} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#059669" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
