**Prerequisites:** `01-data-model.md` and `02-backend-authz.md` complete and deployed. Specifically `session.user.roles` must be populated by the session callback and `adminRouter` registered in `src/server/api/root.ts`, or nothing here compiles.

**Governing decisions:** D-2 (one dashboard, server-computed capability set), D-3 (a jcrc may NOT grant `jcrc`), D-1 (`resident` is the universal stored baseline — auto-granted, never assignable), D-8 (bulk is a first-class feature). This document is a **revision** of v1, not a replacement: everything in v1 that survived those four decisions is retained verbatim.

---

## 0. Ground truth — verified against the working tree

Re-verify each before starting; they are the assumptions the rest of the document rests on.

| # | Fact | Where |
|---|---|---|
| 1 | **No file under `src/app/` imports from `~/components/ui`.** All 45 shadcn primitives are installed with Radix deps present, but the app is hand-rolled Tailwind. This dashboard is the first consumer. `src/styles/globals.css` sets `--primary: 240 5.9% 10%` (near-black), so a default `<Button>` / `<Badge variant="default">` renders **black** against the app's emerald identity. Do **not** re-theme `globals.css`; pass explicit `className` at each admin call site. | `src/components/ui/`, `src/styles/globals.css` |
| 2 | **Dark mode is unwired.** A `.dark` block exists; nothing mounts a `ThemeProvider` (`next-themes` is a dep but unused). Build light-only. | `src/app/layout.tsx` |
| 3 | **`/admin` is NOT in `MatricGate.ALLOW_LIST`** (`["/onboarding","/login","/signup","/reset-password"]`). An admin with no `UserMatric` row is bounced to `/onboarding/matric`. This is correct — do not add `/admin` — but it looks like a broken guard during testing. See §12 for the triage table. | `src/app/_components/MatricGate.tsx:10` |
| 4 | **The root layout renders a `fixed bottom-0` footer.** `profile/page.tsx` compensates with `mb-14`. Admin pages must too, or the last table row sits under it — most visible here, because the user table is the tallest content in the app. | `src/app/layout.tsx` |
| 5 | **`command.tsx` (cmdk) is deliberately unused.** It filters an in-memory list client-side; shipping 515+ users to the browser is both a perf problem and a bulk email disclosure. Search is server-side. | — |
| 6 | **tRPC queries are sent as GET.** `src/trpc/react.tsx` uses `unstable_httpBatchStreamLink` with **no `methodOverride`**, so a `.query()` serializes its input into the querystring. Node/Vercel cap the request line around 8 KB. **A 1000-row CSV preview as a `.query()` 414s at roughly ten rows.** Every bulk procedure that accepts rows is therefore a `.mutation()`. | `src/trpc/react.tsx:50` |
| 7 | **No `maxDuration` is configured anywhere** (no `vercel.json`, nothing in `next.config`), so the tRPC route runs at Vercel's default ceiling. Bulk commit must be chunked small and the route must export `maxDuration`. | repo-wide |
| 8 | Available primitives include `table, dialog, alert-dialog, tabs, select, checkbox, radio-group, badge, progress, alert, accordion, popover, textarea, tooltip, scroll-area, skeleton, switch, card, input, button, separator`. `usehooks-ts`, `date-fns`, `lucide-react` are deps. **No new dependency is required by this document.** | `package.json`, `src/components/ui/` |
| 9 | No CSV parser is installed (no `papaparse`, no `csv-parse`). Parse client-side with a ~40-line RFC4180 subset. Do not add a dep. | `package.json` |
| 10 | `src/app/admin/` does not exist. `src/server/api/routers/admin.ts` does not exist. Everything here is greenfield. | — |

---

## 1. The capability set — D-2's central mechanism

v1 expressed authority as a hardcoded `isAdmin` ternary in **seven** independent places (`02-backend-authz.md:659-661`, `:750-758`; v1 doc 03 tabs, layout guards, nav label, `ManageRolesDialog`, bulk role options). D-2 replaces all seven with **one server-computed object**. The client never derives authority from a role string.

### 1.1 The shape

Extend `whoAmI` in `src/server/api/routers/admin.ts` (replaces `02-backend-authz.md:655-663` wholesale):

```ts
// src/server/api/services/capabilities.ts  (NEW)
import { ADMIN_ROLE, GRANTABLE_ROLES, assignableBy, revocableFromOthersBy } from "./roles";

export type Capabilities = {
  canReachAdmin: boolean;
  canListUsers: boolean;
  canManageRoles: boolean;
  canBulkImport: boolean;
  canUndoImport: boolean;
  canCreatePendingGrants: boolean;
  canViewAuditLog: boolean;
  canManageFacilityAccess: boolean;
  canViewSystemHealthCounts: boolean;
  canViewSystemHealthDetail: boolean;   // per-user identifier lists — admin only
  canExplainAccess: boolean;
  canManageAllowlist: boolean;          // see 02-backend-authz.md (D-7) — ADMIN ONLY, never jcrc
  canManageCcaHeads: boolean;           // see 07-cca-future.md
  canTouchAdminHolders: boolean;        // D-2: jcrc may not touch a user holding admin
  /** Roles this viewer may GRANT. D-3: jcrc gets ["cca_head"] only. */
  assignableRoles: string[];
  /** Roles this viewer may REVOKE from someone else. */
  revocableRoles: string[];
};

/**
 * ONE function. Derived from the viewer's LIVE roles, never from the session
 * copy (invariant I-5). Every field is a capability, not a role test — adding
 * a role later must not require touching any component.
 */
export function computeCapabilities(roles: readonly string[]): Capabilities {
  const isAdmin = roles.includes(ADMIN_ROLE);
  const isJcrc = roles.includes("jcrc");
  const manages = isAdmin || isJcrc;
  return {
    canReachAdmin: manages,
    canListUsers: manages,
    canManageRoles: manages,
    canBulkImport: manages,
    canUndoImport: manages,
    canCreatePendingGrants: manages,
    canViewAuditLog: isAdmin,
    canManageFacilityAccess: isAdmin,
    canViewSystemHealthCounts: manages,
    canViewSystemHealthDetail: isAdmin,
    canExplainAccess: manages,
    canManageAllowlist: isAdmin,
    canManageCcaHeads: manages,
    canTouchAdminHolders: isAdmin,
    assignableRoles: [...assignableBy(roles)],
    revocableRoles: [...revocableFromOthersBy(roles)],
  };
}
```

`assignableBy` / `revocableFromOthersBy` come from `ASSIGNABLE_BY` / `REVOCABLE_FROM_OTHERS_BY` in `src/server/api/services/roles.ts`. **Under D-3 both are `["cca_head"]` for a jcrc** — `jcrc` is admin-grantable only. `resident` is in **neither** map and is not in `GRANTABLE_ROLES` (D-1): it cannot be granted or revoked through any dashboard control, by anyone. That holds even though it is now a genuinely stored value — being stored makes it *visible* and *queryable* here, never *mutable* here (I-8e).

### 1.2 The rule the whole document obeys

