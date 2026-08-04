"use client";

import UserRoleTable from "../_components/users/UserRoleTable";

export default function AdminUsersPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Users</h1>
        <p className="text-sm text-gray-500">
          Roles are keyed on the NUSNET id, not the stored account id. An amber
          icon beside the roles marks an account that should hold the Resident
          baseline but does not — that user cannot book until it repairs. Open
          Details to correct someone&rsquo;s name, block, Telegram handle or
          matric. Email addresses can&rsquo;t be changed — identity is derived
          from them.
        </p>
      </div>
      <UserRoleTable />
    </div>
  );
}
