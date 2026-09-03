/**
 * I-12 parity gate + PRIVATE-DERIVATION BAN.
 *
 *     node scripts/remediation/verify-identity-parity.mjs
 *
 * Two checks, one exit code:
 *   1. PARITY — src/lib/identity.ts vs scripts/remediation/lib/identity.mjs,
 *      compared over a longhand fixture list.
 *   2. BAN — no file under scripts/ or src/ may declare its OWN canonical-id
 *      derivation. Exactly one allowlisted site is exempt.
 *
 * Exits 0 on full agreement and zero private derivations, 1 on any divergence,
 * any wrong expected value, or any banned derivation.
 *
 * WHY THE BAN LIVES HERE AND NOT IN THE TYPE SYSTEM (09 §5.1, §6). Both of the
 * `[HIGH]` findings in 09 are in `.mjs` files. `.mjs` is outside TypeScript's
 * reach entirely — no brand, no strictNullChecks, no `tsc --noEmit`, not now and
 * not after any type refactor. This gate is the ONLY mechanism in the repository
 * that reaches them. The parity of two files is worthless if a third has its own
 * copy: merge-accounts.mjs:84 declared a private derivation claiming to mirror
 * auth.ts, 9cb701b made that claim false, and nothing re-checked it.
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
import { readdirSync, readFileSync } from "node:fs";
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
  // C9: the absent id is `null`, NOT "". It left the string domain on purpose
  // (09 §5.2, D-B) so that a `where: {userID}` / `dict[k]` / `a === b` cannot
  // accept it in-band. Written longhand here for the same reason the whole
  // fixture list is: so a regression to "" in BOTH implementations still fails.
  ["bob@u.nus.edu.evil.com", null, false], // unanchored .replace() accepted this
  ["bob@evil.com@u.nus.edu", null, false],
  ["bob@sub.u.nus.edu", null, false],
  ["bob@nus.edu.sg", null, false], // staff: allowlist only, never the domain
  ["bob@nus.edu", null, false],
  ["bob@gmail.com", null, false],
  ["e1234567+x@u.nus.edu", null, false], // duplicate-account vector
  ["u.nus.edu", null, false],
  ["@u.nus.edu", null, false], // empty localpart
  ["", null, false],
  ["   ", null, false],
  [null, null, false],
  [undefined, null, false],
];

/**
 * THE `EXT:` NAMESPACE (08-userid-keydrift.md §3 Branch C).
 *
 * These fixtures turn mechanism M1 from an argument into a test. The claim is
 * that `EXT_ID` and the value set of `canonicalUserID` are PROVABLY DISJOINT,
 * because NUS_STUDENT_EMAIL's capture class `[A-Z0-9._%-]` does not contain
 * ':'. The whole security case for the allowlist rests on it: an
 * `AuthAllowlist` row can never pin an address to a key some real NUS session
 * also resolves to.
 *
 * Longhand for the same reason the email fixtures are: so a regression present
 * in BOTH implementations still fails the gate.
 */
