/**
 * The `scrc` rollout pre-flight. READ-ONLY — it issues no write of any kind.
 *
 *   node scripts/remediation/preflight-scrc-validators.mjs
 *
 * RUN THIS BEFORE GRANTING ANYONE THE `scrc` ROLE, and before writing
 * `SystemFlag { key: "scrc.enabled" }` or re-gating facility 17. It answers the
 * one question that, if answered wrong, makes the whole rollout fail silently.
 *
 * THE QUESTION. `UserRole.roles` and `FacilityAccess.requiredRoles` are Mongo
 * `String[]`s, so Prisma needs no migration to store a new role — that is why
 * this change requires NO `prisma db push` (which in this cluster silently
 * drops non-schema indexes such as `roles_multikey`) and no `prisma migrate`.
 * But a `$jsonSchema` validator on either collection COULD enumerate the legal
 * role strings, and if one does, every write carrying "scrc" is rejected with
 * code 121.
 *
 * WHY THAT REJECTION IS DANGEROUS RATHER THAN MERELY ANNOYING: a `$jsonSchema`
 * rejection arrives from `$runCommandRaw` as DATA — `{ ok: 1, writeErrors: [{
 * code: 121 }] }` — not as a thrown exception (see the note at
 * merge-by-canonical.mjs, and I-8f in services/roles.ts). A caller that only
 * reads the catch block sees success. The grant would appear to work and would
 * not exist.
 *
 * FOUR INDEPENDENT IN-REPO SOURCES say neither collection is validated —
 * lib/rbac.mjs's ROLE_VOCAB note, rbac-doctor.mjs's stray-role note,
 * verify-legacy-drop.mjs, and docs/plans/rbac/04-profile-page.md — and
 * prisma/schema.prisma says FacilityAccess was created precisely BECAUSE the
 * `Facilities` collection is validated. This script confirms that against the
 * LIVE cluster, which is the only source that counts on the day.
 *
 * EXPECTED RESULT: `validator: null` for both ROLE collections, and the script
 * exits 0. If either returns a non-null validator that enumerates role strings,
 * it exits 1 and you must run
 *
 *   db.runCommand({ collMod: "<name>", validator: <the existing one, with
 *                   "scrc" added>, validationLevel: "moderate" })
 *
 * BEFORE any grant and before flipping the flag.
 *
 * It also reports the out-of-vocabulary role-string count, so you have the
 * before-baseline that `rbac-doctor.mjs` must still show as 0 after the grant
 * (which is what proves ROLE_VOCAB in lib/rbac.mjs was updated first).
 *
 * ===========================================================================
 * PHASE 2 EXTENSION — `User` and `AuthAllowlist`
 * ===========================================================================
 *
 * Phase 2 INSERTS A `User` ROW (provision-ext-account.mjs), and that is new:
 * every previous step in this rollout only ever wrote to collections with no
 * validator. `User` HAS a `$jsonSchema` validator — prisma/schema.prisma carries
 * the marker directly above `model User` (SEARCH FOR: "This collection uses a
 * JSON Schema defined in the database"), and 00-overview.md:318 enumerates the
 * validated set as User / Facilities / CCA / UserCCA / Posts.
 *
 * CITED BY SEARCH STRING, NOT BY LINE NUMBER, THROUGHOUT THIS FILE. The old
 * citation `schema.prisma:875` rotted when the schema grew: line 875 now lands
 * inside `model Restaurants`, so an operator following a RED banner under time
 * pressure arrived at a restaurant model. Line ranges below appear only as
 * parenthesised HINTS and are allowed to be stale; the quoted search string is
 * the anchor.
 *
 * The row phase 2 writes is deliberately SPARSE:
 *     { email, displayName, userID: "EXT:…" }
 * with `passwordHash` OMITTED (so the account cannot be logged into until the
 * reset flow sets one) and `block` / `telegramHandle` / `bio` OMITTED (hall
 * office staff have no hall block and publish no Telegram handle). If the
 * validator lists any of those in `required`, or declares
 * `additionalProperties: false` without declaring the three fields we do send,
 * or puts a `pattern` (or an `enum`) on `userID` that "EXT:NGOCANH_MAI" fails,
 * THE INSERT IS REJECTED WITH CODE 121.
 *
 * THE CONSTRAINTS ARE NOT ALWAYS AT THE TOP LEVEL, AND READING ONLY THE TOP
 * LEVEL IS HOW THIS CHECK PRINTS A FALSE "OK". A `$jsonSchema` may express the
 * same three things inside `allOf` / `anyOf` / `oneOf` — which is legal, and is
 * what a validator naturally turns into once it has been edited a few times.
 * Such a validator has NO top-level `required` at all, so a reader that does
 * `schema.required ?? []` sees an empty list and cheerfully reports that
 * nothing required is missing, for a validator that WILL reject the sparse row
 * with code 121. The operator then proceeds to provisioning and finds out
 * there.
 *
 * So the checks below WALK the schema: top level plus every branch of every
 * combinator, recursively. The direction of every judgement is FAIL-SAFE:
 *   - a field required in ANY branch is treated as required;
 *   - EVERY subschema that declares `additionalProperties: false` must itself
 *     declare all three fields we send (that is draft-4 semantics: the keyword
 *     is evaluated against the `properties` of the SAME subschema, not against
 *     the union);
 *   - a `pattern`/`enum` on `userID` in ANY branch must accept the real pins.
 * The last two are deliberately over-strict for `anyOf`/`oneOf`, where only one
 * branch has to match. That trade is made on purpose: a false STOP costs one
 * hand inspection, a false OK costs a failed provisioning mid-rollout.
 *
 * AND WHAT THE WALK CANNOT INTERPRET, IT REFUSES TO PASS. The walk works off an
 * ALLOWLIST of keywords (INTERPRETABLE_KEYWORDS below), so anything it has not
 * been taught — `$ref`, `not`, `dependentRequired`, `patternProperties`,
 * `minProperties`, an `if`/`then`, a schema-valued `additionalProperties`, or
 * whatever a future MongoDB adds — is reported as UNINTERPRETABLE and STOPS the
 * pre-flight with an instruction to read the printed JSON by hand against the
 * exact field list. That is the same posture this file already takes for a
 * non-`$jsonSchema` (query-operator) validator: "cannot verify" is a stop, not
 * a pass.
 *
 * THAT IS WHY THIS IS A STOP-THE-LINE CHECK RATHER THAN A NICE-TO-HAVE. Code
 * 121 from `$runCommandRaw` arrives as DATA — `{ok:1, writeErrors:[{code:121}]}`
 * — not as a throw. provision-ext-account.mjs uses Prisma's TYPED `create`,
 * which does throw, so it will not lie about it; but discovering the constraint
 * from a failed provisioning run mid-rollout is strictly worse than reading it
 * here first, and if a validator DOES demand `passwordHash` then the whole
 * "no password until the reset link" design has to change, not just one line.
 *
 * `AuthAllowlist` is EXPECTED ABSENT on the first run — it does not exist until
 * create-auth-allowlist.mjs runs. Absent is reported, never an error. A
 * brand-new collection carries no validator; this is where that is confirmed
 * rather than assumed.
 */
