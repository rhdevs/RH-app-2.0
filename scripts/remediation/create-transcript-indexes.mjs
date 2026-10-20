/**
 * Creates every INDEX the Transcript feature declares in prisma/schema.prisma,
 * with the same names, keys and uniqueness, on the transcript collections.
 *
 * DO NOT RUN `prisma db push` (OR `prisma migrate`) AGAINST THE CLUSTER INSTEAD
 * OF THIS SCRIPT — NOT BEFORE IT, NOT AFTER IT. A push silently drops
 * `User.email_unique_ci`, the case-insensitive unique index on `User.email`
 * that Prisma cannot represent. See create-event-phase2-indexes.mjs (same
 * warning, with the history) and docs/plans/events/02-questions-attendance-
 * dashboards.md, Appendix A. `db push` is for the LOCAL Docker database only.
 *
 * The database step for the Transcript feature is:
 *
 *   npx prisma generate                                           # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-transcript-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-transcript-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * The collections themselves are created by MongoDB on first write; only the
 * indexes need creating. A Prisma `@@unique` on Mongo is a client-side type
 * assertion: until the index exists in the cluster the database enforces
 * nothing, and the P2002 the services rely on for idempotency (the single
 * active unlock or withhold, one freeze per CCA and year, one award name...)
 * can never fire.
 *
 * WHAT IT DOES
 *   - Dry run by default: prints, per transcript collection, the indexes that
 *     exist, the ones it would create, and any conflict. `--commit` creates
 *     ONLY the missing ones.
 *   - Never drops or modifies an existing index.
 *   - REFUSES to go on (and writes nothing, even under --commit) when an index
 *     with one of these names exists with a different key, uniqueness or any
 *     other option, or when an index on the same key exists under another name
 *     with different uniqueness, or when existing rows already violate a unique
 *     index it is about to build (E11000 would build nothing).
 *   - Touches ONLY the collections in TARGETS below: no `User`, `CCA`,
 *     `UserCCA` or any other collection. If a diff of the census mentions
 *     another one, this is the wrong script.
 *   - Idempotent: a second run reports "all present" and changes nothing.
 *
 * TARGETS is an explicit table that mirrors prisma/schema.prisma. A Vitest test
 * (src/lib/transcript/__tests__/transcriptIndexes.test.ts) parses the schema
 * and fails if the two differ, so they cannot drift.
 *
 * `$runCommandRaw` returns errors as data (`{ ok: 0, code }`) and does not
 * throw; every command here goes through `runCmd`, which inspects the reply and
 * catches.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { numify, isCommit, banner, abort, aggregateAll } from "./lib/rbac.mjs";
import { describeTarget } from "./lib/dbTarget.mjs";

/**
 * Collection (the Prisma model name) -> the indexes it must have, besides
 * `_id_`. Names are the schema's `map:` values and are FIXED: a name is what a
 * conflict is detected on, and what the census is grepped for.
 */
