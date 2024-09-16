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
    "1": { name: "Gym", description: "A modern gym with equipment." },
    "2": { name: "Study Room", description: "A quiet place to study." },
  };

  return facilities[id] ?? null;
}

const FacilityDetailsPage: React.FC = () => {
  const { id } = useParams() as { id: string };
  const [facility, setFacility] = useState<Facility | null>(null);

  useEffect(() => {
    if (id) {
      void fetchFacility(id).then((data) => {
        setFacility(data);
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