> **No component may branch on a role string.** Every conditional render reads a boolean off `capabilities`. `grep -rn 'roles.includes\|isAdmin' src/app/admin/` must return **zero hits** outside `AdminCapabilityContext.tsx`.

This is a maintainability rule, not a security one. Security is §2's three layers.

### 1.3 Capability is advisory on the client, authoritative on the server

Every capability has an independent server guard (invariant I-7). The mapping is 1:1 and must be kept so:

| Capability | Server guard |
|---|---|
| `canReachAdmin` | `roleManagerProcedure` |
| `canManageRoles` | `assertCanMutateRoles` G1–G7 |
| `canBulkImport` / `canUndoImport` | `roleManagerProcedure` + per-row `assertCanMutateRoles` |
| `canViewAuditLog` | `adminProcedure` |
| `canManageFacilityAccess` | `adminProcedure` |
| `canViewSystemHealthDetail` | `adminProcedure` |
| `canManageAllowlist` | `adminProcedure` |
| `canTouchAdminHolders` | G3 target guard |

---

## 2. Three layers, only one of which is security

| Layer | File | Purpose | Security? |
|---|---|---|---|
| Nav link visibility | `src/app/_components/header.tsx` | don't show a link that redirects | no |
| Route guard | `src/app/admin/layout.tsx` (RSC) | clean redirect before any admin HTML streams | defence in depth |
| Procedure guard | `adminProcedure` / `roleManagerProcedure` + G1–G7 | authoritative | **yes** |

The layout guard is not sufficient alone: a client can call `api.admin.setUserRoles.mutate()` from the console on any page. Every affordance below has an independent server check.

---

## 3. Step 1 — Route structure

```
src/app/admin/
├── layout.tsx                        # RSC guard (canReachAdmin) + <AdminShell>
├── page.tsx                          # overview: stat cards + health panel
├── loading.tsx                       # segment Suspense fallback
├── error.tsx                         # "use client" error boundary
├── users/page.tsx                    # role management — the main surface
├── bulk/page.tsx                     # D-8: import wizard + history + pending
├── audit/
│   ├── layout.tsx                    # RSC guard: capabilities.canViewAuditLog
│   └── page.tsx
├── facilities/
│   ├── layout.tsx                    # RSC guard: capabilities.canManageFacilityAccess
│   └── page.tsx
└── _components/
    ├── AdminShell.tsx                # "use client" — tab strip
    ├── AdminCapabilityContext.tsx    # "use client" — THE only place capabilities are read from
    ├── RoleBadge.tsx
    ├── AdminStatCard.tsx
    ├── EmptyState.tsx
    ├── users/
    │   ├── UserRoleTable.tsx
    │   ├── UserRoleRow.tsx
    │   └── ManageRolesDialog.tsx
    ├── bulk/
    │   ├── BulkImportWizard.tsx      # owns step state + batchId + planToken
    │   ├── BulkInputStep.tsx
    │   ├── CsvColumnMapper.tsx
    │   ├── BulkPreviewTable.tsx
    │   ├── AmbiguityPopover.tsx
    │   ├── BulkCommitProgress.tsx
    │   ├── BulkImportHistory.tsx
    │   ├── BulkImportDetail.tsx
    │   └── PendingGrantsPanel.tsx
    ├── audit/AuditLogTable.tsx
    ├── facilities/FacilityAccessTable.tsx
    └── health/SystemHealthPanel.tsx
└── _lib/
    ├── csv.ts                        # RFC4180 subset parser, no dep
    └── planClient.ts                 # chunking, resume, progress
```

`_components/` and `_lib/` under the route follow the repo's existing underscore convention and keep admin-only code out of the shared bundle. The underscore means Next never routes it.

> **RULE: every segment whose tab requires a capability MUST ship a sibling `layout.tsx` guard in the same commit as the folder.** A hidden tab is not a guard — a jcrc typing `/admin/audit` would otherwise render the accountability record of their own actions.

---

## 4. Step 2 — `src/app/admin/layout.tsx`

```tsx
import { redirect } from "next/navigation";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/capabilities";
import AdminShell from "./_components/AdminShell";

export const dynamic = "force-dynamic"; // session-dependent; never static/ISR

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  let roles: string[] = [];
  try {
    // LIVE DB read, not session.user.roles (invariant I-5). This layout is the
    // last line of defence before admin markup streams.
    roles = await getUserRoles(db, session.user.userID);
  } catch {
    // Fail CLOSED. A segment's own error.tsx does NOT catch errors thrown by
    // that segment's layout.tsx, and src/app/layout.tsx has no boundary — an
    // Atlas hiccup here would otherwise blank the whole app shell.
    redirect("/");
  }

  const capabilities = computeCapabilities(roles);
  // redirect("/"), not a 403: an unauthorised user should not learn /admin exists.
  if (!capabilities.canReachAdmin) redirect("/");

  return <AdminShell capabilities={capabilities}>{children}</AdminShell>;
}
```

`src/app/admin/audit/layout.tsx` and `src/app/admin/facilities/layout.tsx` are the same shape, ending in `if (!capabilities.canViewAuditLog) redirect("/admin");` and `if (!capabilities.canManageFacilityAccess) redirect("/admin");` respectively. **Note they recompute from a live `getUserRoles` read — they do not receive capabilities as a prop**, because a prop from a parent layout is not a guard.

All page data comes through `adminProcedure` / `roleManagerProcedure`. **Never call `db.*` directly from an RSC page body** — that path is covered by no procedure guard.

Also add a root `src/app/error.tsx` (`"use client"`, with `reset()`): there is currently no boundary above the admin segment.

---

## 5. Step 3 — `AdminCapabilityContext` and `AdminShell`

```tsx
// src/app/admin/_components/AdminCapabilityContext.tsx
"use client";
import { createContext, useContext } from "react";
import type { Capabilities } from "~/server/api/services/capabilities";

const Ctx = createContext<Capabilities | null>(null);

export function AdminCapabilityProvider({ value, children }:
  { value: Capabilities; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * THE only place in src/app/admin/ that may inspect authority. Everything else
 * reads a named boolean. See 03 §1.2.
 */
export function useCapabilities(): Capabilities {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCapabilities outside AdminCapabilityProvider");
  return v;
}
```