const EXT_FIXTURES = [
  ["EXT:NGOCANH_MAI", true],
  ["EXT:VINCENT_KOH", true],
  ["EXT:ABC", true], // exactly the 3-char floor
  ["EXT:AB", false], // below it
  ["EXT:" + "A".repeat(32), true], // exactly the 32-char ceiling
  ["EXT:" + "A".repeat(33), false], // above it
  // THE ATTACK (05-verification.md:164). A NUSNET id is NOT an EXT id, so a row
  // {email:"attacker@gmail.com", pinnedUserID:"E1633673"} mints nothing. If this
  // line ever goes true, an admin's authorization key is pinnable to a stranger
  // with no grant path and therefore no escalation guard firing.
  ["E1633673", false],
  ["G.S_SAMUEL", false], // L-27's real account: a canonical id, not an EXT id
  ["ext:alice", false], // lowercased namespace prefix
  ["EXT:alice", false], // lowercased slug
  ["EXT:A B", false], // space is not in the slug class
  ["EXT:A-B", false], // nor is '-'
  ["EXT:A.B", false], // nor is '.'
  ["XEXT:ABC", false], // unanchored would accept this
  // A trailing newline. JS `$` without /m asserts END OF INPUT and does NOT
  // match before a trailing \n (unlike Perl/Python), so this is false — pinned
  // here because that is a language detail an author could easily assume the
  // other way, and the assumption would admit a smuggled trailing byte.
  ["EXT:ABC\n", false],
  ["EXT:", false],
  ["EXT", false],
  ["", false],
  [null, false],
  [undefined, false],
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

  // 00-overview.md §2.4: `canonicalUserID(e) !== null` is EXACTLY equivalent to
  // `isNusStudentEmail(e)`. If these ever come apart, the sign-in gate and the
  // role key disagree and an account can pass one while being keyed by the
  // other. Asserted per fixture, in both implementations.
  //
  // C9: the comparand is `null`, not "". Left as `!== ""` this assertion would
  // have gone VACUOUS — true for every input — and silently stopped testing
  // anything, which is the same failure mode as rbac-doctor.mjs:287.
  for (const [name, mod] of [["ts", ts], ["mjs", mjs]]) {
    if ((mod.canonicalUserID(input) !== null) !== mod.isNusStudentEmail(input)) {
      failures.push(`GATE/KEY DISAGREE (${name}) on ${i}`);
    }

    // ---- M1, AS A TEST RATHER THAN AS AN ARGUMENT ------------------------
    // NOTHING canonicalUserID CAN PRODUCE IS AN EXT ID. Asserted over the whole
    // email fixture list, in both implementations, rather than reasoned about
    // in a comment: the disjointness of the two key spaces is the entire
    // security case for AuthAllowlist. If it ever fails, one address could
    // resolve to a key an admin-issued pin also resolves to, and
    // {email:"attacker@…", pinnedUserID:"<an admin's id>"} stops being
    // unrepresentable. The argument is that NUS_STUDENT_EMAIL's capture class
    // [A-Z0-9._%-] excludes ':' while EXT_ID requires one; this is the check
    // that the argument still describes the code.
    if (mod.isExtUserID(mod.canonicalUserID(input))) {
      failures.push(`NAMESPACE COLLISION (${name}): canonicalUserID(${i}) is an EXT id`);
    }
  }
}

// ---------------------------------------------------------------------------
// The EXT namespace itself. See EXT_FIXTURES.
// ---------------------------------------------------------------------------
for (const [input, expected] of EXT_FIXTURES) {
  const i = show(input);
  check(`isExtUserID(${i})`, ts.isExtUserID(input), mjs.isExtUserID(input), expected);
  // asExtUserID is the MINTING function (M2). The brand it applies is erased at
  // runtime, so the only thing left to compare is exactly the thing that
  // matters: it passes a well-formed pin through and turns everything else into
  // the ABSENT value. Derived from the longhand `expected` column one line up,
  // so each fixture's truth is still stated by hand exactly once.
  check(
    `asExtUserID(${i})`,
    ts.asExtUserID(input),
    mjs.asExtUserID(input),
    expected ? input : null,
  );
}

// EXT_ID is a RegExp, and two RegExp objects are never `===` even when
// identical — comparing them through check() would report DRIFT on every run.
// Compare the source and flags instead, which is what actually has to match.
check("EXT_ID.source", ts.EXT_ID.source, mjs.EXT_ID.source, "^EXT:[A-Z0-9_]{3,32}$");
check("EXT_ID.flags", ts.EXT_ID.flags, mjs.EXT_ID.flags, "");

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
  // C9. asStoredCanonicalUserID is mirrored into the .mjs (see the long note on
  // it there), so it gets compared BY VALUE and not merely by name. The brand is
  // erased at runtime, which means the only thing left to check is exactly the
  // thing that matters: it passes a well-shaped stored id through and turns
  // everything else — "" above all — into the absent value.
  //
  // `expected ? input : null` is derived rather than longhand, but it is derived
  // from the longhand `expected` column one line up, so the truth about each
  // fixture is still stated by hand exactly once.
  check(
    `asStoredCanonicalUserID(${i})`,
    ts.asStoredCanonicalUserID(input),
    mjs.asStoredCanonicalUserID(input),
    expected ? input : null,
  );
}

