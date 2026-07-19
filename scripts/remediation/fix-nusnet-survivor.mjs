/**
 * Collapses the two duplicate pairs the canonical merge could not decide, onto
 * the account whose EMAIL carries the correct NUSNET id.
 *
 *   node scripts/remediation/fix-nusnet-survivor.mjs            # dry run
 *   node scripts/remediation/fix-nusnet-survivor.mjs --commit   # apply
 *
 * WHY merge-by-canonical left these. Both members of each pair already share a
 * User.userID, so they never looked like a cross-canonical group — but that
 * field is NOT the identity anyone is keyed on. Every role, booking and gate
 * key is canonicalUserID(email) (invariant I-1), so a pair that agrees on
 * User.userID and disagrees on email is TWO identities wearing one label:
 *
 *   Keri-ann  e153366@u.nus.edu  -> E153366   (a digit short; not her matric)
 *             e1523366@u.nus.edu -> E1523366  <- her 5 bookings live here
 *   Danvern   danvern@u.nus.edu  -> DANVERN   (a vanity localpart)
 *             e1525917@u.nus.edu -> E1525917  <- her/his 2 bookings live here
 *
 * The owner's instruction is to keep, for each, the row with the correct NUSNET
 * id. That is also the row the dependent data already hangs off, so the merge
 * moves no Bookings at all — which is exactly why REQUIRE_EMPTY below asserts
 * the doomed canonical owns nothing before anything is deleted. If that ever
 * fails, the assumption behind this script is wrong and it must stop.
 *
 * PROFILE FIELDS. The doomed row is the one with the real, full name on it
 * ("Keri-ann Shi", "Danvern Poo Han Yew") while the surviving row has a
 * nickname; the names are lifted across explicitly rather than by a
 * longest-string heuristic, so the choice is reviewable in the diff. Everything
 * else on the survivor is left ALONE — bio/telegram/block already agree or the
 * survivor's copy is the newer one.
 *
 * The stale UserRole row keyed on the doomed canonical is deleted too, but only
 * after asserting it is baseline `["resident"]`. An elevated role sitting on a
 * key nobody can sign in as is a finding for a human, not something to discard.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isCommit, banner, abort, fileStamp } from "./lib/rbac.mjs";
import { canonicalUserID } from "./lib/identity.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/** `keepEmail` is asserted to canonicalise to `userID`; `dropEmail` is asserted
 *  NOT to. `name` is what the survivor's displayName becomes. */
const PAIRS = [
  {
    userID: "E1523366",
    keepEmail: "e1523366@u.nus.edu",
    dropEmail: "e153366@u.nus.edu",
    name: "Keri-ann Shi",
  },
  {
    userID: "E1525917",
    keepEmail: "e1525917@u.nus.edu",
    dropEmail: "danvern@u.nus.edu",
    name: "Danvern Poo Han Yew",
  },
];

/** Collections keyed on the canonical id. The doomed canonical must own zero
 *  rows in every one of these, or deleting its account orphans real data. */
const REQUIRE_EMPTY = [
  ["Bookings", (c) => db.bookings.count({ where: { userID: c } })],
  ["BookingLogs", (c) => db.bookingLogs.count({ where: { userID: c } })],
  ["Posts", (c) => db.posts.count({ where: { userID: c } })],
  ["Order", (c) => db.order.count({ where: { userID: c } })],
  ["UserCCA", (c) => db.userCCA.count({ where: { userID: c } })],
  ["Gym", (c) => db.gym.count({ where: { userID: c } })],
  ["CcaHead", (c) => db.ccaHead.count({ where: { userID: c } })],
  ["UserMatric", (c) => db.userMatric.count({ where: { userID: c } })],
  [
    "ProfileCompletion",
    (c) => db.profileCompletion.count({ where: { userID: c } }),
  ],
];

async function main() {
  banner("fix-nusnet-survivor", COMMIT);
  const plan = [];

  for (const pair of PAIRS) {
    const keepCanon = canonicalUserID(pair.keepEmail);
    const dropCanon = canonicalUserID(pair.dropEmail);

    if (keepCanon !== pair.userID) {
      return abort(
        `${pair.keepEmail} canonicalises to ${keepCanon}, not ${pair.userID}`,
      );
    }
    if (dropCanon === pair.userID) {
      return abort(
        `${pair.dropEmail} canonicalises to ${pair.userID} — it is not the odd one out`,
      );
    }

    const rows = await db.user.findMany({
      where: { email: { in: [pair.keepEmail, pair.dropEmail] } },
    });
    const survivor = rows.find((r) => r.email === pair.keepEmail);
    const loser = rows.find((r) => r.email === pair.dropEmail);
    if (!survivor || !loser)
      return abort(
        `expected both rows for ${pair.userID}, found ${rows.length}`,
      );
    if (survivor.userID !== pair.userID || loser.userID !== pair.userID) {
      return abort(`rows for ${pair.userID} no longer share that User.userID`);
    }

    // Nothing may hang off the doomed canonical except its baseline role row.
    const owned = {};
    for (const [label, count] of REQUIRE_EMPTY)
      owned[label] = await count(dropCanon);
    const nonEmpty = Object.entries(owned).filter(([, n]) => n > 0);
    if (nonEmpty.length) {
      return abort(
        `${dropCanon} owns ${nonEmpty.map(([k, n]) => `${n} ${k}`).join(", ")} — resolve by hand`,
      );
    }

    const staleRole = await db.userRole.findUnique({
      where: { userID: dropCanon },
    });
    if (
      staleRole &&
      JSON.stringify(staleRole.roles) !== JSON.stringify(["resident"])
    ) {
      return abort(
        `UserRole ${dropCanon} holds ${JSON.stringify(staleRole.roles)}, not baseline — resolve by hand`,
      );
    }

    plan.push({ pair, survivor, loser, dropCanon, staleRole, owned });
    console.log(
      `\n${pair.userID}: keep ${survivor.email} (${survivor.id}), drop ${loser.email} (${loser.id})` +
        `\n  displayName "${survivor.displayName}" -> "${pair.name}"` +
        `\n  stale UserRole ${dropCanon}: ${staleRole ? "delete (baseline resident)" : "none"}`,
    );
  }

  // backups/ is gitignored, so it is absent in a fresh clone or worktree.
  const dir = path.join(process.cwd(), "scripts", "remediation", "backups");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `fix-nusnet-survivor-${fileStamp()}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: COMMIT ? "commit" : "dry-run",
        plan: plan.map((p) => ({ ...p, pair: p.pair })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nbefore-state written to ${out}`);

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit to apply.");
    return true;
  }

  for (const { pair, survivor, loser, dropCanon, staleRole } of plan) {
    await db.user.update({
      where: { id: survivor.id },
      data: { displayName: pair.name },
    });
    await db.user.delete({ where: { id: loser.id } });
    if (staleRole) await db.userRole.delete({ where: { userID: dropCanon } });
    console.log(
      `${pair.userID}: survivor updated, ${loser.email} deleted, role key ${dropCanon} cleared`,
    );
  }
  return true;
}

main()
  .catch((e) => abort(e.message))
  .finally(() => db.$disconnect());
