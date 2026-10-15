/**
 * Seeds the LOCAL transcript development database with FAKE data.
 *
 *   npm run dev:db:up && npx prisma db push && npm run dev:db:seed
 *
 * SAFETY
 *  - Refuses to run unless DATABASE_URL points at localhost / 127.0.0.1 AND the
 *    database is named `rhapp_transcript_dev`. Nothing here may ever touch a
 *    shared or production database.
 *  - Idempotent: it deletes and re-inserts ONLY documents it owns, identified by
 *    the made-up userID prefix "SEED-" and the seed CCA ids 9001-9014, then
 *    inserts them again. Safe to run repeatedly.
 *  - Writes only the fields that User, UserCCA, CCA already declare, because the
 *    production collections are $jsonSchema-validated and reject anything else
 *    (a local database has no validator, so this discipline is the only guard).
 *  - No real names, emails or matric numbers: everything is invented.
 */
import { readFileSync, existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const REQUIRED_DB = "rhapp_transcript_dev";
const AY = "AY2026/27";
const SEM2_START = new Date("2027-01-11T00:00:00Z");
const PREFIX = "SEED-";

// --- safety gate (runs before any client is created) ------------------------
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^DATABASE_URL=("?)(.*)\1$/.exec(line.trim());
      if (m) return m[2];
    }
  }
  return undefined;
}

const url = loadDatabaseUrl();
if (!url) {
  console.error("Refusing to seed: DATABASE_URL is not set.");
  process.exit(1);
}
let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("Refusing to seed: DATABASE_URL is not a valid URL.");
  process.exit(1);
}
const dbName = parsed.pathname.replace(/^\//, "");
if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || dbName !== REQUIRED_DB) {
  console.error(
    `Refusing to seed: host must be localhost/127.0.0.1 and database must be "${REQUIRED_DB}" ` +
      `(got host "${parsed.hostname}", database "${dbName}").`,
  );
  process.exit(1);
}
process.env.DATABASE_URL = url;

const db = new PrismaClient();

// --- fake data --------------------------------------------------------------
const CCAS = [
  [9001, "RVC Special Projects", "Committees", "Runs one-off volunteering projects across the community.", true],
  [9002, "RVC Children", "Committees", "Weekly tuition and activities for neighbourhood children.", true],
  [9003, "RVC Pioneers", "Committees", null, true],
  [9004, "RVC Special Needs", "Committees", "Befriending and support programmes for persons with special needs.", true],
  [9005, "Soccer (MALE)", "Sports Activities", "Represents the hall in inter-hall soccer.", false],
  [9006, "Badminton (MALE)", "Sports Activities", "Represents the hall in inter-hall badminton.", false],
  [9007, "Hall Choir", "Performing Arts", "The hall's choir, performing at hall events.", false],
  [9008, "Dance Crew", "Performing Arts", null, false],
  [9009, "Phoenix Press", "Media Committees", "The hall's newsletter and publications.", false],
  [9010, "Photography Club", "Media Committees", null, false], // no profile at all
  [9011, "RHMP Sets", "RHMP", "Builds the sets for the annual hall musical.", false],
  [9012, "Welfare Committee", "Committees", "Looks after residents' welfare through the year.", false],
  [9013, "Chess Club", "Interest Groups", null, false], // no profile at all
  [9014, "Orientation Committee", "Committees", "Organises the freshman orientation programme.", false],
];
const CCA_IDS = CCAS.map((c) => c[0]);
const NO_PROFILE = new Set([9010, 9013]);

const pad = (n) => String(n).padStart(2, "0");
const uid = (n) => `${PREFIX}R${pad(n)}`;
const RESIDENTS = Array.from({ length: 20 }, (_, i) => i + 1);

// roles: R01 admin; R02 jcrc; R03 jcrc + head; R04-R08, R10, R11 heads.
const ROLES = (n) => {
  if (n === 1) return ["admin", "resident"];
  if (n === 2) return ["jcrc", "resident"];
  if (n === 3) return ["jcrc", "cca_head", "resident"];
  if ([4, 5, 6, 7, 8, 10, 11].includes(n)) return ["cca_head", "resident"];
  return ["resident"];
};
// ccaID -> head resident number
const HEADS = { 9005: 4, 9007: 5, 9002: 6, 9001: 7, 9009: 8, 9011: 3, 9003: 10, 9004: 11 };

// memberships: heads are members; R12 is in 13 CCAs; the rest get 2-3 each.
const memberships = new Map(); // key `${n}:${ccaID}`
const addMember = (n, ccaID) => memberships.set(`${n}:${ccaID}`, { n, ccaID });
for (const [ccaID, n] of Object.entries(HEADS)) addMember(n, Number(ccaID));
for (const id of CCA_IDS.slice(0, 13)) addMember(12, id);
for (const n of RESIDENTS) {
  if (n === 12) continue;
  addMember(n, CCA_IDS[n % 14]);
  addMember(n, CCA_IDS[(n + 5) % 14]);
  if (n % 3 === 0) addMember(n, CCA_IDS[(n + 9) % 14]);
}
// the members the roster annotations below talk about
for (const [n, ccaID] of [[13, 9009], [14, 9006], [15, 9008], [16, 9012]]) addMember(n, ccaID);

