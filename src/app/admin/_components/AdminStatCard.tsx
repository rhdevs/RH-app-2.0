import type { LucideIcon } from "lucide-react";

/**
 * Styled to match src/app/profile/page.tsx (`rounded-xl bg-white shadow-lg`)
 * rather than the shadcn Card default, so the dashboard reads as the same
 * product as the rest of the app.
 */
export default function AdminStatCard({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-xl bg-white p-6 shadow-lg">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <Icon
          className={`h-5 w-5 ${
            tone === "danger" ? "text-red-500" : "text-emerald-600"
          }`}
        />
      </div>
      <p
        className={`mt-2 text-3xl font-semibold ${
          tone === "danger" ? "text-red-700" : "text-gray-900"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
