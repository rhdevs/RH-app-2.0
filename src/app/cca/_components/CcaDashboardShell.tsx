"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Pencil,
  ClipboardList,
  ClipboardCheck,
  CalendarClock,
} from "lucide-react";

import { api } from "~/trpc/react";
import CcaSwitcher from "./CcaSwitcher";

/**
 * The dashboard chrome: CCA switcher pinned above a section nav, content to the
 * right.
 *
 * Adding a future section is ONE entry here plus one folder under [ccaID]/ —
 * the same property ADMIN_TABS gives /admin. `slug: ""` is the index route.
 */
const SECTIONS = [
  { slug: "", label: "Overview", icon: LayoutDashboard },
  { slug: "applications", label: "Applications", icon: ClipboardList },
  { slug: "interviews", label: "Interview slots", icon: CalendarClock },
  { slug: "sessions", label: "Interviews", icon: ClipboardCheck },
  { slug: "members", label: "View member list", icon: Users },
  { slug: "details", label: "CCA details", icon: Pencil },
] as const;

/**
 * RENDERS CHROME ONLY — it is not a guard.
 *
 * Every section's data comes from a procedure that calls assertHeadsCca itself,
 * so a head who types a ccaID they don't head gets this shell and then a denial
 * panel inside it. That is correct: the shell knows nothing worth protecting,
 * and duplicating the check here would be a second place to keep in step for no
 * additional protection (I-7).
 */
export default function CcaDashboardShell({
  ccaID,
  children,
}: {
  ccaID: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Cheap and already cached by the index page — the switcher needs the list
  // anyway, and it doubles as the source for the current CCA's name.
  const { data } = api.cca.listMine.useQuery(undefined, { retry: false });

  const ccas = data?.ccas ?? [];
  const current = ccas.find((c) => c.ccaID === ccaID) ?? null;

  const isActive = (slug: string) => {
    const base = `/cca/${ccaID}`;
    // The overview is an exact match; anything else would make it active on
    // every subsection, since they all start with the base path.
    return slug === "" ? pathname === base : pathname.startsWith(`${base}/${slug}`);
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Sidebar. Full width above lg so it stacks on a phone rather than
          squeezing the content column into a gutter. */}
      <aside className="w-full shrink-0 lg:w-64">
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3">
          <CcaSwitcher ccas={ccas} currentCcaID={ccaID} />

          <nav className="space-y-1">
            {SECTIONS.map((s) => {
              const href = s.slug ? `/cca/${ccaID}/${s.slug}` : `/cca/${ccaID}`;
              const active = isActive(s.slug);
              return (
                <Link
                  key={s.slug || "overview"}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-emerald-50 text-emerald-700"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  }`}
                >
                  <s.icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{s.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {ccas.length > 1 && (
          <p className="mt-2 px-1 text-xs text-gray-400">
            You head {ccas.length} CCAs.
          </p>
        )}
      </aside>

      <div className="min-w-0 flex-1">
        {/* Heading lives here rather than in each section so every section
            agrees on it and none has to re-derive the CCA's name. */}
        <header className="mb-5">
          <h1 className="text-2xl font-semibold text-gray-900">
            {current
              ? (current.ccaName ?? `Unknown CCA (#${ccaID})`)
              : `CCA #${ccaID}`}
          </h1>
          {current?.category && (
            <p className="mt-0.5 text-sm text-gray-500">{current.category}</p>
          )}
        </header>

        {children}
      </div>
    </div>
  );
}
