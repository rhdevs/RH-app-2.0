/**
 * Seeds role data so the server-side facility RBAC (#23) reproduces the old
 * hardcoded `jcrcList` gate on "SCRC Room".
 *
 * Run AFTER `npx prisma db push` (which creates the UserRole / FacilityAccess
 * collections + indexes):
 *
 *   node scripts/remediation/seed-rbac.mjs
 *
 * Idempotent: safe to run more than once.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// The matric IDs that were previously hardcoded in BookingModal.tsx.
const JCRC_USERS = [
  "E1293802", "E1454218", "E1337187", "E1122423", "E1121407", "E1186145",
  "E1249457", "E1397941", "E1121047", "E1156691", "E1375422",
];

const RESTRICTED_FACILITY_NAME = "SCRC Room";
const REQUIRED_ROLE = "jcrc";

async function main() {
  // 1. Grant the jcrc role to each user.
  for (const userID of JCRC_USERS) {
    await db.userRole.upsert({
      where: { userID },
      create: { userID, role: REQUIRED_ROLE },
      update: { role: REQUIRED_ROLE },
    });
  }
  console.log(`Granted "${REQUIRED_ROLE}" to ${JCRC_USERS.length} users.`);

  // 2. Mark the restricted facility as requiring that role.
  const facility = await db.facilities.findFirst({
    where: { facilityName: RESTRICTED_FACILITY_NAME },
  });
  if (!facility) {
    console.warn(
      `Facility "${RESTRICTED_FACILITY_NAME}" not found — skipping FacilityAccess seed.`,
    );
    return;
  }
  await db.facilityAccess.upsert({
    where: { facilityID: facility.facilityID },
    create: { facilityID: facility.facilityID, requiredRole: REQUIRED_ROLE },
    update: { requiredRole: REQUIRED_ROLE },
  });
  console.log(
    `"${RESTRICTED_FACILITY_NAME}" (facilityID ${facility.facilityID}) now requires role "${REQUIRED_ROLE}".`,
  );

  // 3. Optional: seed the bookingID counter to the current max so allocation
  //    never collides with existing bookings.
  const last = await db.bookings.findFirst({
    orderBy: { bookingID: "desc" },
    select: { bookingID: true },
  });
  await db.counter.upsert({
    where: { key: "bookingID" },
    create: { key: "bookingID", seq: last?.bookingID ?? 0 },
    update: {},
  });
  console.log(`Seeded bookingID counter at ${last?.bookingID ?? 0}.`);
}

main()
  .then(() => console.log("RBAC seed complete."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