```tsx
// src/app/admin/_components/AdminShell.tsx
"use client";
import Header from "~/app/_components/header";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, ScrollText, LayoutDashboard, DoorOpen, Upload } from "lucide-react";
import { AdminCapabilityProvider } from "./AdminCapabilityContext";
import type { Capabilities } from "~/server/api/services/capabilities";

/**
 * Adding a future admin feature = one entry here + one folder + one capability.
 * `requires` names a CAPABILITY, never a role (decision D-2). It controls
 * RENDERING ONLY — the segment MUST also ship its own layout.tsx guard (§3).
 */
const ADMIN_TABS = [
  { href: "/admin",            label: "Overview",   icon: LayoutDashboard, requires: "canReachAdmin" },
  { href: "/admin/users",      label: "Users",      icon: Users,           requires: "canListUsers" },
  { href: "/admin/bulk",       label: "Bulk",       icon: Upload,          requires: "canBulkImport" },
  { href: "/admin/facilities", label: "Facilities", icon: DoorOpen,        requires: "canManageFacilityAccess" },
  { href: "/admin/audit",      label: "Audit log",  icon: ScrollText,      requires: "canViewAuditLog" },
] as const satisfies readonly { href: string; label: string; icon: unknown; requires: keyof Capabilities }[];

export default function AdminShell({ capabilities, children }:
  { capabilities: Capabilities; children: React.ReactNode }) {
  const pathname = usePathname();
  const tabs = ADMIN_TABS.filter((t) => capabilities[t.requires] === true);

  return (
    <AdminCapabilityProvider value={capabilities}>
      <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
        {/* D-2: ONE dashboard, ONE label. v1's isAdmin ? "Admin" : "Roles"
            fork is removed — admin and jcrc see the same screen. */}
        <Header currentPage="Admin" />
        <nav className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-7xl gap-6 overflow-x-auto px-4 sm:px-6 lg:px-8">
            {tabs.map((t) => {
              const active = pathname === t.href;
              return (
                <Link key={t.href} href={t.href}
                  className={`flex items-center gap-2 whitespace-nowrap border-b-2 py-4 text-sm font-medium ${
                    active ? "border-emerald-600 text-emerald-700"
                           : "border-transparent text-gray-500 hover:text-gray-700"}`}>
                  <t.icon className="h-4 w-4" />{t.label}
                </Link>
              );
            })}
          </div>
        </nav>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </div>
    </AdminCapabilityProvider>
  );
}
```

`mb-14` on the outer div is the footer-collision fix (ground truth 4). `overflow-x-auto` on the tab strip is new: five tabs no longer fit on a 375 px viewport.

The CCA tab from `07-cca-future.md` slots in as one more entry with `requires: "canManageCcaHeads"` — no other change to this file.

---

## 6. Step 4 — Header nav link

`src/app/_components/header.tsx` already calls `useSession()`. Replace the static `navLinks` array (line ~30):

```tsx
import { ShieldCheck } from "lucide-react";   // add to the existing lucide import

const roles = session?.user?.roles ?? [];
// Cosmetic only. The route guard in §4 is the real gate. Kept as a role test
// (not a capability) ONLY because header.tsx sits outside the admin bundle and
// must not import the capability module; it is the single sanctioned exception
// to §1.2 and is commented as such at the call site.
const canReachAdmin = roles.includes("admin") || roles.includes("jcrc");

const navLinks = [
  { name: "Home", href: "/", icon: Home },
  { name: "My Bookings", href: "/bookings", icon: Calendar },
  ...(canReachAdmin ? [{ name: "Admin", href: "/admin", icon: ShieldCheck }] : []),
];
```

**Also fix the pre-existing active-state bug while here.** Desktop calls `isActive(link.name)`, mobile calls `isActive(link.href)`, and callers pass values like `currentPage="profile"` matching neither — mobile highlighting is already broken. The clean fix, since the component is already `"use client"`: delete the `currentPage` prop entirely and derive active state from `usePathname()` against `link.href` in both places. That touches every caller (`src/app/page.tsx`, `bookings/`, `profile/`), so do it as its own commit before the admin work.

---

## 7. Step 5 — `RoleBadge`, and how `resident` renders

```tsx
// src/app/admin/_components/RoleBadge.tsx
import { Badge } from "~/components/ui/badge";

const ROLE_STYLES: Record<string, { label: string; cls: string; title?: string }> = {
  admin:     { label: "Admin",    cls: "bg-red-100 text-red-800 border-red-300 hover:bg-red-100" },
  jcrc:      { label: "JCRC",     cls: "bg-emerald-100 text-emerald-800 border-emerald-300 hover:bg-emerald-100" },
  cca_head:  { label: "CCA Head", cls: "bg-blue-100 text-blue-800 border-blue-300 hover:bg-blue-100" },
  // D-1: STORED, auto-granted at account creation to every verified @u.nus.edu
  // identity and self-healed at session read (I-8a/I-8b). Never granted or
  // revoked through this UI. Rendered muted so it reads as a fact, not a grant.
  resident:  { label: "Resident", cls: "bg-gray-100 text-gray-600 border-gray-300",
               title: "Automatic for every verified NUS account. Cannot be granted or removed here." },
};

export default function RoleBadge({ role }: { role: string }) {
  // Unknown roles render neutrally rather than vanishing: a role added by a
  // script must be visible without a code change.
  const s = ROLE_STYLES[role] ?? { label: role, cls: "bg-gray-100 text-gray-600 border-gray-300" };
  return <Badge variant="outline" className={s.cls} title={s.title}>{s.label}</Badge>;
}
```

`variant="outline"` is the neutral base (no background), sidestepping the black `--primary` default entirely; `className` supplies all colour. Red for admin is intentional — the highest privilege should look alarming in a list.

**D-1 consequence — the v1 fallback is inverted.** v1's profile page rendered "Resident" as the *fallback for zero roles*. Under D-1, `resident` is a real **stored** entry in the roles array and zero roles means *cannot book anything*. A user row with an empty roles array must render an amber `<Badge>` reading **"No access"** with the tooltip *"This account cannot book any facility. Check `/admin` → Overview → health."* — never a reassuring "Resident". The same rule applies in `04-profile-page.md`.

**Render the stored value, never a synthesised one.** Because `resident` is stored rather than derived, the badge row for a user is exactly `row.roles.map(<RoleBadge/>)` — the table must **not** append a "Resident" badge because the account looks eligible. Doing so would paper over precisely the gap the health panel exists to surface (§11.1), and the users table would report a booking-blocked account as healthy.

**Missing baseline is an anomaly, and it renders as one.** `listUsers` returns `missingBaseline: boolean` per row — true when the account's email is NUS-eligible (the shared predicate in `src/lib/identity.ts`, I-12; **never** an E-format regex, L-27) but the stored `roles` array does not contain `resident`. Such a row renders an amber warning icon beside the roles cell with the tooltip *"This account should hold the Resident baseline but does not. It will repair itself at their next sign-in; if it persists, see Overview → health."* — the same visual language as `keyMismatch`. This is a **live lockout indicator**, not a materialisation gap: under the stored design the user genuinely cannot book until the row is repaired. Compute `missingBaseline` server-side in `listUsers`; a client-side eligibility guess would drift from the predicate.

---

## 8. Step 6 — `UserRoleTable`

Columns: **Name | User ID (NUSNET) | Email | Roles | Actions**.

```tsx
const [rawSearch, setRawSearch] = useState("");
const search = useDebounce(rawSearch, 300);          // usehooks-ts, already a dep
const [roleFilter, setRoleFilter] = useState<string>("all");

const { data, isLoading, isError, fetchNextPage, hasNextPage, refetch } =
  api.admin.listUsers.useInfiniteQuery(
    { search, role: roleFilter === "all" ? undefined : roleFilter, limit: 25 },
    { getNextPageParam: (last) => last.nextCursor, placeholderData: (prev) => prev },
  );
```

