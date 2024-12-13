"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import SuperJSON from "superjson";
import { AppRouter } from "~/server/api/root";

interface Facility {
  name: string;
  category: string;
}

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://localhost:3000/api/trpc",
      transformer: SuperJSON,
    }),
  ],
});

function formatDashedString(input: string): string {
  return input
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

const FacilityDetailsPage: React.FC = () => {
  const { id } = useParams() as { id: string };
  const [facilities, setFacilities] = useState<Array<Facility> | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    async function fetchFacility() {
      try {
        const response = await client.facility.getFacility.query();
        setFacilities(response);
      } catch (error) {
        console.log("Failed to fetch facility: ", error);
      }
    }
    fetchFacility();
    setLoading(false);
  }, []);

  console.log("id: ", id);
  console.log(facilities);

  return (
    <div className="align-center flex flex-col justify-center p-5 text-center">
      <h1 className="mb-3 text-xl font-bold">Facilities Page</h1>
      {(facilities || []).map((facility: Facility) => {
        return facility.category === id ? (
          <div
            key={facility.name}
            className="m-1 flex flex-col rounded-xl border border-black bg-green-100 p-1"
          >
            <h1 className="text-lg">{facility.name}</h1>
            <h1 className="text-sm">{formatDashedString(facility.category)}</h1>
          </div>
        ) : (
          <div></div>
        );
      })}
    </div>
  );
};

export default FacilityDetailsPage;
