import React from "react";
import Calendar_v2 from "../_components/Calender_v2";
import { HydrateClient } from "~/trpc/server";
import { auth } from "~/server/auth";
import Header from "../_components/header";
import PastBookings from "../_components/PastBookings";

const BookingsPage: React.FC = async () => {

  return (
    <HydrateClient>
      <Header currentPage={"Past Bookings"} />
      <div className="mt-4 text-center">
        <h1 className="text-2xl font-bold text-gray-900">
          Your Past Bookings
        </h1>
      </div>
      <div className="mb-20">
        <PastBookings />
      </div>
    </HydrateClient>
  );
};

export default BookingsPage;
