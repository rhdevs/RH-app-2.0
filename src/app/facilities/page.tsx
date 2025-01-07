import React from "react";
import { api } from "~/trpc/server";


function formatDashedString(input: string): string {
  return input
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

const FacilitiesPage: React.FC = async () => {
  const facilities = await api.facility.getFacilities();
  return (
    <div className="align-center flex flex-col justify-center p-5 text-center">
      <h1 className="mb-3 text-xl font-bold">Facilities Page</h1>
      {(facilities ?? []).map( facility => {
          return (
            <div
              key={facility.facilityID}
              className="m-1 flex flex-col rounded-xl border border-black bg-green-100 p-1"
            >
              <h1 className="text-lg">{facility.facilityName}</h1>
              <h1 className="text-sm">
                {formatDashedString(facility.facilityLocation)}
              </h1>
            </div>
          );
        },
      )}
    </div>
  );
};

export default FacilitiesPage;
