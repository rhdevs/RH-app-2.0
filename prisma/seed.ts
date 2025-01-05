import { PrismaClient } from "@prisma/client";
import { faker } from "@faker-js/faker";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {

  // Users
  await Promise.all(
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
