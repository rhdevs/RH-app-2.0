import { api } from "~/trpc/server";
import { GetServerSideProps } from "next";
import { FC } from "react";

function formatDashedString(input: string): string {
  return input
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

interface FacilityPageProps {
  id: string;
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  return {
    title: `Facility ID: ${params.id}`,
  };
}

export default async function FacilityPageWrapper({
  params,
}: {
  params: { id: string };
}) {
  return <FacilityDetailsPage id={params.id} />;
}

const FacilityDetailsPage: FC<FacilityPageProps> = async ({ id }) => {
  const facilities = await api.facility.getFacilities();

  return (
    <div className="align-center flex flex-col justify-center p-5 text-center">
      <h1 className="mb-3 text-xl font-bold">Facilities Page</h1>
      {(facilities ?? []).map(facility => {
        return facility.facilityLocation === formatDashedString(id) ? (
          <div
            key={facility.id}
            className="m-1 flex flex-col rounded-xl border border-black bg-green-100 p-1"
          >
            <h1 className="text-lg">{facility.facilityName}</h1>
            <h1 className="text-sm">{formatDashedString(facility.facilityLocation)}</h1>
          </div>
        ) : (
          <div></div>
        );
      })}
    </div>
  );
};
