"use client";

import FacilityAccessTable from "../_components/facilities/FacilityAccessTable";

export default function AdminFacilitiesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Facility access</h1>
        <p className="text-sm text-gray-500">
          Every facility requires at least one role. There is no
          open-to-everyone state — a facility with no rule defaults to Residents
          only.
        </p>
      </div>
      <FacilityAccessTable />
    </div>
  );
}
