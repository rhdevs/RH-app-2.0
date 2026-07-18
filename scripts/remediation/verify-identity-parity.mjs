/**
 * I-12 parity gate: src/lib/identity.ts vs scripts/remediation/lib/identity.mjs.
 *
 *     node scripts/remediation/verify-identity-parity.mjs
 *
 * Exits 0 on full agreement, 1 on any divergence or any wrong expected value.
 *
 * TOUCHES NO DATABASE. It imports two pure modules and compares their return
 * values. There is no PrismaClient, no connection string, no network. Safe to
 * run anywhere, any time, including in CI.
 *
 * WHY THIS EXISTS. The scripts cannot import TypeScript, so the .mjs is a
 * hand-maintained copy. A copy that drifts is not a cosmetic problem: the
 * backfill would key rows on one derivation and the runtime session callback
 * would look them up under another, so the grant appears to succeed and
 * matches nothing (I-1). That failure has no symptom until a user cannot book.
 *
 * The .ts side is loaded through Node's built-in type stripping (unflagged
 * from Node 23.6; --experimental-strip-types on 22.6+). That means the REAL
 * source of truth is executed, not a transcription of it — a parity test that
 * re-implements the TS side would pass while the app was broken.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TS_PATH = path.join(REPO_ROOT, "src", "lib", "identity.ts");
const MJS_PATH = path.join(REPO_ROOT, "scripts", "remediation", "lib", "identity.mjs");

/**
 * The fixture list is specified by 00-overview.md I-12 and 02-backend-authz.md
 * §2.1. Do not shorten it. `expect` is written out longhand rather than
 * computed, so that a bug present in BOTH implementations still fails the gate
 * — otherwise this only proves they agree, not that they are right.
 */
const FIXTURES = [
  // input, canonicalUserID, isNusStudentEmail
  ["e1234567@u.nus.edu", "E1234567", true],
  ["E1234567@U.NUS.EDU", "E1234567", true], // live bug fix: register/route.ts rejects this today
  ["  e1234567@u.nus.edu  ", "E1234567", true], // .trim() is load-bearing
  ["\te1234567@u.nus.edu\n", "E1234567", true],
  ["E1633673@u.nus.edu", "E1633673", true], // the admin id (D-4)
  // L-27. A REAL account. Non-E-format localparts are eligible; gating on
  // /^E\d{7}$/ withholds the stored baseline from this user permanently.
  ["g.s_samuel@u.nus.edu", "G.S_SAMUEL", true],
  ["a-b_c.d%e@u.nus.edu", "A-B_C.D%E", true],
  // Adversarial / out-of-domain — all reject.
  ["bob@u.nus.edu.evil.com", "", false], // unanchored .replace() accepted this
  ["bob@evil.com@u.nus.edu", "", false],
  ["bob@sub.u.nus.edu", "", false],
  ["bob@nus.edu.sg", "", false], // staff: allowlist only, never the domain
  ["bob@nus.edu", "", false],
  ["bob@gmail.com", "", false],
  ["e1234567+x@u.nus.edu", "", false], // duplicate-account vector
  ["u.nus.edu", "", false],
  ["@u.nus.edu", "", false], // empty localpart
  ["", "", false],
  ["   ", "", false],
  [null, "", false],
  [undefined, "", false],
];

/** isCanonicalResidentID is a shape test on an ID, not on an email. */
const ID_FIXTURES = [
  ["E1234567", true],
  ["G.S_SAMUEL", true], // L-27 again, on the write-guard side
  ["EXT:ALICE", true], // documented false-positive: shape only, no provenance
  ["", false],
  ["bob@u.nus.edu", false],
  [null, false],
  [undefined, false],
];

function show(v) {
  return v === null ? "null" : v === undefined ? "undefined" : JSON.stringify(v);
}

async function loadTs() {
  try {
    return await import(pathToFileURL(TS_PATH).href);
  } catch (err) {
    console.error(
      `\nCannot load ${TS_PATH}.\n` +
        `This gate executes the real TypeScript source via Node's type stripping,\n` +
        `which needs Node >= 23.6 (or >= 22.6 with --experimental-strip-types).\n` +
        `Running Node ${process.version}.\n` +
        `If the source now contains non-erasable syntax (enum, namespace, parameter\n` +
        `properties), remove it — src/lib/identity.ts must stay plain and pure.\n\n` +
        String(err),
    );
    process.exit(1);
  }
}

const ts = await loadTs();
const mjs = await import(pathToFileURL(MJS_PATH).href);

const failures = [];
function check(label, tsValue, mjsValue, expected) {
  if (tsValue !== mjsValue) {
    failures.push(`DRIFT   ${label}: ts=${show(tsValue)} mjs=${show(mjsValue)}`);
  } else if (tsValue !== expected) {
    failures.push(`WRONG   ${label}: both=${show(tsValue)} expected=${show(expected)}`);
  }
}

for (const [input, expectedID, expectedNus] of FIXTURES) {
  const i = show(input);
  check(`canonicalUserID(${i})`, ts.canonicalUserID(input), mjs.canonicalUserID(input), expectedID);
  check(
    `isNusStudentEmail(${i})`,
    ts.isNusStudentEmail(input),
    mjs.isNusStudentEmail(input),
    expectedNus,
  );
  check(
    `normalizeEmail(${i})`,
    ts.normalizeEmail(input),
    mjs.normalizeEmail(input),
    (input ?? "").trim().toLowerCase(),
  );

  // 00-overview.md §2.4: `canonicalUserID(e) !== ""` is EXACTLY equivalent to
  // `isNusStudentEmail(e)`. If these ever come apart, the sign-in gate and the
  // role key disagree and an account can pass one while being keyed by the
  // other. Asserted per fixture, in both implementations.
  for (const [name, mod] of [["ts", ts], ["mjs", mjs]]) {
    if ((mod.canonicalUserID(input) !== "") !== mod.isNusStudentEmail(input)) {
      failures.push(`GATE/KEY DISAGREE (${name}) on ${i}`);
    }
  }
}

for (const [input, expected] of ID_FIXTURES) {
  const i = show(input);
  check(
    `isCanonicalResidentID(${i})`,
    ts.isCanonicalResidentID(input),
    mjs.isCanonicalResidentID(input),
    expected,
  );
  // 05-verification.md §5 still calls it isResidentEligible. Same function.
  check(
    `isResidentEligible(${i})`,
    ts.isResidentEligible(input),
    mjs.isResidentEligible(input),
    expected,
  );
}

// Exported surface must match too — an export present on one side only is
// drift that the value comparisons above cannot see.
const surface = (m) => Object.keys(m).filter((k) => k !== "default").sort().join(",");
if (surface(ts) !== surface(mjs)) {
  failures.push(`EXPORT SURFACE: ts=[${surface(ts)}] mjs=[${surface(mjs)}]`);
}

const cases = FIXTURES.length * 3 + ID_FIXTURES.length * 2;
if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\nFAIL  ${failures.length} problem(s) across ${cases} comparisons.`);
  console.error(
    "src/lib/identity.ts and scripts/remediation/lib/identity.mjs must not diverge (I-12).",
  );
  process.exit(1);
}

console.log(`OK  identity parity: ${cases} comparisons, ${FIXTURES.length} email fixtures.`);
console.log("    src/lib/identity.ts == scripts/remediation/lib/identity.mjs (I-12)");