import { PrismaClient } from "@prisma/client";
import { ROLE_VOCAB } from "./lib/rbac.mjs";

const db = new PrismaClient();

/** Every collection phase 1 or phase 2 writes to. */
const COLLECTIONS = ["UserRole", "FacilityAccess", "User", "AuthAllowlist"];

/** The two whose validator must be NULL — a validator on either could enumerate
 *  legal role strings and reject every write carrying "scrc". */
const ROLE_COLLECTIONS = ["UserRole", "FacilityAccess"];

/** Fields provision-ext-account.mjs deliberately OMITS from the User row. If
 *  any of these is `required`, the sparse row is rejected and the design of the
 *  provisioning flow — no password until the reset link — has to change. */
const MUST_NOT_BE_REQUIRED = ["passwordHash", "block", "telegramHandle", "bio"];

/** Fields it DOES send. Under `additionalProperties: false` each must be a
 *  declared property or the insert is rejected. */
const FIELDS_SENT = ["email", "displayName", "userID"];

/** The pins the rollout will actually use. Tested against any `pattern` the
 *  validator puts on `userID` — a shape test on a made-up example would not
 *  prove anything about the values that are really going in. */
const PINS = ["EXT:NGOCANH_MAI", "EXT:VINCENT_KOH"];

/** The combinators the walk descends into. Every branch of each is collected. */
const COMBINATORS = ["allOf", "anyOf", "oneOf"];