export const TARGETS = {
  TranscriptPeriod: [
    { name: "transcript_period_ay", key: { academicYear: 1 }, unique: true },
  ],
  TranscriptRosterEntry: [
    {
      name: "transcript_roster_member",
      key: { academicYear: 1, userID: 1, ccaID: 1 },
      unique: true,
    },
    {
      name: "transcript_roster_cca",
      key: { academicYear: 1, ccaID: 1 },
      unique: false,
    },
  ],
  VolunteerActivity: [
    {
      name: "vact_year_cca",
      key: { academicYear: 1, ccaID: 1 },
      unique: false,
    },
  ],
  VolunteerSession: [
    { name: "vsession_activity", key: { activityID: 1 }, unique: false },
  ],
  VolunteerPerson: [
    {
      name: "vperson_activity_user",
      key: { activityID: 1, userID: 1 },
      unique: true,
    },
    {
      name: "vperson_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
  ],
  VolunteerAttendance: [
    {
      name: "vattend_session_user",
      key: { sessionID: 1, userID: 1 },
      unique: true,
    },
    {
      name: "vattend_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
    { name: "vattend_activity", key: { activityID: 1 }, unique: false },
  ],
  Award: [
    {
      name: "award_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
    {
      name: "award_year_type",
      key: { academicYear: 1, awardTypeID: 1 },
      unique: false,
    },
    { name: "award_batch", key: { importBatchID: 1 }, unique: false },
    { name: "award_type", key: { awardTypeID: 1 }, unique: false },
    { name: "award_active_key", key: { activeKey: 1 }, unique: true },
  ],
  AwardType: [
    { name: "award_type_name", key: { normalizedName: 1 }, unique: true },
  ],
  AwardImportBatch: [
    { name: "award_batch_year", key: { academicYear: 1 }, unique: false },
  ],
  JcrcService: [
    {
      name: "jcrc_service_member",
      key: { academicYear: 1, userID: 1 },
      unique: true,
    },
  ],
  CcaYearFreeze: [
    {
      name: "freeze_year_cca",
      key: { academicYear: 1, ccaID: 1 },
      unique: true,
    },
    { name: "freeze_cca", key: { ccaID: 1 }, unique: false },
  ],
  CcaActivity: [
    {
      name: "activity_year_cca",
      key: { academicYear: 1, ccaID: 1 },
      unique: false,
    },
  ],
  CcaActivityParticipant: [
    {
      name: "participant_activity_user",
      key: { activityID: 1, userID: 1 },
      unique: true,
    },
    {
      name: "participant_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
  ],
  TranscriptAccess: [
    {
      name: "access_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: true,
    },
  ],
  ResidentUnlock: [
    { name: "unlock_active_key", key: { activeKey: 1 }, unique: true },
    {
      name: "unlock_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
  ],
  ResidentWithhold: [
    { name: "withhold_active_key", key: { activeKey: 1 }, unique: true },
    {
      name: "withhold_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
  ],
  ManualMembership: [
    {
      name: "manual_year_user_cca",
      key: { academicYear: 1, userID: 1, ccaID: 1 },
      unique: true,
    },
  ],
  ResidentEvent: [
    {
      name: "revent_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
  ],
};

/** The createIndexes spec for one entry. */
const specOf = (ix) =>
  ix.unique
    ? { key: ix.key, name: ix.name, unique: true }
    : { key: ix.key, name: ix.name };

/** Server fields on a listed index that say nothing about its shape. */
const NEUTRAL = new Set(["v", "key", "name", "ns", "unique", "background"]);

const sameKey = (a, b) => {
  const ak = Object.entries(a ?? {});
  const bk = Object.entries(b ?? {});
  return (
    ak.length === bk.length &&
    ak.every(([k, v], i) => k === bk[i][0] && numify(v) === numify(bk[i][1]))
  );
};

/** Options on a listed index beyond key/name/unique (collation, sparse, partial...). */
const extraOptions = (i) => Object.keys(i ?? {}).filter((k) => !NEUTRAL.has(k));

/**
 * Compare what we want with what a collection has. Returns
 *   { status: "present" | "missing" | "conflict", note }
 * "present" includes an identical index under ANOTHER name (the census would
 * show it, and Mongo refuses a second index on the same key anyway).
 */
export function classify(want, existing) {
  const byName = existing.find((i) => i?.name === want.name);
  if (byName) {
    if (!sameKey(byName.key, want.key)) {
      return {
        status: "conflict",
        note: `name "${want.name}" exists on key ${JSON.stringify(byName.key)}, not ${JSON.stringify(want.key)}`,
      };
    }
    if ((byName.unique === true) !== want.unique) {
      return {
        status: "conflict",
        note: `name "${want.name}" exists with unique=${byName.unique === true}, wanted ${want.unique}`,
      };
    }
    const extra = extraOptions(byName);
    if (extra.length) {
      return {
        status: "conflict",
        note: `name "${want.name}" exists with extra options ${extra.join(", ")}`,
      };
    }
    return { status: "present", note: "" };
  }
  const byKey = existing.find((i) => sameKey(i?.key, want.key));
  if (byKey) {
    if ((byKey.unique === true) !== want.unique || extraOptions(byKey).length) {
      return {
        status: "conflict",
        note: `key ${JSON.stringify(want.key)} exists as "${byKey.name}" with different uniqueness/options`,
      };
    }
    return {
      status: "present",
      note: `already present under the name "${byKey.name}"`,
    };
  }
  return { status: "missing", note: "" };
}

const NS_NOT_FOUND = 26;
const IDEMPOTENT_CODES = new Map([
  [48, "NamespaceExists — the collection already exists"],
  [68, "IndexAlreadyExists — that index name already exists"],
]);

/**
 * Plan and (with `commit`) apply the indexes. `db` is anything with
 * `$runCommandRaw(cmd)` (the Prisma client, or a fake in the tests), so the
 * whole run is testable without a database. Returns what happened:
 * `{ aborted, created }`; a refusal also sets process.exitCode, as the script
 * always did.
 */
export async function apply(db, commit, targets = TARGETS) {
  const COMMIT = commit;
  const aborted = (msg) => {
    abort(msg);
    return { aborted: true, created: [] };
  };

  async function runCmd(cmd) {
    try {
      const reply = await db.$runCommandRaw(cmd);
      return {
        ok: numify(reply?.ok) === 1,
        code: reply?.code === undefined ? null : numify(reply.code),
        errmsg: reply?.errmsg === undefined ? null : String(reply.errmsg),
        reply,
      };
    } catch (e) {
      const msg = String(e?.message ?? e);
      const m = /code[^0-9]{0,4}(\d{1,5})/i.exec(msg);
      return {
        ok: false,
        code: m ? Number(m[1]) : null,
        errmsg: msg,
        reply: null,
      };
    }
  }

  async function readIndexes(coll) {
    const r = await runCmd({ listIndexes: coll });
    if (!r.ok) {
      if (
        r.code === NS_NOT_FOUND ||
        /ns does not exist|NamespaceNotFound/i.test(String(r.errmsg))
      ) {
        return { absent: true, indexes: [] };
      }
      return { absent: false, indexes: null, error: r.errmsg };
    }
    return { absent: false, indexes: r.reply?.cursor?.firstBatch ?? [] };
  }

  async function duplicatesOn(coll, ix) {
    const groupId = Object.fromEntries(
      Object.keys(ix.key).map((f) => [f, `$${f}`]),
    );
    const res = await aggregateAll(db, coll, [
      { $group: { _id: groupId, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 20 },
    ]);
    if (!res.ok) return { ok: false, errmsg: res.errmsg, dups: [] };
    return {
      ok: true,
      dups: res.rows.map(
        (r) => `${JSON.stringify(r?._id ?? {})} x${numify(r?.n)}`,
      ),
    };
  }

  {
    banner("create-transcript-indexes.mjs", COMMIT);
    console.log(`target: ${describeTarget(process.env.DATABASE_URL)}`);
    const total = Object.values(targets).reduce(
      (n, list) => n + list.length,
      0,
    );
    console.log(
      `This run touches ONLY the ${Object.keys(targets).length} transcript collections (${total} indexes besides _id_).\n`,
    );

    // -- 1. read everything, plan, refuse on any conflict --------------------
    const plan = [];
    const problems = [];
    for (const [coll, wanted] of Object.entries(targets)) {
      const cur = await readIndexes(coll);
      if (cur.indexes === null)
        return aborted(`could not read ${coll} indexes: ${cur.error}`);
      console.log(
        `--- ${coll}${cur.absent ? "   (collection absent — created on first write)" : ""} ---`,
      );
      const toCreate = [];
      for (const ix of wanted) {
        const c = classify(ix, cur.indexes);
        const mark = {
          present: "present  ",
          missing: "MISSING  ",
          conflict: "CONFLICT ",
        }[c.status];
        console.log(
          `  ${mark} ${ix.name.padEnd(28)} ${JSON.stringify(ix.key)}${ix.unique ? " unique" : ""}${c.note ? `   ${c.note}` : ""}`,
        );
        if (c.status === "conflict")
          problems.push(`${coll}.${ix.name}: ${c.note}`);
        if (c.status === "missing") {
          toCreate.push(ix);
          if (ix.unique && !cur.absent) {
            const d = await duplicatesOn(coll, ix);
            if (!d.ok)
              return aborted(
                `could not check ${coll} for duplicates on ${JSON.stringify(ix.key)}: ${d.errmsg}. An unanswered question is not "no duplicates".`,
              );
            if (d.dups.length)
              problems.push(
                `${coll}.${ix.name}: existing rows already violate uniqueness: ${d.dups.join(", ")}`,
              );
          }
        }
      }
      plan.push({ coll, absent: cur.absent, toCreate });
    }

    if (problems.length) {
      for (const p of problems) console.error(`  RED  ${p}`);
      return aborted(
        `${problems.length} conflict(s). Nothing was written. This script never drops or modifies an index: ` +
          `resolve each one by hand (compare with index-census.mjs), then run it again.`,
      );
    }

    const pending = plan.flatMap((p) =>
      p.toCreate.map((ix) => `${p.coll}.${ix.name}`),
    );
    console.log(`\n--- plan ---`);
    if (pending.length === 0) {
      console.log(`  all present — nothing to create.`);
      return { aborted: false, created: [] };
    }
    for (const name of pending)
      console.log(`  ${COMMIT ? "+" : "~"} create ${name}`);

    if (!COMMIT) {
      console.log(
        `\nDRY RUN — nothing was created. Re-run with --commit to apply, then diff index-census.mjs before and after.`,
      );
      return { aborted: false, created: [] };
    }

    // -- 2. create the missing ones -----------------------------------------
    console.log(`\n--- create ---`);
    for (const { coll, absent, toCreate } of plan) {
      if (toCreate.length === 0) continue;
      if (absent) {
        const c = await runCmd({ create: coll });
        if (!c.ok && !IDEMPOTENT_CODES.has(c.code)) {
          console.error(
            `  ! create ${coll} failed: code=${c.code} ${c.errmsg} — continuing; createIndexes creates it too.`,
          );
        }
      }
      const r = await runCmd({
        createIndexes: coll,
        indexes: toCreate.map(specOf),
      });
      if (r.ok) {
        console.log(`  ok ${coll}: ${toCreate.map((i) => i.name).join(", ")}`);
      } else if (r.code === 11000) {
        return aborted(
          `E11000 building a unique index on ${coll}: ${r.errmsg}. Existing rows violate uniqueness; nothing built there. Fix the data first.`,
        );
      } else if (IDEMPOTENT_CODES.has(r.code)) {
        console.log(
          `  already present: ${coll} (${IDEMPOTENT_CODES.get(r.code)})`,
        );
      } else {
        console.error(
          `  ! createIndexes ${coll} FAILED: code=${r.code} ${r.errmsg}`,
        );
      }
    }

    // -- 3. VERIFY: the reply is a claim, this is the measurement ------------
    console.log(`\n=== VERIFY ===`);
    const red = [];
    for (const [coll, wanted] of Object.entries(targets)) {
      const after = await readIndexes(coll);
      if (after.indexes === null || after.absent) {
        red.push(
          `${coll}: cannot be read back${after.absent ? " (absent)" : `: ${after.error}`}`,
        );
        continue;
      }
      for (const ix of wanted) {
        const c = classify(ix, after.indexes);
        if (c.status !== "present")
          red.push(
            `${coll}.${ix.name}: ${c.status}${c.note ? ` — ${c.note}` : ""}`,
          );
      }
    }
    if (red.length) {
      for (const p of red) console.error(`  RED  ${p}`);
      return aborted(
        `the transcript indexes are NOT all in place. Do not ship until this is clean: a Prisma @@unique on Mongo enforces nothing by itself.`,
      );
    }
    console.log(`all ${total} transcript indexes are present.`);
    console.log(
      `\nNOW run index-census.mjs again and diff it against the census taken before. The only acceptable delta is the transcript collections; User.email_unique_ci MUST still be present.`,
    );
    return { aborted: false, created: pending };
  }
}

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit());
  } finally {
    await db.$disconnect();
  }
}

// Run only when executed, so the test can import TARGETS and classify.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then(() =>
      console.log(process.exitCode ? "\nAborted — see above." : "\nDone."),
    )
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
