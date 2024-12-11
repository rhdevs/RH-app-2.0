"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface Facility {
  name: string;
  description: string;
}

async function fetchFacility(id: string): Promise<Facility | null> {
  // Replace with actual API call or database fetch logic
  const facilities: Record<string, Facility> = {
    gym: { name: "gym", description: "A modern gym with equipment." },
    study: { name: "Study Room", description: "A quiet place to study." },
  };

  return facilities[id] ?? null;
}

const FacilityDetailsPage: React.FC = () => {
  const { id } = useParams() as { id: string };
  const [facility, setFacility] = useState<Facility | null>(null);

  useEffect(() => {
    console.log("fetching facility", id);
    if (id) {
      void fetchFacility(id).then((data) => {
        setFacility(data);
        console.log(data);
      });
    }
  }, [id]);

  if (!facility) {
    return <div>Facility not found</div>;
  }

  return (
    <div>
      <h1>{facility.name}</h1>
      <p>{facility.description}</p>
    </div>
  );
};

export default FacilityDetailsPage;