/**
 * KEYWORDS THIS SCRIPT CLAIMS TO UNDERSTAND — an ALLOWLIST, not a blocklist,
 * and that direction is the whole safety property.
 *
 * A blocklist of "dangerous" keywords fails open: the next keyword nobody
 * thought of (or the next one MongoDB adds) sails through and the pre-flight
 * prints OK over a validator it never evaluated. An allowlist fails closed —
 * an unrecognised keyword is reported as UNINTERPRETABLE and stops the run.
 *
 * What is on the list is exactly what cannot change the answer to "is a
 * three-field document with these values accepted":
 *   - annotations (`title`, `description`) — no effect on validation;
 *   - VALUE constraints (`bsonType`, `type`, `pattern`, `enum`, the length /
 *     numeric / array bounds) — they constrain values of fields, and the ones
 *     that could reject OUR values are checked explicitly below for `userID`;
 *   - `required`, `properties`, `additionalProperties` — collected and checked;
 *   - the three combinators — descended into.
 *
 * DELIBERATELY ABSENT, so that they trip the backstop: `$ref` (indirection this
 * script cannot resolve), `not` (inverts the sense of everything under it, so
 * fail-safe collection becomes fail-OPEN), `dependentRequired` / `dependencies`
 * (makes a field required conditionally on another), `patternProperties` (can
 * satisfy `additionalProperties:false` for names we would report as
 * undeclared), `minProperties` (can reject a sparse row on COUNT alone),
 * `if`/`then`/`else`, `propertyNames`, `unevaluatedProperties`.
 */
const INTERPRETABLE_KEYWORDS = new Set([
  "title",
  "description",
  "bsonType",
  "type",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "required",
  "properties",
  "additionalProperties",
  ...COMBINATORS,
]);

/** A fresh accumulator for one walk. Every entry carries the JSON PATH it came
 *  from, because "required demands passwordHash" and "required demands
 *  passwordHash inside allOf[2]" send an operator to two different places in
 *  the printed JSON. */