`placeholderData: (prev) => prev` (react-query v5 spelling; `keepPreviousData` was removed) keeps rows visible so the table does not flash empty on every keystroke.

**The `keyMismatch` column.** `listUsers` returns `canonicalUserID` and `legacyUserID` separately. Display `canonicalUserID`, label the column "User ID (NUSNET)", and when `keyMismatch` is true render a small amber warning icon with a tooltip: *"This account's stored ID differs from its NUSNET ID. Roles are keyed on the NUSNET ID shown."* This makes invariant I-1's failure mode visible instead of mysterious.

**Mutations submit `canonicalUserID`, never `legacyUserID`.** Put that in a comment at every call site.

**Admin confidentiality (D-2).** For a viewer without `canTouchAdminHolders`, the server redacts `admin` from the returned `roles` array and sets `isProtected: true` on the row. The client renders a lock icon and disables the Manage action with the tooltip *"This user's roles can only be changed by an administrator."* — it never learns *why*. Do this server-side in `listUsers`; a client-side filter is a disclosure.

The role filter `<Select>` offers `all` plus the viewer's `capabilities.assignableRoles` **and** `capabilities.revocableRoles` unioned, plus `resident` (read-only filter — it can be filtered on but never granted here). `admin` appears as a filter option **only** when `canTouchAdminHolders` is true.

Because `resident` is stored, that filter is a **genuine server-side query** — `{ roles: "resident" }` against `UserRole`, the same indexed path as every other role — not a client-side re-derivation of who *looks* eligible. Its inverse is the operationally useful one: a `missing_resident` pseudo-option filters to eligible accounts whose stored roles omit the baseline, i.e. the rows carrying the §7 anomaly icon. That population is now **actionable** rather than a display artefact — each row is a user who cannot book, and the fix is a sign-in (self-heal) or a backfill re-run (`01-data-model.md` Step 12). It should normally be empty; if it is not, do not flip enforcement (§11.1).

States:

| State | Treatment |
|---|---|
| loading | 8 `<Skeleton>` rows inside real `<TableRow>/<TableCell>` — preserves column widths so the header doesn't jump |
| refetching | rows persist; small spinning `<Loader>` beside the search input |
| no users | `<EmptyState>` in a `colSpan={5}` cell |
| search empty | "No users match *{search}*." + "Clear search" ghost button |
| role filter empty | "No users have the {role} role yet." + "Assign the first one" → links to `/admin/bulk` |
| query error | `<Alert variant="destructive">` + "Retry" calling `refetch()` |

---

## 9. Step 7 — `ManageRolesDialog`

Sends the **desired final role set**, not a delta — idempotent, double-submit-safe, and lets the server diff for precise audit entries.

```tsx
const cap = useCapabilities();
const isSelf = target.canonicalUserID === session?.user?.userID;
```

**Which rows render, and how:**

| Role | Rendered as |
|---|---|
| `resident` | **read-only `<RoleBadge>`, never a `<Switch>`** (D-1). It is not in the payload **and** the server's write cannot express its removal (I-8c: `applyRoleChange` removes only `removed ⊆ GRANTABLE_ROLES`, which excludes `resident`). Either alone would be insufficient — the UI is cosmetic (I-7), so the omission from this dialog is copy consistency and the server-side chokepoint is the mechanism. If the target is eligible but does **not** hold the baseline, render the §7 anomaly icon here too rather than the badge; do not offer a control to add it. |
| role ∈ `cap.assignableRoles` ∪ `cap.revocableRoles` | `<Switch>` |
| any other grantable role | `<Switch disabled>` + tooltip naming who can change it |

**The payload is a delta the server cannot over-apply.** The client sends only the grantable subset. The server does **not** "union back" anything — it never removes what it cannot name: `applyRoleChange` writes a `$pull` of exactly the roles the guards authorised removing (a subset of `GRANTABLE_ROLES`) and an `$addToSet` of exactly the roles they authorised adding, so a non-grantable role such as `resident` is not *filtered out* of the removal set, it is **incapable of entering it**. A dialog that cannot express a role therefore cannot remove it, and neither can a hand-crafted payload. The assertion site is `applyRoleChange` in `02-backend-authz.md`, not this component.

| Condition | UI |
|---|---|
| `!cap.assignableRoles.includes("admin")`, `admin` row | `<Switch disabled>` + tooltip "Only admins can grant or revoke the admin role" |
| `!cap.assignableRoles.includes("jcrc")`, `jcrc` row | `<Switch disabled>` + tooltip **"Only an admin can grant or remove the JCRC role."** — **D-3: this now covers the GRANT direction too.** v1's copy covered removal only. |
| `!cap.canTouchAdminHolders` and target holds admin | whole dialog read-only + `<Alert>` "This user is an administrator. Only another admin can change their roles." (reachable only if the row was not already redacted) |
| admin toggling own `admin` off | `<AlertDialog>` confirm, then the server rejects with `CANNOT_SELF_REVOKE_ADMIN` |
| last admin | server returns `PRECONDITION_FAILED / CANNOT_REMOVE_LAST_ADMIN`; render inline |
| jcrc revoking own `jcrc` (step down) | permitted. Add a warning in the confirm dialog: **"No other JCRC member can restore this. Only an administrator can."** (a D-3 consequence v1 did not surface) |

Do **not** compute the last-admin check client-side — the client does not have the full user list.

```ts
const utils = api.useUtils();
const setRoles = api.admin.setUserRoles.useMutation({
  onSuccess: async () => {
    await utils.admin.listUsers.invalidate();
    onClose(); showToast("Roles updated", "success");
  },
  onError: (e) => setFormError(e.message),   // inline; dialog STAYS OPEN
});
```

Optional `<Textarea>` reason, 500 chars, stored on the audit row. Optional because forcing a reason on every toggle makes people type "x". Disable Save while `isPending`.

---

## 10. Step 8 — Bulk import (D-8), the largest new surface

v1's `BulkAssignDialog` was paste-only, single-role, E-format-only, with no undo and no deferred grants. It is **replaced** by a wizard at `/admin/bulk`. Server contract lives in `02-backend-authz.md`; this section specifies the client and the interaction rules that are load-bearing for security.

### 10.1 Wizard shape

```
<BulkImportWizard>                    Tabs value = step, owns { batchId, planToken }
 ├─ step "input"  <BulkInputStep>
 │    ├─ <Tabs> Paste | CSV
 │    │    ├─ Paste: <Textarea> → split /[\s,;]+/ → one `identifier` column
 │    │    └─ CSV:   <Input type="file" accept=".csv,text/csv">
 │    │              → _lib/csv.ts → <CsvColumnMapper>
 │    │                   <Table> first 5 rows; each header cell is a <Select>
 │    │                   mapping to identifier|email|nusnet|matric|name|block|roles|ignore
 │    │                   auto-guessed from header text, always operator-overridable
 │    ├─ <Select multiple> default roles  — options are cap.assignableRoles ONLY.
 │    │     `admin` is ABSENT (not disabled) for a jcrc: do not leak the ladder.
 │    │     `resident` is never an option (D-1).
 │    ├─ <RadioGroup> mode: "Add roles" (default) | "Replace roles"
 │    │     Replace shows <Alert variant="destructive"> naming what it removes and
 │    │     stating that `resident` is preserved regardless — the server cannot
 │    │     express its removal, so this is a statement of fact (§10.4).
 │    └─ <Button> Preview — disabled at 0 rows or >1000 rows
 │
 ├─ step "review" <BulkPreviewTable>
 └─ step "commit" <BulkCommitProgress>
```

