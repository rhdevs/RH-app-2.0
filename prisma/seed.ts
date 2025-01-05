import { PrismaClient } from "@prisma/client";
import { faker } from "@faker-js/faker";
import { startOfMonth, endOfMonth, subMonths, addMonths } from "date-fns";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {

  // Users
  const users = await Promise.all(
    Array.from({ length: 5}).map(async (_, index) => {
      const displayName = faker.person.fullName();
      return prisma.user.create({
        data: {
          bio: faker.person.bio(),
          block: faker.number.int({ min: 2, max: 8 }),
          name: displayName,
          displayName: displayName,
          email: `user${index+1}@example.com`,
          passwordHash: bcrypt.hashSync(`password${index+1}`, parseInt(process.env.SALT_ROUNDS!)),
          profilePictureURI: faker.image.dataUri(),
          profilePictureUrl: faker.image.url(),
          telegramHandle: "@" + displayName.toLowerCase(),
          userID: faker.string.uuid(),
        },
      });
    }),
  );

  // CCA
  const ccas = await Promise.all(
    Array.from({ length: 20 }).map(async (item, index) => {
      return prisma.cCA.create({
        data: {
          ccaID: index + 1,
          ccaName: faker.company.name(),
          category: faker.helpers.arrayElement([
            "Sports Activities",
            "Social Committees",
            "Media Committees",
            "RHMP",
            "Ad-hoc",
          ]),
        },
      });
    }),
  );
  // Facilities
  const facilities = await Promise.all(
    Array.from({ length: 20 }).map(async (item, index) => {
      return prisma.facilities.create({
        data: {
          facilityID: index + 1,
          facilityName: faker.commerce.productName(),
          facilityLocation: faker.location.street(),
        },
      });
    }),
  );

  // Bookings
  await Promise.all(
    Array.from({ length: 3 }).flatMap((_, monthOffset) => {
      return Array.from({ length: 20 }).map(async (item, index) => {
        const rdmUser = users[Math.floor(Math.random() * users.length)];
        const rdmCCA = ccas[Math.floor(Math.random() * ccas.length)];
        const rdmFacilities = facilities[Math.floor(Math.random() * facilities.length)];

        const today = new Date();
        const newDate = addMonths(subMonths(today, 1), monthOffset); // Adjust for previous, current, and next months
        const startOfMonthDate = startOfMonth(newDate);
        const endOfMonthDate = endOfMonth(newDate);

        const randomDate = faker.date.between({ from: startOfMonthDate, to: endOfMonthDate });
        const randomDatePlusOneHour = new Date(randomDate.getTime() + 60 * 60 * 1000);
        const randomDescription = faker.lorem.sentence({ min: 3, max: 5 });

        const booking = await prisma.bookings.create({
          data: {
            bookingID: index + 1 + monthOffset * 20, // Unique ID per month
            ccaID: rdmCCA!.ccaID,
            description: randomDescription,
            endTime: Math.floor(randomDatePlusOneHour.getTime() / 1000),
            startTime: Math.floor(randomDate.getTime() / 1000),
            facilityID: rdmFacilities!.facilityID,
            userID: rdmUser!.id,
          },
        });

        await prisma.bookingLogs.create({
          data: {
            action: "Add Booking",
            bookingID: index + 1 + monthOffset * 20,
            ccaID: rdmCCA!.ccaID,
            description: randomDescription,
            endTime: Math.floor(randomDatePlusOneHour.getTime() / 1000),
            startTime: Math.floor(randomDate.getTime() / 1000),
            eventName: faker.company.name(),
            repeat: faker.number.int({ min: 0, max: 5 }),
            timeStamp: faker.date.anytime().toString(),
            userID: rdmUser!.id,
            facilityID: rdmFacilities!.facilityID,
          },
        });

        return booking;
      });
    })
  );
}

async function reset () {
  await prisma.bookingLogs.deleteMany({});
  await prisma.bookings.deleteMany({});
  await prisma.facilities.deleteMany({});
  await prisma.cCA.deleteMany({});
  await prisma.user.deleteMany({});
}

reset()
  .then(() => {
    console.log("Reset complete");
    return main();
  })
  .then(async () => {
    console.log("Seeding complete");
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
