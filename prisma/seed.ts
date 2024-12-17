import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.cCA.upsert({
    where: { ccaID: 1 },
    update: {},
    create: {
      ccaID: 1,
      ccaName: "RH Developers",
      category: "Media",
    }
  });
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