### 10.2 Preview is a **mutation**, and returns a signed plan token

Two non-negotiable constraints, both from ground truth:

1. **`previewBulkImport` is a `.mutation()`, not a `.query()`** (ground truth 6). A 1000-row CSV as a query 414s. The "it cannot accidentally mutate" property v1 wanted from `.query()` is preserved structurally instead: the procedure body opens no transaction and passes `dryRun: true` to every guard.
2. **The response carries a `planToken`** — an HMAC over `{ batchId, actorUserID, rows: [{ userID, rolesAfter, via, confidence }] }` with a short TTL. `commitBulkChunk` requires it and rejects any row whose tuple is not in the signed plan.

Without (2) the "name-matched rows need explicit confirmation" rule is a client-side boolean the server cannot verify, and a caller posting straight to `commitBulkChunk` with `confirmed: true` commits every low-confidence guess. That would violate I-7 on the single most damaging surface in the dashboard.

### 10.3 The preview table

```
<Alert> summary line:
  "412 grant · 38 no-op · 11 pending · 6 ambiguous · 3 denied · 2 unresolved"

<Accordion> one section per status; actionable statuses expanded by default.
  <Table> ☐ | Line | Person | Identifier | Current roles | After | Action
```

| Status | Checkbox default | Meaning |
|---|---|---|
| `grant` | ✅ checked | roles will be added |
| `noop` | checked, greyed | already holds every requested role |
| `revoke` | ✅ checked | replace-mode removes at least one role |
| `pending` | ✅ checked | no account yet → a `PendingRoleGrant` is created |
| `ambiguous` | ☐ **disabled until resolved** | `<AmbiguityPopover>` with a `<RadioGroup>` of candidates (name · block · masked email); choosing re-runs preview with `disambiguations[lineNo]` |
| `needs_confirm` | ☐ **unchecked by default** | name-matched, low confidence. Operator must tick each one individually |
| `duplicate` | ☐ disabled | an earlier line already resolved to this userID; note names the winning line |
| `denied` | ☐ disabled | an escalation guard would refuse; `denyReason` in a `<Tooltip>` |
| `unresolved` | ☐ disabled | listed **verbatim** so typos are fixable |
| `at_risk` | ✅ checked, amber | last-admin guard may still refuse at commit |

Column rendering: **Person** = displayName + block + email (muted). **Current** = `<RoleBadge>` per role. **After** = badges with `+` / `−` prefixes, removals in amber.

**Bulk-tick is deliberately not offered for `needs_confirm`.** A "select all" checkbox on a name-matched section defeats the only gate standing between a fuzzy name match and a role grant. There is no "confirm all" button on that section; there is on every other.

**PII containment for jcrc viewers.** `previewBulkImport` accepts up to 1000 operator-supplied identifiers and returns each match's identity and role set — a directory-export primitive. For a viewer without `canTouchAdminHolders`, the server must: redact `admin` from `rolesBefore`/`rolesAfter` and return such rows as `denied / CANNOT_MODIFY_AN_ADMIN` with no role enumeration; mask `email` (first char + domain) for any row where the operator did not themselves supply the email; and rate-limit previews per actor per hour. These are server-side rules restated here so the UI is built expecting masked data.

Confirm step: `<AlertDialog>` reading **"Apply to {n} users? {m} rows will be skipped."** The confirm button label carries the literal count and is disabled at 0.

### 10.4 Sticky roles (UI copy; the mechanism is server-side)

Replace-mode never removes a role the payload cannot express, and **that guarantee does not live in this file.** Every bulk row — add mode, replace mode and undo alike — is applied by the same per-row `assertCanMutateRoles` → `applyRoleChange` pair as a single dialog save (`02-backend-authz.md` §8: guards apply per row, never per batch). That write is a `$pull` of the authorised `removed` set plus an `$addToSet` of the authorised `added` set, and `removed ⊆ GRANTABLE_ROLES`, which excludes `resident`. **There is no second write path and no set-payload anywhere on the bulk surface**, so a replace-mode import of 1000 rows cannot strip the baseline from anyone even if this client is bypassed entirely. `resident` is currently the only sticky role — `suspended` was **cut from this revision** (`00-overview.md` §3.4, `05-verification.md` §11); if a sanction is ever added it becomes its own affirmative collection, not a role in this list.

The helper below exists **only so the preview's `After` column matches what the server will actually do.** It is not the enforcement and cannot be defeated by editing this file:

```ts
// src/app/admin/_lib/planClient.ts — PREVIEW RENDERING ONLY.
// Enforcement is applyRoleChange (02-backend-authz.md); see I-8c. Editing this
// file makes the preview wrong, never the write.
import { STICKY } from "~/server/api/services/roles";   // imported, NEVER redeclared —
                                                        // a local copy is how the two drift
function computeAfter(before: string[], requested: string[], mode: "add" | "set") {
  if (mode === "add") return [...new Set([...before, ...requested])];
  return [...new Set([...requested, ...STICKY.filter((r) => before.includes(r))])];
}
```

Note the consequence of the delta write for the preview: an `After` column that omits a role the server cannot remove is a **preview bug**, and it will be visible as a mismatch between the previewed `After` and the committed `rolesAfter` in the audit log. Treat any such mismatch as a defect in this helper, never as a reason to make the server honour the payload verbatim.

The replace-mode `<Alert>` says so in words. Undo (§10.6) routes through the same helper for display — but its safety comes from the same server chokepoint, so reversing a batch whose `rolesBefore` was `[]` cannot strip `resident` from every target even if the helper is skipped.

### 10.5 Commit — chunked, resumable, per-row

```ts
// src/app/admin/_lib/planClient.ts
const CHUNK = 25;   // ~25 rows x ~300ms/row ≈ 7.5s, inside Vercel's ceiling
```

Sizing, stated so it can be re-derived: each row costs roughly 5 Atlas round-trips (role read, guard read, transaction, audit write) at ~60 ms ≈ 300 ms. v1's 100-row chunk is ~30 s and times out. **Also add `export const maxDuration = 60;` to `src/app/api/trpc/[trpc]/route.ts`** (ground truth 7) and re-measure with a real 500-row import before the JCRC onboarding.

Sequence:

