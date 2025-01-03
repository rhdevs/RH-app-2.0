import { PrismaClient } from "@prisma/client";
import { faker } from "@faker-js/faker";

const prisma = new PrismaClient();

async function main() {

  // Users
  const users = await Promise.all(
    Array.from({ length: 5 }).map(async () => {
      let displayName = faker.person.firstName();
      return prisma.user.create({
        data: {
          bio: faker.person.bio(),
          block: faker.number.int({ min: 2, max: 8 }),
          displayName: displayName,
          email: faker.internet.email({ firstName: displayName }),
          passwordHash: faker.internet.password(),
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

  // User CCA
  const userCCAs = await Promise.all(
    users.map(async (user) => {
      let numCCAs = faker.number.int({ min: 1, max: 3 });
      let selectedCCAs = faker.helpers.arrayElements(ccas, numCCAs);
      return Promise.all(
        selectedCCAs.map(async (cca) => {
          return prisma.userCCA.create({
            data: {
              userID: user.userID,
              ccaID: cca.ccaID,
            },
          });
        })
      );
    })
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

  // Bookings Logs
  const bookinglogs = await Promise.all(
    Array.from({ length: 20 }).map(async () => {
      let rdmUser = users[Math.floor(Math.random() * users.length)];
      let rdmCCA = ccas[Math.floor(Math.random() * ccas.length)];
      let rdmFacilities =
        facilities[Math.floor(Math.random() * facilities.length)];
      const randomDate = faker.date.recent();
      const randomDatePlusOneHour = new Date(
        randomDate.getTime() + 60 * 60 * 1000,
      );
      return prisma.bookingLogs.create({
        data: {
          action: faker.helpers.arrayElement([
            "Add Booking",
            "Edit Booking",
            "Delete Booking",
          ]),
          bookingID: faker.string.uuid(),
          ccaID: rdmCCA?.ccaID,
          description: faker.lorem.sentence({ min: 3, max: 5 }),
          endTime: Math.floor(randomDatePlusOneHour.getTime() / 1000),
          startTime: Math.floor(randomDate.getTime() / 1000),
          eventName: faker.lorem.sentence({ min: 3, max: 5 }),
          repeat: faker.number.int({ min: 0, max: 1 }),
          timeStamp: faker.date.anytime().toString(),
          userID: rdmUser?.userID,
          facilityID: rdmFacilities?.facilityID,
        },
      });
    }),
  );

  // Bookings
  const bookings = await Promise.all(
    Array.from({ length: 20 }).map(async (item, index) => {
      let rdmUser = users[Math.floor(Math.random() * users.length)];
      let rdmCCA = ccas[Math.floor(Math.random() * ccas.length)];
      let rdmFacilities =
        facilities[Math.floor(Math.random() * facilities.length)];
      const randomDate = faker.date.recent();
      const randomDatePlusOneHour = new Date(
        randomDate.getTime() + 60 * 60 * 1000,
      );
      return prisma.bookings.create({
        data: {
          bookingID: index + 1,
          ccaID: rdmCCA?.ccaID as number,
          description: faker.lorem.sentence({ min: 3, max: 5 }),
          endTime: Math.floor(randomDatePlusOneHour.getTime() / 1000),
          startTime: Math.floor(randomDate.getTime() / 1000),
          facilityID: rdmFacilities?.facilityID as number,
          userID: rdmUser?.userID as string,
        },
      });
    }),
  );

  // Crowd
  const crowd = await Promise.all(
    Array.from({ length: 20 }).map(async () => {
      let rdmFacilities =
        facilities[Math.floor(Math.random() * facilities.length)];
      return prisma.crowd.create({
        data: {
          facilityID: rdmFacilities?.facilityID as number,
          key: faker.lorem.word(),
          level: faker.number.int({ min: 1, max: 5 }),
          time: Math.floor(faker.date.recent().getTime() / 1000),
        },
      });
    }),
  );

  // Restaurants
  const restaurants = await Promise.all(
    Array.from({ length: 20 }).map(async () => {
      return prisma.restaurants.create({
        data: {
          name: faker.company.name(),
          restaurantLogo: faker.image.url(),
          allSection: [
            faker.food.dish(),
            faker.food.dish(),
            faker.food.dish(),
            faker.food.dish(),
            faker.food.dish(),
          ],
        },
      });
    }),
  );

  // Food Menu
  const foodMenus = await Promise.all(
    restaurants.map(async (restaurant) => {
      return prisma.foodMenu.create({
        data: {
          foodMenuName: restaurant.name + " Menu",
          price: faker.commerce.price({ min: 5, max: 30 }),
          restaurantId: restaurant.id,
          section: faker.commerce.department(),
          custom: [
            {
              title: "Sides",
              min: 0,
              max: 3,
              options: [
                {
                  name: faker.food.dish(),
                  price: faker.commerce.price({ min: 1, max: 10 }),
                },
                {
                  name: faker.food.dish(),
                  price: faker.commerce.price({ min: 1, max: 10 }),
                },
              ],
            },
          ],
        },
      });
    }),
  );

  // Food Order
  const foodOrders = await Promise.all(
    Array.from({ length: 20 }).map(async () => {
      let foodMenu = foodMenus[Math.floor(Math.random() * foodMenus.length)];
      let user = users[Math.floor(Math.random() * users.length)];
      return prisma.foodOrder.create({
        data: {
          cancelAction: faker.helpers.arrayElement(["Remove", "Contact"]),
          comments: faker.lorem.sentence(),
          foodMenuId: foodMenu?.id as string,
          foodName: faker.food.dish(),
          foodPrice: faker.commerce.price({ min: 5, max: 30 }),
          restaurantId: foodMenu?.restaurantId as string,
          quantity: faker.number.int({ min: 1, max: 5 }),
          price: faker.commerce.price({ min: 10, max: 100 }),
          status: faker.helpers.arrayElement([
            "Pending",
            "Confirmed",
            "Cancelled",
          ]),
          custom: [
            {
              title: "Order Customizations",
              min: 0,
              max: 3,
              options: [
                {
                  name: faker.commerce.productName(),
                  price: faker.commerce.price({ min: 1, max: 10 }),
                  isSelected: faker.datatype.boolean(),
                },
              ],
            },
          ],
        },
      });
    }),
  );

  // Gym
  const gyms = await Promise.all(
    Array.from({ length: 20 }).map(async () => {
      let user = users[Math.floor(Math.random() * users.length)];
      return prisma.gym.create({
        data: {
          userID: user?.userID as string,
          gymIsOpen: faker.datatype.boolean(),
          keyIsReturned: faker.datatype.boolean(),
          requestTime: Math.floor(faker.date.recent().getTime() / 1000),
          statusChange: faker.helpers.arrayElement(["OPENED", "CLOSED", "NO_CHANGE"]),
          keyHolder: {
            displayName: user?.displayName as string,
            telegramHandle: user?.telegramHandle as string,
          },
          telegramHandle: user?.telegramHandle,
        },
      });
    }),
  );

  // Supper Group
  const supperGroups = await Promise.all(
    Array.from({ length: 20 }).map(async (item, index) => {
      let owner = users[Math.floor(Math.random() * users.length)];
      let restaurant =
        restaurants[Math.floor(Math.random() * restaurants.length)];
      return prisma.supperGroup.create({
        data: {
          supperGroupId: index + 1,
          supperGroupName: faker.lorem.words(3),
          ownerId: owner?.userID as string,
          ownerName: owner?.displayName as string,
          ownerTele: owner?.telegramHandle as string,
          restaurantId: restaurant?.id as string,
          restaurantName: restaurant?.name as string,
          location: faker.location.street(),
          status: faker.helpers.arrayElement(["Completed", "Closed", "Cancelled", "Pending"]),
          createdAt: Math.floor(Date.now() / 1000),
          closingTime: Math.floor(Date.now() / 1000) + 3600,
          phoneNumber: parseInt(faker.string.numeric(8)),
          numOrders: faker.number.int({ min: 0, max: 10 }),
          isPrivate: faker.datatype.boolean(),
          comments: faker.lorem.sentence(),
          userIdList: users.slice(0, 3).map((user) => user.userID),
          currentFoodCost: faker.commerce.price({ min: 10, max: 100 }),
          totalPrice: faker.commerce.price({ min: 20, max: 200 }),
          paymentInfo: [
            {
              paymentMethod: faker.helpers.arrayElement(["Cash", "PayNow", "Credit/Debit Card"]),
              link: faker.internet.url(),
            },
          ],
          additionalCost: faker.number.int({ min: 0, max: 20 }),
          splitAdditionalCost: faker.helpers.arrayElement([
            "Equally",
            "Proportional",
          ]),
        },
      });
    }),
  );

  // Order
  const orders = await Promise.all(
    supperGroups.map(async (supperGroup) => {
      let user = users[Math.floor(Math.random() * users.length)];
      return prisma.order.create({
        data: {
          createdAt: Math.floor(Date.now() / 1000),
          foodIds: foodMenus.slice(0, 3).map(menu => menu.id),
          hasPaid: faker.datatype.boolean(),
          hasReceived: faker.datatype.boolean(),
          notification: faker.lorem.sentence(),
          paymentMethod: faker.helpers.arrayElement(["Cash", "PayNow", "Credit/Debit Card"]),
          supperGroupId: supperGroup.supperGroupId,
          totalCost: faker.commerce.price({ min: 20, max: 200 }),
          userContact: parseInt(faker.string.numeric(8)),
          userID: user?.userID as string,
        },
      });
    }),
  );

  // Posts
  const posts = await Promise.all(
    Array.from({ length: 20 }).map(async () => {
      let user = users[Math.floor(Math.random() * users.length)];
      let cca = ccas[Math.floor(Math.random() * ccas.length)];
      return prisma.posts.create({
        data: {
          userID: user?.userID as string,
          ccaID: cca?.ccaID as number,
          title: faker.lorem.sentence(),
          description: faker.lorem.paragraph(),
          isOfficial: faker.datatype.boolean(),
          createdAt: Math.floor(Date.now() / 1000),
          postPics: [faker.image.url(), faker.image.url()],
        },
      });
    }),
  );
}

main()
  .then(async () => {
    console.log("Seeding complete");
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
