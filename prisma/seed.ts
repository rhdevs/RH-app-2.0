import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // --- Create Users ---
  const alice = await prisma.user.upsert({
    where: { email: "alice@example.com" },
    update: {},
    create: {
      email: "alice@example.com",
      name: "Alice",
      role: "MEMBER",
      roomNumber: "A101",
      points: 10,
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: "bob@example.com" },
    update: {},
    create: {
      email: "bob@example.com",
      name: "Bob",
      role: "MEMBER",
      roomNumber: "A102",
      points: 15,
    },
  });

  const charlie = await prisma.user.upsert({
    where: { email: "charlie@example.com" },
    update: {},
    create: {
      email: "charlie@example.com",
      name: "Charlie",
      role: "MEMBER",
      roomNumber: "A103",
      points: 5,
    },
  });

  const diana = await prisma.user.upsert({
    where: { email: "diana@example.com" },
    update: {},
    create: {
      email: "diana@example.com",
      name: "Diana",
      role: "HALL_LEADER",
      roomNumber: "B201",
      points: 20,
    },
  });

  const evan = await prisma.user.upsert({
    where: { email: "evan@example.com" },
    update: {},
    create: {
      email: "evan@example.com",
      name: "Evan",
      role: "HALL_LEADER",
      roomNumber: "B202",
      points: 25,
    },
  });

  const fay = await prisma.user.upsert({
    where: { email: "fay@example.com" },
    update: {},
    create: {
      email: "fay@example.com",
      name: "Fay",
      role: "SUPERADMIN",
      roomNumber: "C301",
      points: 100,
    },
  });

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
      description: "Welcome Event for New Residents",
      signUpLink: "http://example.com/event1",
      organiserId: diana.id,
    },
  });

  // Event 2 created by Evan
  const event2 = await prisma.event.create({
    data: {
      location: "Gym",
      description: "Fitness Workshop",
      signUpLink: "http://example.com/event2",
      organiserId: evan.id,
    },
  });

  // Event 3 created by Diana
  const event3 = await prisma.event.create({
    data: {
      location: "Upper Lounge",
      description: "Social Gathering",
      signUpLink: "http://example.com/event3",
      organiserId: diana.id,
    },
  });

  // --- Create Bookings ---
  // Community Hall bookings
  const booking1 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-01T10:00:00.000Z"),
      userId: alice.id,
      facilityId: communityHall.id,
    },
  });

  const booking2 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-01T12:00:00.000Z"),
      userId: bob.id,
      facilityId: communityHall.id,
    },
  });

  // Gym bookings
  const booking3 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-02T08:00:00.000Z"),
      userId: bob.id,
      facilityId: gym.id,
    },
  });

  const booking4 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-02T09:00:00.000Z"),
      userId: charlie.id,
      facilityId: gym.id,
    },
  });

  // Upper Lounge bookings
  const booking5 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-03T14:00:00.000Z"),
      userId: alice.id,
      facilityId: upperLounge.id,
    },
  });

  const booking6 = await prisma.booking.create({
    data: {
      slot: new Date("2025-04-03T15:00:00.000Z"),
      userId: charlie.id,
      facilityId: upperLounge.id,
    },
  });

  console.log({
    users: [alice, bob, charlie, diana, evan, fay],
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