1. `beginBulkImport({ mode, totalRows, note })` → `{ batchId }`.
2. Loop chunks of ≤25 through `commitBulkChunk({ batchId, planToken, rows, mode })`.
3. Each response returns `results[]` with `{ lineNo, userID, ok, error?, rolesAfter? }` **and** `lastProcessedLineNo`, so a truncated chunk resumes rather than being retried blind (a blind retry hits `CONFLICT_ROLES_CHANGED` on already-applied rows and reports them as failures).
4. `finishBulkImport({ batchId })` — **input is `batchId` only**. Tallies are computed server-side from `RoleAuditLog`; client-supplied counts would make the reviewable header untrustworthy, which is the one thing the header exists for.

`<BulkCommitProgress>` renders a `<Progress>` bar (chunk k of n), a live `<Table>` of **failures only** (successes collapse to a count), and on finish two buttons: "View in audit log" and "Undo this import". Toast via the existing `Toast.tsx`, then `utils.admin.listUsers.invalidate()`.

Per-row failure is the expected outcome, not an error condition. A jcrc's import containing an admin returns `CANNOT_MODIFY_AN_ADMIN` on that row and succeeds on the other 24.

### 10.6 Undo

`<BulkImportHistory>` — `<Table>`: **When | By | Mode | Rows | Granted | Failed | Pending | Status**. Status `<Badge>`: Complete / Incomplete / Undone / Undo. Row click opens `<Dialog><BulkImportDetail>` with the per-row audit entries.

Undo is a normal guarded role change, not a privileged rollback:

- It gets its own `batchId` and its own audit rows. The log is append-only; undo never deletes history.
- Reversal reads `RoleAuditLog where { batchId, ok: true, action: { in: ["set", "pending.claim"] } }` and replays in **descending** order. Including `pending.claim` is essential: a deferred grant already claimed at login is otherwise invisible to undo, and escalation would survive its own rollback.
- Rows whose current roles differ from the audit row's `rolesAfter` are **skipped** as `DIVERGED_SINCE_IMPORT`, not overridden. Silently reverting a later deliberate change is worse than a partial undo.
- The target set passes through `computeAfter(..., "set")` so sticky roles survive **in the preview**; the server-side chokepoint (§10.4) makes the sticky guarantee independent of this client helper — undo runs the same `$pull`/`$addToSet` write, so `resident` survives an undo whether or not the helper was applied.
- Guards run per row, so a jcrc cannot undo an admin's import that granted `admin` — that row reports `CANNOT_GRANT_ADMIN` as skipped.

Confirm copy: **"Reverse {n} role changes? Users whose roles changed since the import will be left alone."**

### 10.7 Pending / deferred grants

`<PendingGrantsPanel>` on the same page — `<Table>`: **NUSNET id | Roles | Created by | Created | Expires | —**.

Rules the UI must reflect (all enforced server-side):

- A pending grant is keyed on a **canonical E-format userID only**, derived from an explicit `@u.nus.edu` email or a bare NUSNET id — **never** a matric (`UserMatric.matric` is self-asserted, `src/server/api/routers/user.ts:85-99`) and **never** a name. The panel says so in a `<p className="text-sm text-gray-500">` under the heading.
- `resident` can never be deferred: it is granted automatically at account creation and topped up at session read (I-8a/I-8b), so a deferred grant for it would be both unrepresentable and pointless.
- `jcrc` may be deferred by an **admin only** (D-3). `admin` may be deferred by an admin only, requires a reason, and is capped at 14 days.
- Expiry `<Badge>`: emerald >30 d, amber ≤7 d, red expired.
- Three non-obvious states, each with distinct copy:
  - **expired, never claimed** — the roster person never signed up.
  - **stranded** — the target has since signed up and passed first login, so the one-shot claim will never fire. Offer a one-click "Apply now" that runs the normal guarded grant path.
  - **claimed** — not shown here; it is a real role row and appears in the users table.
- `<Alert>` at the top when any row is expired or within 7 days of expiring.
- Actions: per-row "Revoke" (`revokePendingGrant`, guarded by `cap.revocableRoles`); "Purge expired" visible only when `cap.canManageAllowlist`-equivalent admin capability is present (`purgeExpiredPendingGrants` is `adminProcedure`).

There is no scheduler in this repo, so expiry is lazy: the claim path ignores expired rows and the purge is manual. Do not build a cron for this.

### 10.8 The dirty-input test

Test with a deliberately dirty paste. All **nine** cases must land in the right bucket (v1 had five):

valid E-id · nonexistent E-id · lowercase E-id · A-format matric with one match · A-format matric with two matches · a name with one match · a name with two matches · an `@gmail.com` address · a duplicate line.

---

## 11. Step 9 — Overview page

Four `AdminStatCard`s in `grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4`, from one `admin.getStats` call: **Total users · Residents · JCRC · CCA heads**, plus **Admins** when the caller is an admin.

`getStats` returns `admins: null` for a caller without `canTouchAdminHolders`, so the card is omitted **server-side**, not hidden in the component. Do not hand a jcrc an enumeration of who holds admin (D-2).

For the same reason, the "Recent role changes" feed renders only when `cap.canViewAuditLog` — it draws from `listAuditLog`, which is `adminProcedure`.

Cards use `~/components/ui/card` styled like the profile page (`rounded-xl bg-white p-6 shadow-lg`) so the dashboard reads as the same product.

### 11.1 `SystemHealthPanel` — the D-1 lockout detector, surfaced

This is the UI half of the `rbac-doctor` check specified in `02-backend-authz.md`. It is what turns a silent lockout into a visible one.

```
Enforcement mode ....................... permissive     ← from SystemFlag
Users eligible for resident ............ 515
  MISSING the resident baseline ........ 0              ← RED. live lockouts.
Users with NO roles at all ............. 0              ← "No access" population
Facilities ............................. 12
  UNCONFIGURED (defaulting to resident)  0              ← the one to watch
Shadow denials, last 24h ............... 0              ← go/no-go for enforce
Pending grants outstanding ............. 11
  expired ............................... 2
```

**Split by capability, and this split is a security requirement, not a nicety.** `canViewSystemHealthCounts` (admin + jcrc) returns **aggregate counts only**. `canViewSystemHealthDetail` (admin only) returns the per-user identifier lists — ineligible accounts, canonical-id collisions from merged accounts, rows missing `passwordHash`. Those are account-integrity disclosures about named individuals and must not reach a jcrc.

**`MISSING the resident baseline` is the panel's one red tile, and it blocks the enforcement flip.** It is the UI half of the `rbac-doctor` red line and of the standing daily query in `05-verification.md` §7, sourced from the same query: `User` rows whose email satisfies the shared NUS predicate (`src/lib/identity.ts`, I-12 — **never** an E-format regex, L-27) whose canonical `UserRole` document lacks `resident`. Under the stored design a non-zero value is **not** a materialisation gap, it is a set of users who cannot book right now. Render it red, not amber, and state the rule in the panel: *"Do not switch enforcement to `enforce` while this is non-zero."* Scope the query to NUS-emailed rows only — a tile that counts the collection's known non-NUS accounts can never reach zero and will be ignored, which deletes the detector (I-16 corollary).