/**
 * canonicalFromNusnetID — a bare id as a human types it, back to the key.
 *
 * Longhand for the same reason every list above is. The three that matter:
 *
 *   MARCUS-CHUA  L-27 on the LOOKUP side. `/^E\d{7}$/` was the stand-in for
 *                "is a NUSNET id" in three identifier boxes, and it describes a
 *                SUBSET of them — 420 of 1624 accounts, 25.9%, are outside it.
 *                Those people were grantable and unfindable at the same time.
 *   A0345036J    A MATRIC IS A WELL-FORMED LOCALPART. It converts, and the
 *                result is a key nobody's session produces (schema.prisma:
 *                "NEVER key on User.userID"). This function cannot tell — every
 *                caller MUST test the matric tier before reaching it, which is
 *                why the hazard is pinned here rather than left implicit.
 *   EXT:…        M1 on the new function. Asserted again in the loop below over
 *                the whole EXT list, not just this one entry.
 */
const NUSNET_FIXTURES = [
  ["E1234567", "E1234567"],
  ["e1234567", "E1234567"], // typed lowercase
  ["  E1234567  ", "E1234567"], // pasted from a spreadsheet
  ["MARCUS-CHUA", "MARCUS-CHUA"],
  ["marcus-chua", "MARCUS-CHUA"],
  ["G.S_SAMUEL", "G.S_SAMUEL"],
  ["A0345036J", "A0345036J"], // see the note above — converts, and must not be spent
  ["EXT:NGOCANH_MAI", null], // M1: ':' is outside the capture class
  ["marcus chua", null], // a name, not an id
  ["e1234567+x", null], // '+' is outside the class (the duplicate-account vector)
  ["e1234567@u.nus.edu", null], // an address belongs to canonicalUserID
  ["@", null],
  ["", null],
  ["   ", null],
  [null, null],
  [undefined, null],
];

for (const [input, expected] of NUSNET_FIXTURES) {
  const i = show(input);
  check(
    `canonicalFromNusnetID(${i})`,
    ts.canonicalFromNusnetID(input),
    mjs.canonicalFromNusnetID(input),
    expected,
  );
  // THE SUBSET PROPERTY, AS A TEST. The whole security argument for this
  // function is that it produces nothing canonicalUserID could not produce —
  // that is what carries M1 across to it for free. If someone ever "optimises"
  // it into its own regex, this is the line that fails.
  for (const [name, mod] of [
    ["ts", ts],
    ["mjs", mjs],
  ]) {
    const out = mod.canonicalFromNusnetID(input);
    if (out !== null && mod.canonicalUserID(`${out}@u.nus.edu`) !== out) {
      failures.push(
        `NOT A CANONICAL VALUE (${name}): canonicalFromNusnetID(${i}) = ${show(out)}`,
      );
    }
    if (mod.isExtUserID(out)) {
      failures.push(
        `NAMESPACE COLLISION (${name}): canonicalFromNusnetID(${i}) is an EXT id`,
      );
    }
  }
}

// M1 over the whole EXT list: no pin, well-formed or not, may be typed into an
// identifier box and come back out as a usable key.
for (const [input] of EXT_FIXTURES) {
  for (const [name, mod] of [
    ["ts", ts],
    ["mjs", mjs],
  ]) {
    if (mod.isExtUserID(mod.canonicalFromNusnetID(input))) {
      failures.push(
        `NAMESPACE COLLISION (${name}): canonicalFromNusnetID(${show(input)}) is an EXT id`,
      );
    }
  }
}

