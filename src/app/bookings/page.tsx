import React from "react";
import Calendar_v2 from "../_components/Calender_v2";
import { HydrateClient } from "~/trpc/server";
import { auth } from "~/server/auth";

const BookingsPage: React.FC = async () => {
  const session = await auth();

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
        <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
          <Calendar_v2 session={session} />
        </div>
      </main>
    </HydrateClient>
  );
};

export default BookingsPage;
