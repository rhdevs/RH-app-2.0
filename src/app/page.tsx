import Link from "next/link";

import { LatestPost } from "~/app/_components/post";
import { auth } from "~/server/auth";
import { api, HydrateClient } from "~/trpc/server";
import Calendar from "~/app/_components/Calendar";
import Calendar_v2 from "./_components/Calender_v2";
import { useState } from "react";

export default async function Home() {
  const session = await auth();

  return (
    <HydrateClient>
      <div className="text-center mt-4">
        <h1 className="text-2xl font-bold text-gray-900">
          Your RH Booking Hub
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Check what's booked today or browse by date using the calendar.
        </p>
      </div>
      <div className="mb-20">
        <Calendar_v2 session={session} />
      </div>
    </HydrateClient>
  );
}