// --- reset (only what this script owns) ------------------------------------
async function reset() {
  const mine = { startsWith: PREFIX };
  await db.transcriptIssue.deleteMany({ where: { userID: mine } });
  await db.jcrcService.deleteMany({ where: { userID: mine } });
  await db.award.deleteMany({ where: { userID: mine } });
  await db.volunteerRecord.deleteMany({ where: { userID: mine } });
  await db.transcriptRosterEntry.deleteMany({ where: { userID: mine } });
  await db.ccaApplication.deleteMany({ where: { userID: mine } });
  await db.ccaHead.deleteMany({ where: { userID: mine } });
  await db.userCCA.deleteMany({ where: { userID: mine } });
  await db.userRole.deleteMany({ where: { userID: mine } });
  await db.userMatric.deleteMany({ where: { userID: mine } });
  await db.user.deleteMany({ where: { userID: mine } });
  await db.ccaProfile.deleteMany({ where: { ccaID: { in: CCA_IDS } } });
  await db.cCA.deleteMany({ where: { ccaID: { in: CCA_IDS } } });
}

async function seed() {
  await db.cCA.createMany({
    data: CCAS.map(([ccaID, ccaName, category]) => ({ ccaID, ccaName, category })),
  });
  await db.ccaProfile.createMany({
    data: CCAS.filter(([id]) => !NO_PROFILE.has(id)).map(([ccaID, , , description, vol]) => ({
      ccaID,
      description,
      ...(vol ? { isVolunteering: true } : {}),
    })),
  });

  await db.user.createMany({
    data: RESIDENTS.map((n) => ({
      email: `seed-r${pad(n)}@example.invalid`,
      userID: uid(n),
      displayName: `Seed Resident ${pad(n)}`,
      block: (n % 5) + 1,
    })),
  });
  await db.userMatric.createMany({
    data: RESIDENTS.map((n) => ({ userID: uid(n), matric: `A99${pad(n)}000X` })),
  });
  await db.userRole.createMany({
    data: RESIDENTS.map((n) => ({ userID: uid(n), roles: ROLES(n), role: "" })),
  });

  await db.userCCA.createMany({
    data: [...memberships.values()].map(({ n, ccaID }) => ({ userID: uid(n), ccaID })),
  });
  await db.ccaHead.createMany({
    data: Object.entries(HEADS).map(([ccaID, n]) => ({
      userID: uid(n),
      ccaID: Number(ccaID),
      grantedBy: uid(1),
    })),
  });

  // Accepted applications: decidedAt before the sem-2 start => default "full",
  // after it => default "sem2". Heads joined by CcaHead grant, not application.
  let applicationID = 9000;
  const apps = [];
  for (const { n, ccaID } of memberships.values()) {
    if (HEADS[ccaID] === n) continue;
    const late = (n + CCA_IDS.indexOf(ccaID)) % 3 === 0;
    apps.push({
      applicationID: ++applicationID,
      ccaID,
      userID: uid(n),
      status: "accepted",
      decidedAt: new Date(late ? "2027-01-20T09:00:00Z" : "2026-08-20T09:00:00Z"),
      decidedBy: uid(HEADS[ccaID] ?? 1),
    });
  }
  await db.ccaApplication.createMany({ data: apps });

  await db.transcriptPeriod.upsert({
    where: { academicYear: AY },
    create: { academicYear: AY, sem2Start: SEM2_START, status: "collecting" },
    update: { sem2Start: SEM2_START, status: "collecting", publishedAt: null, publishedBy: null },
  });

  const entry = (n, ccaID, extra) => ({ academicYear: AY, userID: uid(n), ccaID, frozen: false, updatedBy: uid(HEADS[ccaID] ?? 1), ...extra });
  await db.transcriptRosterEntry.createMany({
    data: [
      entry(4, 9005, { duration: "full", roleLabel: "Captain", roleDuration: "full", extraContribution: "Led a 24-player squad and organised the inter-hall fixtures." }),
      entry(5, 9007, { duration: "full", roleLabel: "Head", roleDuration: "sem2" }), // took over in semester 2
      entry(6, 9002, { duration: "full", roleLabel: "Head", roleDuration: "full" }),
      entry(12, 9005, { duration: "full" }),
      entry(12, 9007, { duration: "sem1" }), // sem 1 only
      entry(12, 9008, { duration: "sem2" }), // sem 2 only
      entry(12, 9012, { duration: "full", extraContribution: "Coordinated the exam-period welfare drives for 600 residents." }),
      entry(13, 9009, { duration: "sem1" }),
      entry(14, 9006, { duration: "sem2" }),
    ],
  });

  const vol = (n, ccaID, kind, activity, hours, date, extra) => ({
    academicYear: AY, userID: uid(n), ccaID, kind, activity, hours,
    activityDate: date ? new Date(date) : null, recordedBy: uid(HEADS[ccaID]), ...extra,
  });
  await db.volunteerRecord.createMany({
    data: [
      vol(12, 9002, "regular", "Weekly tuition for neighbourhood children", 42),
      vol(12, 9001, "oneoff", "Beach clean-up, East Coast Park", 4, "2026-09-12"),
      vol(13, 9001, "oneoff", "Blood drive support crew", 6, "2026-10-03"),
      vol(14, 9003, "regular", "Monthly visits to a nursing home", 30),
      vol(15, 9004, "regular", "Weekly befriending sessions", 24),
      vol(16, 9001, "oneoff", "Recorded in error", 5, "2026-11-01", { voidedAt: new Date("2026-11-02T00:00:00Z") }),
    ],
  });

  const award = (n, title, citation, extra) => ({ academicYear: AY, userID: uid(n), title, citation, recordedBy: uid(2), ...extra });
  await db.award.createMany({
    data: [
      award(4, "Colours Award, Soccer", "For leading the hall soccer team to a podium finish."),
      award(12, "Service Excellence Award", null),
      award(12, "Outstanding Newcomer", null),
      award(17, "Recorded in error", null, { voidedAt: new Date("2027-04-02T00:00:00Z") }),
    ],
  });

  await db.jcrcService.createMany({
    data: [
      {
        academicYear: AY, userID: uid(2), portfolio: "Sports", position: "Secretary",
        description: "Responsible for the inter-hall sports programme and the hall's sports CCAs.",
        contributions: [
          "Ran the inter-hall sports calendar across 11 sports and 40 matches.",
          "Introduced a shared fixtures calendar adopted by all sports CCAs.",
          "Coordinated transport and refereeing for home matches.",
          "Led the review of sports CCA budgets with the JCRC Treasurer.",
        ],
        testimonial: "This member built a calendar that residents could rely on. I am glad to recommend them.",
        isPlaceholder: true,
      },
      { // JCRC member who is also a CCA head (RHMP Sets)
        academicYear: AY, userID: uid(3), portfolio: "Welfare", position: "Member",
        description: "Supports the JCRC Welfare Secretary in running residents' welfare programmes.",
        contributions: ["Helped run the exam-period welfare drives.", "Was the JCRC contact point for residents' feedback."],
        testimonial: "A dependable member of the committee.",
        isPlaceholder: true,
      },
    ],
  });
}