Per-capability split applies here as everywhere: a jcrc sees the **count**, an admin sees the identifier list (`canViewSystemHealthDetail`). The list is the input to the remedy — those users self-heal at their next sign-in, and anyone who does not is a genuine `UserRole` write failure to be re-run through the backfill (`01-data-model.md` Step 12).

Non-zero **UNCONFIGURED** renders an amber `<Alert>` with a link to `/admin/facilities`: *"{n} facilities have no access rule and default to residents-only. Configure them."*

`explainAccess({ userID, facilityID })` is exposed as a small form at the bottom of this panel, gated on `cap.canExplainAccess`. It runs the booking evaluation **as the target** and returns the full decision, letting an admin see a non-admin outcome without holding a non-admin session (the admin-bypass blind spot). It is an enumeration primitive over the whole user base, so **every call is audited with caller and target**.

---

## 12. Step 10 — Audit log page

Gated on `cap.canViewAuditLog` (admin only), with its own `layout.tsx`.

`<Table>`: **When | Actor | Action | Target | Before → After | Reason**.

- `action` as a `<Badge>`: `grant`/`set` emerald, `revoke` amber, `denied` red, `pending.*` blue, `booking.denied.shadow` grey.
- **Batch grouping is the headline feature.** Rows sharing a `batchId` collapse into one `<Accordion>` item reading *"Bulk import · 412 rows · by E1633673 · 2 Aug"*, expanding to the per-row detail. A 500-person import is one entry, not 500 buried rows. Without this the log is unusable the day D-8 ships.
- Filters: actor, target, action, date range, and `batchId` (deep-linkable from the bulk history page).
- Timestamps via `date-fns`: `formatDistanceToNow` under 7 days, absolute beyond. Cursor-paginated on `at` desc.

**Read-only. No delete, no edit control anywhere.** An editable audit log is not an audit log.

Day-one empty state is "No role changes recorded yet" — correct, not an error. (After `01-data-model.md` it already contains the seed rows.)

### 12.1 Denial triage table — render it on this page

Several distinct failures present identically to a user ("I can't book"). Put this table in a `<Accordion>` under the log so whoever is on support has it in front of them:

| Error code | Cause | Fix |
|---|---|---|
| `MATRIC_REQUIRED` | no `UserMatric` row; `MatricGate` bounced them | they complete `/onboarding/matric` — **not a role problem** |
| `NOT_RESIDENT` (ineligible) | canonical userID retains an `@`, i.e. not a verified NUS address | check the health panel's ineligible list; the account needs its email corrected or merged. **The baseline is correctly absent — this is not a bug** |
| `NOT_RESIDENT` (eligible but missing the stored baseline) | NUS-eligible account whose `UserRole` row lacks `resident` — a failed grant write, a missed backfill, or a manual DB edit | it should have self-healed at sign-in; have them reload. If it persists, the `UserRole` write is failing — check `baseline_repair_failed` in the logs and re-run the backfill. Appears in the health panel's **red** MISSING tile and as the §7 anomaly icon |
| `ROLE_REQUIRED` | genuine gated-room attempt | grant the role, or tell them no |
| `SUSPENDED` | affirmative sanction | admin lifts it |
| `CONFLICT_ROLES_CHANGED` | bulk row skipped; target changed between preview and commit | re-run the preview |

---

## 13. Step 11 — Facilities page

Gated on `cap.canManageFacilityAccess` (admin only), with its own `layout.tsx`. Admin-only by construction: a jcrc with access here could re-gate every room behind `jcrc`, or un-gate SCRC — the exact control this project exists to enforce.

`FacilityAccessTable` over `listFacilityAccess`: facility name, `facilityID`, current `requiredRoles` as badges, and a multi-select editor calling `setFacilityAccess`.

**D-1 inverts v1's copy here, and this is the single highest-risk string in the document.** v1 said the empty state "must read *Open to everyone*". That is now **wrong and dangerous**:

| State | Copy |
|---|---|
| no `FacilityAccess` row | **"Not configured — defaults to Residents only"** + amber dot. Never "open". |
| `requiredRoles: ["resident"]` | **"Residents only"** — this is a normal room, the common case |
| `requiredRoles: ["jcrc"]` | "JCRC only" |
| `requiredRoles: ["cca_head"]` | "CCA heads only" |

There is **no "open to everyone" state any more.** Remove that string from the codebase.

The role picker uses a **second, distinct enum**: `FACILITY_ROLES = ["resident", "jcrc", "cca_head"]`. It is not `GRANTABLE_ROLES`:

- `resident` **must** be selectable — the seed writes an explicit `["resident"]` row for every normal facility, and a dashboard that cannot round-trip its own seeded state is broken.
- `admin` **must not** be selectable — it is an implicit bypass and is never stored in `requiredRoles`.

The zod input is `z.enum(FACILITY_ROLES).array().min(1).max(8)`. `min(1)` is deliberate: since a missing row and an empty array mean the same thing, forcing an explicit array removes the ambiguous state from the write path entirely. The Save button is disabled at zero selections with the hint *"Pick at least one role. To make a room open to all residents, select Residents."*

An **"Unconfigured facilities"** section sits above the table listing every `Facilities` row with no `FacilityAccess` row, each with a one-click "Set to Residents only". This is the operational half of the fail-safe default and it is what keeps a silent config gap from becoming a permanent one.

---

## 14. Step 12 — Toasts

Reuse the existing `src/app/_components/Toast.tsx` (`{ content, type, show, onClose }`, portal-rendered, 5 s auto-dismiss). `sonner` is a dep and `src/components/ui/sonner.tsx` exists, but no `<Toaster />` is mounted anywhere; adopting it means touching the root layout, and consistency with the rest of the app is worth more than the ergonomics.

One exception worth noting: the bulk commit progress needs persistent, non-dismissing feedback, which a 5 s toast cannot give. That is why `<BulkCommitProgress>` is an in-page `<Progress>` + table, not a toast sequence. The toast fires once, at the end.

---

## 15. Dependencies

**None new.** Every primitive used (`table`, `badge`, `dialog`, `alert-dialog`, `select`, `input`, `button`, `skeleton`, `textarea`, `switch`, `checkbox`, `radio-group`, `alert`, `card`, `tooltip`, `tabs`, `accordion`, `popover`, `progress`, `scroll-area`), plus `usehooks-ts`, `date-fns` and `lucide-react`, is already in `package.json`. The CSV parser is ~40 lines in `_lib/csv.ts`.

---

## 16. Build order

Each step is independently reviewable; nothing later breaks anything earlier.

