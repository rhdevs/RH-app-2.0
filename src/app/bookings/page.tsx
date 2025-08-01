import React from "react";
import { HydrateClient } from "~/trpc/server";
import Header from "../_components/header";
import PastBookings from "../_components/PastBookings";

const BookingsPage: React.FC = async () => {

  return (
    <HydrateClient>
      <Header currentPage={"My Bookings"} />
      <div className="mt-4 text-center">
        <h1 className="text-2xl font-bold text-gray-900">
          Your Bookings
        </h1>
      </div>
      <div className="mb-20">
        <PastBookings />
      </div>
    </HydrateClient>
  );
};

export default BookingsPage;
