/* eslint-disable @typescript-eslint/no-unused-vars */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user1 = await prisma.user.upsert({
    where: { email: "john.doe@example.com" },
    update: {},
    create: {
      email: "john.doe@example.com",
      name: "John Doe",
    },
  });

  const user2 = await prisma.user.upsert({
    where: { email: "jane.doe@example.com" },
    update: {},
    create: {
      email: "jane.doe@example.com",
      name: "Jane Doe",
    },
  });

  const gym = await prisma.facility.upsert({
    where: { name: "Gym" },
    update: {},
    create: {
      name: "Gym",
      description: "A fully equipped gym with modern equipment",
      maxPeople: 20,
      location: "Level 2, Block A",
    },
  });

  const studyArea = await prisma.facility.upsert({
    where: { name: "Study Area" },
    update: {},
    create: {
      name: "Study Area",
      description: "Quiet space for studying and group discussions",
      maxPeople: 10,
      location: "Level 1, Block B",
    },
  });

  const commonRoom = await prisma.facility.upsert({
    where: { name: "Common Room" },
    update: {},
    create: {
      name: "Common Room",
      description: "A large common room with sofas and entertainment systems",
      maxPeople: 30,
      location: "Level 3, Block C",
    },
  });

  await prisma.booking.create({
    data: {
      userId: user1.id,
      facilityId: gym.id,
      startTime: new Date("2024-09-21T10:00:00Z"),
      endTime: new Date("2024-09-21T11:00:00Z"),
      status: "CONFIRMED",
    },
  });

  await prisma.booking.create({
    data: {
      userId: user2.id,
      facilityId: studyArea.id,
      startTime: new Date("2024-09-22T14:00:00Z"),
      endTime: new Date("2024-09-22T15:00:00Z"),
      status: "PENDING",
    },
  });

  console.log("Database seeded successfully!");
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
