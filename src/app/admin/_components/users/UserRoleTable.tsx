"use client";

import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { Loader2, Settings2, UserCog } from "lucide-react";

import { api } from "~/trpc/react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
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

import { useCapabilities } from "../AdminCapabilityContext";
import RoleBadge, {
  KeyMismatchIcon,
  MissingBaselineIcon,
  NoAccessBadge,
} from "../RoleBadge";
import EmptyState from "../EmptyState";
import { isMissingBaseline } from "../../_lib/anomalies";
import type { AdminUserRow } from "../../_lib/types";
import ManageRolesDialog from "./ManageRolesDialog";
import UserDetailDialog from "./UserDetailDialog";

export default function UserRoleTable() {
  const cap = useCapabilities();
  const [rawSearch, setRawSearch] = useState("");
  const [search] = useDebounceValue(rawSearch, 300);
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [target, setTarget] = useState<AdminUserRow | null>(null);
  // Separate state from `target`, not a mode flag on one: the two dialogs are
  // different surfaces over the same row and one of them hands off to the other
  // (Details → Manage roles), which a single "which dialog" enum would make a
  // three-way transition instead of two independent booleans.
  const [detail, setDetail] = useState<AdminUserRow | null>(null);

  const {
    data,
    isLoading,
    isError,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = api.admin.listUsers.useInfiniteQuery(
    {
      search: search || undefined,
      role:
        roleFilter === "all"
          ? undefined
          : (roleFilter as "admin" | "jcrc" | "cca_head"),
      limit: 25,
    },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // react-query v5 spelling; `keepPreviousData` was removed. Keeps rows on
      // screen so the table does not flash empty on every keystroke.
      placeholderData: (prev) => prev,
    },
  );

  // The annotation collapses listUsers' two-branch union into the one shape
  // both arms satisfy. See _lib/types.ts.
  const rows: AdminUserRow[] =
    data?.pages.flatMap((p): AdminUserRow[] => p.items) ?? [];

  /**
   * Filter options come from the viewer's own capability set, never from a role
   * test. `admin` appears only when the viewer may see who holds it (D-2) —
   * absent, not disabled: do not leak the ladder.
   *
   * NOTE what is NOT here: `resident` and the `missing_resident` pseudo-option
   * from §8. `listUsers`' `role` input is z.enum(GRANTABLE_ROLES) server-side,
   * which cannot express either. Offering them would send a value the server
   * rejects at the zod boundary. The missing-baseline POPULATION is still
   * visible per row (the amber icon) and counted authoritatively on the health
   * panel; only the server-side query is unavailable.
   */
  const filterRoles = [
    ...new Set([...cap.assignableRoles, ...cap.revocableRoles, "cca_head"]),
  ].filter((r) => r !== "admin" || cap.seeAdminIdentities);

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Input
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="bg-white"
            maxLength={100}
          />
          {isFetching && !isLoading && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400" />
          )}
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-full bg-white sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            {filterRoles.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>Could not load users.</span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="overflow-hidden rounded-xl bg-white shadow-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>User ID (NUSNET)</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              // Skeletons inside REAL rows/cells so the column widths — and
              // therefore the header — do not jump when data lands.
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={`sk-${i}`}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}

            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  {search ? (
                    <EmptyState
                      title={`No users match "${search}".`}
                      action={
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRawSearch("")}
                        >
                          Clear search
                        </Button>
                      }
                    />
                  ) : roleFilter !== "all" ? (
                    <EmptyState
                      title={`No users have the ${roleFilter} role yet.`}
                      hint="Assign the first one from the Bulk tab."
                    />
                  ) : (
                    <EmptyState title="No users found." />
                  )}
                </TableCell>
              </TableRow>
            )}

            {rows.map((u) => {
              // The role-filtered branch of listUsers hardcodes eligible:true
              // (it pages UserRole and has no email to canonicalise), so the
              // anomaly marker would be a guess there. Suppress rather than
              // guess — see _lib/anomalies.ts.
              const anomaly = roleFilter === "all" && isMissingBaseline(u);
              return (
                <TableRow key={`${u.id}-${u.canonicalUserID}`}>
                  <TableCell className="font-medium text-gray-900">
                    {u.displayName ?? <span className="text-gray-400">—</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {/* canonicalUserID is displayed AND is the only key any
                          mutation may submit. legacyUserID holds an A-format
                          matric for ~515 rows and is display-only. */}
                      <span className="font-mono text-xs">
                        {u.canonicalUserID || (
                          <span className="text-gray-400">—</span>
                        )}
                      </span>
                      {u.keyMismatch && <KeyMismatchIcon />}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-gray-600">
                    {u.email ?? <span className="text-gray-400">—</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* STORED roles only. The table must NOT append a
                          "Resident" badge because the account looks eligible —
                          synthesising it would paper over exactly the lockout
                          the anomaly icon exists to surface. */}
                      {u.roles.length === 0 ? (
                        <NoAccessBadge />
                      ) : (
                        u.roles.map((r) => <RoleBadge key={r} role={r} />)
                      )}
                      {anomaly && <MissingBaselineIcon />}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* `disabled` is evaluated PER BUTTON and must not be
                          lifted to the row. Manage roles is disabled without a
                          canonical id because roles are KEYED on it.

                          Profile details are keyed on the User ObjectId, so a
                          non-NUS account is reachable in principle — and it is
                          one of the accounts most likely to need cleaning up.
                          FOR AN ADMIN. It is NOT viewable by a jcrc, and the
                          button must say so rather than lead them into a
                          refusal: assertMayManageUserProfileOf denies every
                          non-admin actor on a target with no canonical id
                          (CANNOT_MODIFY_AN_UNKEYED_ACCOUNT) because such a row's
                          authority is UNEVALUABLE — a pre-cutover UserRole
                          holding `admin` can still be filed under a key this
                          deploy cannot derive — and that denial applies to `get`
                          too. An enabled button therefore led a jcrc to a hard
                          FORBIDDEN plus a `denied` RoleAuditLog row on the
                          highest-signal action this system records, once per
                          click. `modifyAdmins` is the capability that matches:
                          it is the admin-only tier for "may act on a target
                          whose authority is admin, or cannot be shown not to
                          be".

                          `hasAccount` is a SEPARATE refusal and both are needed.
                          On the ROLE-FILTERED branch of listUsers `id` falls
                          back to the UserRole `_id` when no User row hydrated it
                          (`id: u?.id ?? r.id`), which listUsers' own comment
                          calls a LEGITIMATE state — a claimed pending grant, a
                          hand-seeded admin. Handing that id to userAdmin.get
                          returns NOT_FOUND, which the dialog renders as "That
                          account no longer exists", which is false and whose
                          suggested remedy does nothing. Disabled rather than
                          hidden in both cases: the row is real, the profile is
                          not reachable by this viewer. */}
                      {cap.manageUserProfiles && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            !u.hasAccount ||
                            (!u.canonicalUserID && !cap.modifyAdmins)
                          }
                          onClick={() => setDetail(u)}
                          title={
                            !u.hasAccount
                              ? "This role grant has no user account behind it, so there are no profile details to show."
                              : !u.canonicalUserID && !cap.modifyAdmins
                                ? "This account isn't on an @u.nus.edu address, so its role record can't be read back and there's no way to check what access it holds. Only an admin can open it."
                                : undefined
                          }
                        >
                          <UserCog className="mr-1.5 h-3.5 w-3.5" />
                          Details
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!u.canonicalUserID}
                        onClick={() => setTarget(u)}
                        title={
                          u.canonicalUserID
                            ? undefined
                            : "This account has no canonical NUSNET id, so roles cannot be keyed to it."
                        }
                      >
                        <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                        Manage
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      {target && (
        <ManageRolesDialog target={target} onClose={() => setTarget(null)} />
      )}

      {detail && (
        <UserDetailDialog
          target={detail}
          onClose={() => setDetail(null)}
          // The hand-off. The table owns "which dialog is open", so the swap is
          // one state transition here rather than two dialogs each trying to
          // mount the other.
          onManageRoles={() => {
            setTarget(detail);
            setDetail(null);
          }}
        />
      )}
    </>
  );
}