// Exported surface must match too — an export present on one side only is
// drift that the value comparisons above cannot see.
const surface = (m) => Object.keys(m).filter((k) => k !== "default").sort().join(",");
if (surface(ts) !== surface(mjs)) {
  failures.push(`EXPORT SURFACE: ts=[${surface(ts)}] mjs=[${surface(mjs)}]`);
}

// ---------------------------------------------------------------------------
// PART 2 — the private-derivation ban (09 §5.1)
// ---------------------------------------------------------------------------
//
// 09 §5.1: the gate checked ONE file pair while merge-accounts.mjs:84 declared a
// private derivation claiming to mirror auth.ts — and nothing re-checked the
// claim. The parity of two files is worthless if a third has its own copy.
//
// Blunt on purpose: a regex over source, with a NAMED allowlist. A cleverer
// detector would need call-graph reachability (09 §5.4 rejects the ESLint rule
// for exactly this reason) and would be disabled the first time it misfired.
//
// This is a SOURCE SCAN. It reads files with readFileSync and matches a regex.
// It imports nothing from the files it inspects, so it stays what the parity
// half already is: no database, no network, no PrismaClient, CI-safe anywhere.
// Matched against the WHOLE FILE, not line by line: `\s*` then spans newlines,
// so a derivation broken across two lines by a formatter is still caught. The
// reported line number is computed from the match offset.
const DERIVATION = /\.toUpperCase\(\)\s*\.replace\(\s*["'`]@U\.NUS\.EDU/gi;

/**
 * C9 FOLLOW-UP — the class the parity check structurally cannot reach.
 *
 * This gate compares the two identity MODULES. It says nothing about their
 * CONSUMERS, and moving the absent id from "" to null turned a whole class of
 * consumer bug from loud into silent: a test written as `=== ""` does not start
 * throwing against null, it starts matching NOTHING. Two real instances shipped
 * in that state, and both were safety checks that fail toward "all clear":
 *
 *   rekey-canonical.mjs  the abort-on-empty-target precondition. Never fires,
 *                        so the run reaches the $set and writes `userID: null`
 *                        across four collections under --commit.
 *   rbac-doctor.mjs:287  the non-NUS detector. Reports a clean bill of health
 *                        for exactly the population it exists to find.
 *
 * So: a canonical id may never be compared against a string literal. Test it
 * for truthiness (`!id`), or against `null` explicitly. Truthiness is preferred
 * at a gate that REFUSES to write — a precondition whose job is rejecting a
 * dead key should not depend on knowing which dead key is currently in fashion.
 */
const LITERAL_COMPARE =
  /canonicalUserID\s*\([^)]*\)\s*(?:===|!==|==|!=)\s*["'`]|["'`]\s*(?:===|!==|==|!=)\s*canonicalUserID\s*\(/gi;

// One entry. Every addition is a decision, not a fix.
const ALLOWLIST = new Set([
  "scripts/remediation/lib/rbac.mjs", // legacyCanonicalUserID, deliberately frozen
]);

// Roots and extensions to sweep. `scripts/**/*.mjs` is the point — it is where
// both HIGH findings lived and where no type system reaches.
const SCAN = [
  { root: "scripts", exts: [".mjs", ".js"] },
  { root: "src", exts: [".ts", ".tsx", ".mjs", ".js"] },
];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", "backups", "data"]);

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a root that does not exist is not a violation
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, exts, out);
    } else if (exts.includes(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
let scanned = 0;
for (const { root, exts } of SCAN) {
  for (const file of walk(path.join(REPO_ROOT, root), exts)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    if (ALLOWLIST.has(rel)) continue;
    scanned++;
    const src = readFileSync(file, "utf8");
    for (const [rx, label] of [
      [DERIVATION, "private derivation"],
      [LITERAL_COMPARE, "canonical id compared to a string literal"],
    ]) {
      rx.lastIndex = 0; // /g/ is stateful; reset per file per pattern
      for (let m = rx.exec(src); m; m = rx.exec(src)) {
        // I-16: name the file:line and show the source. A bare count teaches
        // nothing and the next author re-adds the copy.
        const line = src.slice(0, m.index).split("\n").length;
        const text = src.split(/\r?\n/)[line - 1] ?? m[0];

        // Skip prose. Both patterns exist to be WRITTEN ABOUT — the paragraph
        // above this one names `=== ""` four times, and the two fixed sites
        // each carry a comment quoting the form they used to have. A gate that
        // fires on its own rationale gets switched off within a week, and then
        // it is not protecting anything. Cheap prefix test rather than a real
        // parser: it accepts a trailing `// x === ""`, which is a false
        // negative nobody reaches for, in exchange for zero false positives on
        // the comment blocks this codebase is full of.
        const t = text.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;

        violations.push(`${rel}:${line}: [${label}] ${t}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

// FIXTURES: canonicalUserID + isNusStudentEmail + normalizeEmail per row.
// ID_FIXTURES: isCanonicalResidentID + isResidentEligible + asStoredCanonicalUserID.
// EXT_FIXTURES: isExtUserID + asExtUserID. Plus the two EXT_ID regex compares.
const cases =
  FIXTURES.length * 3 + ID_FIXTURES.length * 3 + EXT_FIXTURES.length * 2 + 2;

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\nFAIL  ${failures.length} parity problem(s) across ${cases} comparisons.`);
  console.error(
    "src/lib/identity.ts and scripts/remediation/lib/identity.mjs must not diverge (I-12).",
  );
}

if (violations.length) {
  console.error(`\nFAIL  ${violations.length} IDENTITY-HANDLING VIOLATION(S):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nWHY A LITERAL COMPARE FAILS. The absent canonical id is `null`, not \"\".\n" +
      "A test written as `=== \"\"` does not break loudly against null — it stops\n" +
      "matching anything, so the branch it guards silently never runs. Both real\n" +
      "instances of this were safety checks that then failed toward 'all clear':\n" +
      "rekey-canonical.mjs's abort-on-empty-target (which would have written\n" +
      "`userID: null` across four collections under --commit) and rbac-doctor's\n" +
      "non-NUS detector (which would have reported a clean bill of health for the\n" +
      "exact population it exists to find). Use `!id`, or compare to null.\n\n" +
      "WHY A PRIVATE DERIVATION FAILS. A canonical userID may be derived in\n" +
      "exactly ONE place:\n" +
      "  src/lib/identity.ts  (and its mirror scripts/remediation/lib/identity.mjs)\n" +
      "Import canonicalUserID from there. Do not re-implement it.\n\n" +
      "This is not style. A private copy silently outlives the derivation it\n" +
      "claims to mirror: merge-accounts.mjs held one that said 'EXACT mirror of\n" +
      "auth.ts', 9cb701b changed auth.ts, and for a non-NUS address the copy\n" +
      "returned a truthy 'ALICE@GMAIL.COM' while every session derived ''. Run\n" +
      "under APPLY it would have re-keyed a real user's account and all their\n" +
      "bookings onto a key no login can ever produce (09 §2.1, [HIGH]).\n\n" +
      "The only exempt site is scripts/remediation/lib/rbac.mjs's\n" +
      "legacyCanonicalUserID, which reproduces the OLD derivation on purpose so\n" +
      "the orphan hunt can compute what the old key was. It never writes a key.\n" +
      "Adding to the allowlist in this file is a decision to be argued in review,\n" +
      "not a way to make this gate quiet.",
  );
}

if (failures.length || violations.length) process.exit(1);

console.log(`OK  identity parity: ${cases} comparisons, ${FIXTURES.length} email fixtures.`);
console.log("    src/lib/identity.ts == scripts/remediation/lib/identity.mjs (I-12)");
console.log(
  `OK  no private identity derivation: ${scanned} file(s) scanned under scripts/ and src/, ` +
    `${ALLOWLIST.size} allowlisted.`,
);
