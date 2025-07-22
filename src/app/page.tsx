import { api, HydrateClient } from "~/trpc/server";
import Calendar_v2 from "./_components/Calender_v2";
import Header from "./_components/header";

export default async function Home() {

  return (
    <HydrateClient>
      <Header currentPage={"Home"} />
      <div className="mt-4 text-center">
        <h1 className="text-2xl font-bold text-gray-900">
          Your RH Booking Hub
        </h1>
      </div>
      <div className="mb-20">
        <Calendar_v2 />
      </div>
    </HydrateClient>
  );
}
