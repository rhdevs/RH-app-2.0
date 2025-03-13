import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Sample Clerk user IDs
const clerkUserDiana = "user_2uAh5MZWWY8eh52E6WbaNyFjeLD";
const clerkUserEvan = "user_2uAyDzL3HnB3PUoTgJ7BtwZBSui";

async function clearOldData() {
  // Delete child records first if there are foreign key constraints
  await prisma.booking.deleteMany({});
  await prisma.event.deleteMany({});
  await prisma.facility.deleteMany({});
}

async function main() {
  // Clear past data
  await clearOldData();

  // --- Create Facilities ---
  const communityHall = await prisma.facility.upsert({
    where: { description: "Community Hall" },
    update: {},
    create: {
      description: "Community Hall",
      openingHours: "8:00 AM - 10:00 PM",
    },
  });

  const gym = await prisma.facility.upsert({
    where: { description: "Gym" },
    update: {},
    create: {
      description: "Gym",
      openingHours: "6:00 AM - 11:00 PM",
    },
  });

  const upperLounge = await prisma.facility.upsert({
    where: { description: "Upper Lounge" },
    update: {},
    create: {
      description: "Upper Lounge",
      openingHours: "9:00 AM - 9:00 PM",
    },
  });

  // --- Create Events ---
  // Event 1 created by Diana
  const event1 = await prisma.event.create({
    data: {
      location: "Community Hall",
      slot: new Date("2025-04-01T10:00:00.000Z"),
      description: "Welcome Event for New Residents",
      signUpLink: "http://example.com/event1",
      organiserId: clerkUserDiana,
    },
  });

  // Event 2 created by Evan
  const event2 = await prisma.event.create({
    data: {
      location: "Gym",
      slot: new Date("2025-04-01T12:00:00.000Z"),
      description: "Fitness Workshop",
      signUpLink: "http://example.com/event2",
      organiserId: clerkUserEvan,
    },
  });

  // Event 3 created by Diana
  const event3 = await prisma.event.create({
    data: {
      location: "Upper Lounge",
      slot: new Date("2025-04-02T09:00:00.000Z"),
      description: "Social Gathering",
      signUpLink: "http://example.com/event3",
      organiserId: clerkUserDiana,
    },
  });

  // --- Create Bookings ---
  // Community Hall bookings
  const booking1 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-01T10:00:00.000Z"),
      userId: clerkUserDiana,
      facilityId: communityHall.id,
    },
  });

  const booking2 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-01T12:00:00.000Z"),
      userId: clerkUserEvan,
      facilityId: communityHall.id,
    },
  });

  // Gym bookings
  const booking3 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-02T08:00:00.000Z"),
      userId: clerkUserEvan,
      facilityId: gym.id,
    },
  });

  const booking4 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-02T09:00:00.000Z"),
      userId: clerkUserDiana,
      facilityId: gym.id,
    },
  });

  // Upper Lounge bookings
  const booking5 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-03T14:00:00.000Z"),
      userId: clerkUserDiana,
      facilityId: upperLounge.id,
    },
  });

  const booking6 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-03T15:00:00.000Z"),
      userId: clerkUserEvan,
      facilityId: upperLounge.id,
    },
  });

  console.log({
    facilities: [communityHall, gym, upperLounge],
    events: [event1, event2, event3],
    bookings: [booking1, booking2, booking3, booking4, booking5, booking6],
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