const newAcc = () => ({
  /** { field, path } — required in ANY branch counts. */
  required: [],
  /** { path, declared[] } — one entry per subschema closing the document. */
  closed: [],
  /** { field, path, keyword, value } — value constraints on the fields we send. */
  valueConstraints: [],
  /** { path, why } — anything the allowlist did not cover. NON-EMPTY MEANS STOP. */
  unhandled: [],
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Walk a SUBSCHEMA that applies to the whole document (the top level, and every
 * combinator branch of it), collecting `required`, `additionalProperties:false`
 * and the property declarations at each level.
 *
 * `properties.<f>` subschemas are NOT walked by this function — they constrain a
 * VALUE, not the document, and hoisting a nested object's `required` into the
 * document's required set would invent a constraint that is not there. They go
 * to walkValueSchema instead.
 */
function walkDocSchema(node, path, acc) {
  if (!isPlainObject(node)) {
    acc.unhandled.push({ path, why: `subschema is ${JSON.stringify(node)}, not an object` });
    return;
  }

  for (const k of Object.keys(node)) {
    if (!INTERPRETABLE_KEYWORDS.has(k)) {
      acc.unhandled.push({ path: `${path}.${k}`, why: `keyword "${k}" is not one this script can evaluate` });
    }
  }

  // -- required ------------------------------------------------------------
  if (node.required !== undefined) {
    if (Array.isArray(node.required)) {
      for (const f of node.required) acc.required.push({ field: String(f), path });
    } else {
      acc.unhandled.push({ path: `${path}.required`, why: `"required" is ${JSON.stringify(node.required)}, not an array` });
    }
  }

  // -- properties ----------------------------------------------------------
  let declared = [];
  if (node.properties !== undefined) {
    if (isPlainObject(node.properties)) {
      declared = Object.keys(node.properties);
      for (const f of FIELDS_SENT) {
        if (f in node.properties) {
          walkValueSchema(f, node.properties[f], `${path}.properties.${f}`, acc);
        }
      }
    } else {
      acc.unhandled.push({ path: `${path}.properties`, why: `"properties" is not an object` });
    }
  }

  // -- additionalProperties ------------------------------------------------
  //
  // Draft-4 semantics, which is what MongoDB implements: this keyword is
  // evaluated against the `properties` of THIS subschema alone. A branch that
  // closes the document while declaring only two of our three fields rejects
  // the third, no matter what the top level declares — which is exactly the
  // case the old top-level-only read could not see.
  if (node.additionalProperties === false) {
    acc.closed.push({ path, declared });
  } else if (node.additionalProperties !== undefined && node.additionalProperties !== true) {
    acc.unhandled.push({
      path: `${path}.additionalProperties`,
      why: `additionalProperties is a SUBSCHEMA (${JSON.stringify(node.additionalProperties).slice(0, 80)}), not true/false`,
    });
  }

  // -- combinators ---------------------------------------------------------
  for (const comb of COMBINATORS) {
    if (node[comb] === undefined) continue;
    if (!Array.isArray(node[comb])) {
      acc.unhandled.push({ path: `${path}.${comb}`, why: `"${comb}" is not an array` });
      continue;
    }
    node[comb].forEach((branch, i) => walkDocSchema(branch, `${path}.${comb}[${i}]`, acc));
  }
}

/**
 * Walk the subschema attached to ONE property we send, collecting the value
 * constraints that could reject the value we are actually going to write. Same
 * combinator descent, same allowlist backstop — a `pattern` hidden under
 * `properties.userID.anyOf[1]` rejects the pin just as hard as one at the top.
 */
function walkValueSchema(field, node, path, acc) {
  if (!isPlainObject(node)) {
    acc.unhandled.push({ path, why: `property subschema is ${JSON.stringify(node)}, not an object` });
    return;
  }
  for (const k of Object.keys(node)) {
    if (!INTERPRETABLE_KEYWORDS.has(k)) {
      acc.unhandled.push({ path: `${path}.${k}`, why: `keyword "${k}" is not one this script can evaluate` });
    }
  }
  if (typeof node.pattern === "string") {
    acc.valueConstraints.push({ field, path, keyword: "pattern", value: node.pattern });
  } else if (node.pattern !== undefined) {
    acc.unhandled.push({ path: `${path}.pattern`, why: `"pattern" is not a string` });
  }
  if (node.enum !== undefined) {
    if (Array.isArray(node.enum)) {
      acc.valueConstraints.push({ field, path, keyword: "enum", value: node.enum });
    } else {
      acc.unhandled.push({ path: `${path}.enum`, why: `"enum" is not an array` });
    }
  }
  for (const comb of COMBINATORS) {
    if (node[comb] === undefined) continue;
    if (!Array.isArray(node[comb])) {
      acc.unhandled.push({ path: `${path}.${comb}`, why: `"${comb}" is not an array` });
      continue;
    }
    node[comb].forEach((branch, i) => walkValueSchema(field, branch, `${path}.${comb}[${i}]`, acc));
  }
  // `properties` / `required` under a property subschema describe a NESTED
  // OBJECT. None of the three fields we send is an object, so a validator that
  // puts them there is describing something this script's model does not cover.
  if (node.properties !== undefined || node.required !== undefined) {
    acc.unhandled.push({
      path,
      why: `this property is described as an OBJECT (it carries properties/required); the three fields written are scalars, so this validator is not the one this script was written against`,
    });
  }
}

let failed = 0;
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failed++;
};

async function main() {
  console.log(`\n=== preflight-scrc-validators.mjs (READ-ONLY) ===\n`);
  console.log(`ROLE_VOCAB in lib/rbac.mjs: ${JSON.stringify(ROLE_VOCAB)}`);
  if (!ROLE_VOCAB.includes("scrc")) {
    fail(
      `"scrc" is NOT in ROLE_VOCAB. Step 1 of the rollout has not landed — ` +
        `rbac-doctor.mjs will report every scrc grant as an out-of-vocabulary ` +
        `stray and exit 1. Fix lib/rbac.mjs before granting the role.`,
    );
  }

  // [1] THE check. listCollections is a read; it takes no locks and writes
  //     nothing. `options.validator` is present only if one was ever installed.
  //
  //     NO SERVER-SIDE `filter`, and that is not a style choice. Atlas rejects
  //     `filter: { name: { $in: [...] } }` on this command with
  //     "Error code 8000 (AtlasError): can't get regex from filter doc not a
  //     regex" — its listCollections filter accepts an exact string or a regex
  //     on `name` and nothing else. Asking for everything and narrowing in JS
  //     is one round trip, still read-only, and cannot be broken by the next
  //     Atlas quirk. Verified against the live cluster.
  console.log(`\n[1] $jsonSchema validators on every collection this rollout writes`);
  const reply = await db.$runCommandRaw({ listCollections: 1 });
  const batch = (reply?.cursor?.firstBatch ?? []).filter((c) =>
    COLLECTIONS.includes(c.name),
  );

  const found = batch.map((c) => ({
    name: c.name,
    validator: c.options?.validator ?? null,
    validationLevel: c.options?.validationLevel ?? null,
    validationAction: c.options?.validationAction ?? null,
  }));

  for (const name of COLLECTIONS) {
    const row = found.find((c) => c.name === name);
    console.log(`\n  --- ${name} ---`);
    if (!row) {
      // Not fatal, ever. A collection Prisma has never written may not exist,
      // and AuthAllowlist is EXPECTED absent before create-auth-allowlist.mjs
      // runs. It cannot carry a validator if it does not exist.
      console.log(`  (absent) — no validator possible`);
      if (name === "AuthAllowlist") {
        console.log(
          `  This is the expected pre-rollout state. It is created by\n` +
            `  create-auth-allowlist.mjs, NOT by \`prisma db push\` (which would drop\n` +
            `  User.email_unique_ci — see the "⚠️ \`prisma db push\` DROPS" block in the\n` +
            `  comment directly above \`model User\` in prisma/schema.prisma; SEARCH FOR\n` +
            `  "email_unique_ci", do not go by a line number).`,
        );
      }
      continue;
    }

    // Print EVERYTHING, in full. The whole point of a pre-flight is that a
    // human reads the actual constraint rather than a summary of it.
    const schema = row.validator?.$jsonSchema ?? null;
    const required = schema?.required ?? null;
    const addProps = schema?.additionalProperties;
    console.log(`  validationLevel:      ${JSON.stringify(row.validationLevel)}`);
    console.log(`  validationAction:     ${JSON.stringify(row.validationAction)}`);
    // Labelled TOP-LEVEL, because that is all these two lines are. The checks
    // for `User` below work off a full walk of the combinators instead, and
    // reading these as the whole constraint is the mistake that made this
    // pre-flight print OK for a validator that rejects the row.
    console.log(`  required (top level):             ${JSON.stringify(required)}`);
    console.log(`  additionalProperties (top level): ${JSON.stringify(addProps === undefined ? null : addProps)}`);
    console.log(`  validator:`);
    console.log(
      row.validator === null
        ? `    null`
        : JSON.stringify(row.validator, null, 2).split("\n").map((l) => `    ${l}`).join("\n"),
    );

    // -- the two ROLE collections: a validator at all is a problem ----------
    if (ROLE_COLLECTIONS.includes(name)) {
      if (row.validator === null) {
        console.log(`  OK — validator: null`);
      } else {
        fail(
          `${name} HAS a validator (validationLevel=${row.validationLevel}, ` +
            `validationAction=${row.validationAction}). STOP. Inspect the JSON ` +
            `printed above: if it enumerates role strings, every write carrying ` +
            `"scrc" will be rejected with code 121 — and $runCommandRaw returns ` +
            `that as { ok: 1, writeErrors: [...] } rather than throwing, so the ` +
            `grant will LOOK like it succeeded. Run collMod with "scrc" added to ` +
            `the enum before any write.`,
        );
      }
      continue;
    }

    // -- AuthAllowlist: present but unexpected-validator --------------------
    if (name === "AuthAllowlist") {
      if (row.validator === null) {
        console.log(`  OK — brand-new collection, no validator, as designed`);
      } else {
        fail(
          `AuthAllowlist has acquired a validator. Nothing in this repo installs ` +
            `one, so somebody added it by hand. Read it before any pin is written — ` +
            `a rejected AuthAllowlist insert is a provisioning that silently does ` +
            `not happen.`,
        );
      }
      continue;
    }

    // -- User: the STOP-THE-LINE checks ------------------------------------
    if (name === "User") {
      if (row.validator === null) {
        console.log(
          `  OK — no validator on this cluster. (schema.prisma's "This collection uses a ` +
            `JSON Schema defined in the database" marker above \`model User\` says there is ` +
            `one, so this is worth a second look, but nothing can reject the insert.)`,
        );
        continue;
      }
      if (schema === null) {
        // A non-$jsonSchema validator (query-operator form) cannot be checked
        // by the tests below. "Cannot verify" is a stop, not a pass: the whole
        // reason this section exists is that a 121 rejection is silent on the
        // raw path and mid-rollout on the typed one.
        fail(
          `User has a validator that is NOT a $jsonSchema (it is in query-operator ` +
            `form). The checks below cannot evaluate it. Read the JSON printed above ` +
            `BY HAND and confirm it accepts { email, displayName, userID } with no ` +
            `passwordHash, before provisioning anything.`,
        );
        continue;
      }

      // THE WALK. Top level PLUS every branch of every allOf/anyOf/oneOf, so a
      // constraint moved into a combinator by a past collMod is still seen.
      // Everything below reads the accumulator, never `schema.required`
      // directly — that read is exactly the blind spot this replaced.
      const acc = newAcc();
      walkDocSchema(schema, "$jsonSchema", acc);

      console.log(
        `  walked: ${acc.required.length} required entr(ies), ` +
          `${acc.closed.length} subschema(s) with additionalProperties:false, ` +
          `${acc.valueConstraints.length} value constraint(s) on the fields sent, ` +
          `${acc.unhandled.length} uninterpretable construct(s)`,
      );
      console.log(`  required (WALKED, all branches): ${JSON.stringify([...new Set(acc.required.map((r) => r.field))])}`);

      // (a) required — IN ANY BRANCH — must not demand a field the sparse row
      //     omits. A field required in one `anyOf` branch and not another is
      //     still treated as required: fail-safe, and the path is printed so a
      //     human can decide whether the branch actually applies.
      const badRequired = acc.required.filter((r) => MUST_NOT_BE_REQUIRED.includes(r.field));
      if (badRequired.length) {
        fail(
          `User requires ${JSON.stringify([...new Set(badRequired.map((r) => r.field))])} ` +
            `(at ${badRequired.map((r) => `${r.path}.required`).join(", ")}). The row ` +
            `provision-ext-account.mjs writes OMITS ${JSON.stringify(MUST_NOT_BE_REQUIRED)} ` +
            `on purpose — omitting passwordHash is what forces the password-reset flow ` +
            `(auth.ts's authorize refuses login while it is absent), and omitting ` +
            `block/telegramHandle/bio is requirement 2. With this validator the insert ` +
            `is REJECTED WITH CODE 121 and the account is never created. STOP and ` +
            `decide: relax the validator with collMod, or change the provisioning design.`,
        );
      } else {
        console.log(
          `  OK — no \`required\` anywhere in this validator (top level or any ` +
            `allOf/anyOf/oneOf branch) demands an omitted field`,
        );
      }

      // (b) additionalProperties:false, EVALUATED PER SUBSCHEMA. Draft 4 scopes
      //     the keyword to the `properties` of the same subschema, so a branch
      //     that closes the document while declaring only some of the fields we
      //     send rejects the rest — regardless of what the top level declares.
      if (acc.closed.length === 0) {
        console.log(`  OK — no subschema declares additionalProperties:false`);
      } else {
        let anyBad = false;
        for (const c of acc.closed) {
          const undeclared = FIELDS_SENT.filter((f) => !c.declared.includes(f));
          if (undeclared.length) {
            anyBad = true;
            fail(
              `${c.path} declares additionalProperties:false and does NOT declare ` +
                `${JSON.stringify(undeclared)} (it declares ${JSON.stringify(c.declared)}). ` +
                `Those are fields the provisioned row sends, so the insert is rejected ` +
                `with code 121.`,
            );
          }
        }
        if (!anyBad) {
          console.log(
            `  OK — ${acc.closed.length} subschema(s) close the document, and each one ` +
              `declares all of ${JSON.stringify(FIELDS_SENT)}`,
          );
        }
      }

      // (c) `pattern` / `enum` on a field we send, anywhere in the walk, tested
      //     against the REAL pins rather than a made-up example. `enum` is
      //     checked as well as `pattern` because it rejects in exactly the same
      //     way and used to be invisible here.
      const userIDConstraints = acc.valueConstraints.filter((c) => c.field === "userID");
      if (userIDConstraints.length === 0) {
        console.log(`  OK — no pattern/enum constraint on userID anywhere in the validator`);
      }
      for (const c of userIDConstraints) {
        if (c.keyword === "pattern") {
          let rx = null;
          try {
            rx = new RegExp(c.value);
          } catch (e) {
            fail(`${c.path} = ${JSON.stringify(c.value)} is not a regex this script can compile (${e.message}). Check it by hand against ${JSON.stringify(PINS)}.`);
            continue;
          }
          const rejected = PINS.filter((p) => !rx.test(p));
          if (rejected.length) {
            fail(
              `${c.path} = ${JSON.stringify(c.value)} REJECTS ${JSON.stringify(rejected)}. ` +
                `userID must hold the EXT pin: it is what facilitiesBooking.ts joins ` +
                `booking -> owner on, so without it every hall office booking renders with ` +
                `a blank owner name — and with this pattern the row cannot be inserted at ` +
                `all (code 121).`,
            );
          } else {
            console.log(`  OK — ${c.path} = ${JSON.stringify(c.value)} accepts ${JSON.stringify(PINS)}`);
          }
        } else {
          const rejected = PINS.filter((p) => !c.value.includes(p));
          if (rejected.length) {
            fail(
              `${c.path} is an enum that does NOT contain ${JSON.stringify(rejected)} ` +
                `(it allows ${JSON.stringify(c.value)}). The insert is rejected with code 121.`,
            );
          } else {
            console.log(`  OK — ${c.path} enumerates the pins`);
          }
        }
      }

      // (d) THE BACKSTOP. Anything the walk could not interpret makes the whole
      //     verdict unsafe, so it is a STOP — the same posture this file already
      //     takes for a query-operator validator. The OK lines above are true
      //     statements about the parts that WERE interpreted; they are not a
      //     verdict on the validator, and this is what stops them being read as
      //     one.
      if (acc.unhandled.length) {
        fail(
          `User's validator contains ${acc.unhandled.length} construct(s) this script ` +
            `CANNOT INTERPRET, so it cannot tell you whether the insert will be accepted:\n` +
            acc.unhandled.map((u) => `        ${u.path}: ${u.why}`).join("\n") +
            `\n      Read the JSON printed above BY HAND and confirm it accepts exactly\n` +
            `      { ${FIELDS_SENT.join(", ")} } with ${MUST_NOT_BE_REQUIRED.join(" / ")} ABSENT and\n` +
            `      userID one of ${JSON.stringify(PINS)}. Do not provision until you have.`,
        );
      }

      // (e) bsonType on userID / passwordHash, reported for the reader. A
      //     bsonType that excludes "null" on an OPTIONAL field is only a
      //     problem if the field is also present-and-null, which this row never
      //     does (it omits, it does not null). TOP-LEVEL ONLY, and labelled as
      //     such — it is informational, and the checks that decide the exit
      //     code are the walked ones above.
      const bt = (f) => JSON.stringify(schema?.properties?.[f]?.bsonType ?? null);
      console.log(
        `  (fyi, top-level properties only) bsonType: email=${bt("email")} ` +
          `displayName=${bt("displayName")} userID=${bt("userID")} passwordHash=${bt("passwordHash")}`,
      );
    }
  }

  // [2] The baseline rbac-doctor.mjs must still report after the grant.
  console.log(`\n[2] out-of-vocabulary role strings (baseline for rbac-doctor)`);
  const rows = await db.userRole.findMany({ select: { roles: true } });
  const stray = new Map();
  for (const r of rows) {
    for (const s of r.roles ?? []) {
      if (!ROLE_VOCAB.includes(s)) stray.set(s, (stray.get(s) ?? 0) + 1);
    }
  }
  console.log(`  UserRole rows scanned:        ${rows.length}`);
  console.log(`  out-of-vocabulary strings:    ${stray.size}`);
  for (const [s, n] of stray) console.log(`    ${JSON.stringify(s)} x${n}`);
  if (stray.size > 0) {
    fail(
      `out-of-vocabulary role strings exist BEFORE the rollout. Resolve them ` +
        `first — otherwise rbac-doctor.mjs's post-grant check cannot ` +
        `distinguish them from a bad scrc write.`,
    );
  }

  // [3] Facility 17 (SCRC Room), for the record. Reported, never changed —
  //     the re-gate to ["jcrc","scrc"] must go through /admin/facilities so it
  //     writes a `facilityAccess.set` audit row.
  console.log(`\n[3] facility 17 (SCRC Room) current gate — REPORTED, NOT CHANGED`);
  const f17 = await db.facilityAccess.findFirst({ where: { facilityID: 17 } });
  console.log(
    f17
      ? `  requiredRoles=${JSON.stringify(f17.requiredRoles)}  legacy requiredRole=${JSON.stringify(f17.requiredRole)}`
      : `  no FacilityAccess row for facility 17`,
  );

  // [4] The kill switch. Expected ABSENT at pre-flight time: the surface ships
  //     inert and is switched on deliberately, after the role is granted.
  console.log(`\n[4] scrc.enabled kill switch`);
  const flag = await db.systemFlag.findUnique({ where: { key: "scrc.enabled" } });
  console.log(
    flag
      ? `  present, value=${JSON.stringify(flag.value)} (surface is ${flag.value === "on" ? "ON" : "OFF"})`
      : `  absent — the surface is OFF, which is the expected pre-rollout state`,
  );

  console.log(`\n================================`);
  if (failed) {
    console.error(`${failed} pre-flight failure(s). DO NOT proceed with the rollout.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Pre-flight clean.`);
  console.log(`  phase 1: safe to grant the role and flip scrc.enabled.`);
  console.log(`  phase 2: the User validator was walked in full — top level and every`);
  console.log(`           allOf/anyOf/oneOf branch — with no uninterpretable construct left`);
  console.log(`           over, and it accepts the sparse EXT row, so provision-ext-account.mjs`);
  console.log(`           will not be rejected with code 121.`);
  console.log(`  Take the index census next: node scripts/remediation/index-census.mjs`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