async function summary() {
  const counts = {
    CCA: await db.cCA.count({ where: { ccaID: { in: CCA_IDS } } }),
    "CcaProfile (isVolunteering)": await db.ccaProfile.count({ where: { isVolunteering: true } }),
    "User / UserMatric / UserRole": [
      await db.user.count({ where: { userID: { startsWith: PREFIX } } }),
      await db.userMatric.count({ where: { userID: { startsWith: PREFIX } } }),
      await db.userRole.count({ where: { userID: { startsWith: PREFIX } } }),
    ].join(" / "),
    UserCCA: await db.userCCA.count({ where: { userID: { startsWith: PREFIX } } }),
    CcaHead: await db.ccaHead.count({ where: { userID: { startsWith: PREFIX } } }),
    "CcaApplication (accepted)": await db.ccaApplication.count({ where: { userID: { startsWith: PREFIX }, status: "accepted" } }),
    TranscriptPeriod: await db.transcriptPeriod.count({ where: { academicYear: AY } }),
    TranscriptRosterEntry: await db.transcriptRosterEntry.count({ where: { academicYear: AY } }),
    "VolunteerRecord (voided)": `${await db.volunteerRecord.count({ where: { academicYear: AY } })} (${await db.volunteerRecord.count({ where: { academicYear: AY, voidedAt: { not: null } } })})`,
    "Award (voided)": `${await db.award.count({ where: { academicYear: AY } })} (${await db.award.count({ where: { academicYear: AY, voidedAt: { not: null } } })})`,
    JcrcService: await db.jcrcService.count({ where: { academicYear: AY } }),
  };
  const r12 = await db.userCCA.count({ where: { userID: uid(12) } });
  console.log(`Seeded ${REQUIRED_DB} (${AY}):`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(30)} ${v}`);
  console.log(`  (${uid(12)} is a member of ${r12} CCAs)`);
}

try {
  await reset();
  await seed();
  await summary();
} finally {
  await db.$disconnect();
}