1. `src/app/error.tsx` root boundary. Header `currentPage` → `usePathname()` refactor, as its own commit.
2. `src/server/api/services/capabilities.ts` + `whoAmI` returning `capabilities`.
3. `src/app/admin/layout.tsx`, `AdminCapabilityContext`, `AdminShell`, `loading.tsx`, `error.tsx`. Verify redirects before building any content.
4. `RoleBadge`, `EmptyState`, `AdminStatCard`.
5. `/admin` overview + `getStats`.
6. `/admin/users` — table, search, filter, pagination, `keyMismatch`, `missingBaseline` anomaly icon + `missing_resident` filter, admin redaction.
7. `ManageRolesDialog` — including the read-only `resident` row and the D-3 grant-direction lock.
8. `/admin/audit` + its layout guard + batch grouping + the triage table.
9. `/admin/facilities` + its layout guard + the unconfigured section + `FACILITY_ROLES`.
10. `SystemHealthPanel` on the overview, split by capability.
11. `_lib/csv.ts` + `_lib/planClient.ts` (chunking, resume).
12. `/admin/bulk` — input step, column mapper, preview table, ambiguity popover.
13. Commit progress + `finishBulkImport`.
14. `BulkImportHistory` + `BulkImportDetail` + undo.
15. `PendingGrantsPanel`.

Steps 1–9 are shippable without any of D-8. If the timeline compresses, ship them and defer 11–15 — but **do not** ship 10 late: the health panel is the only thing that makes a D-1 lockout visible before a user complains. Under the stored baseline this is **load-bearing rather than nice-to-have** — it is the UI half of the one residual the design does not close structurally (a `UserRole`-scoped write failure), and its red MISSING tile is a gate on the `permissive`→`enforce` flip. Shipping the flip without the panel means flipping blind.

---

## Done when

**Access control**
- [ ] As a plain user, `/admin` redirects to `/` and view-source contains **no** admin markup.
- [ ] As a plain user, no Admin link appears in desktop or mobile nav.
- [ ] As a jcrc, `/admin` renders; the nav link and header both read **"Admin"** (not "Roles"); Facilities and Audit tabs are absent; Users and Bulk are present.
- [ ] As a jcrc, typing `/admin/audit` and `/admin/facilities` directly redirects to `/admin`.
- [ ] `grep -rn 'roles.includes\|isAdmin' src/app/admin/` returns **zero** hits outside `AdminCapabilityContext.tsx`.
- [ ] From the browser console as a jcrc: `api.admin.setUserRoles.mutate({ userID: <self>, roles: ["admin"] })` → FORBIDDEN, and an audited `ok:false` row exists.
- [ ] From the browser console as a jcrc: `api.admin.setUserRoles.mutate({ userID: <other>, roles: ["jcrc"] })` → FORBIDDEN (**D-3**), audited.
- [ ] `listUsers` network response contains **no** `passwordHash` (check the Network tab; do not assume).
- [ ] As a jcrc, a user holding `admin` returns with `admin` redacted and `isProtected: true`; the Manage action is disabled.

**Users table & dialog**
- [ ] Search, role filter and "Load more" all work; a 100+ char search is truncated by zod and `(a+)+$` returns promptly.
- [ ] A user with `keyMismatch` shows the amber warning icon with the correct tooltip.
- [ ] `resident` renders as a read-only badge in `ManageRolesDialog`, with **no `<Switch>`**.
- [ ] Toggling `cca_head` on a user who holds `resident` leaves `resident` present afterwards (verify in the DB, not the UI).
- [ ] A user with an empty roles array renders the amber **"No access"** badge, never "Resident".
- [ ] The roles cell renders **only stored roles**: delete a user's `resident` entry directly in the DB and the table shows the anomaly icon, **not** a synthesised "Resident" badge.
- [ ] That same user's row shows `missingBaseline: true` in the `listUsers` network response, and the `missing_resident` filter returns exactly them.
- [ ] After that user signs in once, the anomaly clears without any admin action (self-heal, I-8b) — confirm in the DB.
- [ ] A non-NUS account with no `resident` does **not** show the anomaly icon and does **not** appear under `missing_resident` (eligibility uses the shared predicate; a `g.s_samuel@u.nus.edu`-style non-E-format account **does** count as eligible — L-27).
- [ ] Hand-post `setUserRoles` from the console with `roles: []` against a user holding `["resident","cca_head"]`: `resident` is still present afterwards in the DB (the server's write cannot express its removal, I-8c) — this must pass with the dialog bypassed entirely.

**Bulk**
- [ ] A 1000-row CSV previews without a 414 or 413 (proves preview is a POST).
- [ ] All nine dirty-input cases (§10.8) land in the correct bucket.
- [ ] A name-matched row is unchecked by default and there is no "confirm all" control on that section.
- [ ] Posting directly to `commitBulkChunk` with a forged row not present in the signed plan is rejected.
- [ ] A 500-row import completes; every chunk returns inside `maxDuration`; a killed chunk resumes from `lastProcessedLineNo` rather than reporting spurious conflicts.
- [ ] Replace-mode import of `["cca_head"]` onto a user holding `["resident","cca_head"]` leaves `resident` present.
- [ ] The same replace-mode import posted **directly to `commitBulkChunk`**, bypassing `computeAfter` entirely, still leaves `resident` present on every target — the client helper is not the mechanism (§10.4).
- [ ] A 200-row replace-mode import across users all holding `resident` leaves 200 `resident` entries intact; the previewed `After` column matched the committed `rolesAfter` on every row.
- [ ] Changing a target's roles between preview and commit yields `CONFLICT_ROLES_CHANGED` on that row only; the batch otherwise completes.
- [ ] Undo restores roles; a user changed post-import is skipped as `DIVERGED_SINCE_IMPORT`; `resident` survives the undo — including for a target whose audited `rolesBefore` was `[]`.
- [ ] A pending grant claimed at login is reversed by undo (not left behind).
- [ ] Preview writes **zero** `RoleAuditLog` rows, even with 40 denials in the batch.
- [ ] As a jcrc, a preview containing an admin returns that row as `denied` with **no** role enumeration and a masked email.

**Pending grants**
- [ ] A pending grant cannot be created keyed on a matric or a name (server rejects; the UI never offers it).
- [ ] As a jcrc, creating a pending `jcrc` grant is refused (**D-3**).
- [ ] A target who signs up after the grant was created shows as **stranded** with a working "Apply now".

**Facilities & health**
- [ ] No string reading "Open to everyone" exists anywhere in `src/`.
- [ ] A facility with no `FacilityAccess` row appears in the "Unconfigured" section and reads "defaults to Residents only".
- [ ] The facility role picker offers `resident`, `jcrc`, `cca_head` and **not** `admin`; Save is disabled at zero selections.
- [ ] The health panel shows counts for a jcrc and per-user identifier lists **only** for an admin.
- [ ] `MISSING the resident baseline` reads **0** and renders red (not amber) when non-zero; planting one missing row makes it 1 and names that user in the admin-only list.
- [ ] The panel states that a non-zero MISSING count blocks the flip to `enforce`, and the flip control (wherever it lives) refuses while it is non-zero.
- [ ] `explainAccess` writes an audit row naming caller and target on every call.

**Audit & chrome**
- [ ] Every mutation from every dialog produced a `RoleAuditLog` row visible on `/admin/audit`.
- [ ] A bulk import appears as **one** collapsible group, not N rows.
- [ ] The audit log has no delete or edit affordance anywhere in the DOM.
- [ ] The last table row is not obscured by the fixed footer, on both `/admin/users` and `/admin/bulk`.
- [ ] The tab strip scrolls horizontally at 375 px without breaking layout.
