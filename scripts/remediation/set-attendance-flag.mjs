/**
 * Turns the EVENTS ATTENDANCE (door / QR check-in) kill switch on or off.
 *
 *   key:  events.attendance.enabled   value: "on" | "off"   default (no row): OFF
 *
 *   node scripts/remediation/set-attendance-flag.mjs             # show current
 *   node scripts/remediation/set-attendance-flag.mjs on          # dry run
 *   node scripts/remediation/set-attendance-flag.mjs on --commit # apply
 *   node scripts/remediation/set-attendance-flag.mjs off --commit
 *
 * A SECOND FLAG, NESTED UNDER events.enabled. Attendance is off unless BOTH are
 * on. That separation is the point: the door layer is the only part of Events
 * that depends on a camera, a phone the hall does not own, a network at a venue
 * and an env var that may not be set. It has to be switchable on for ONE trial
 * event without going hall-wide, and switchable off again from a phone while
 * standing at a door that is not working — without taking timelines and signups
 * down with it.
 *
 * ================== DO NOT TURN THIS ON UNTIL T1 AND T2 PASS ==================
 *
 * `EventAttendance`'s unique index is what makes a re-scan idempotent, and
 * A PRISMA `@@unique` CREATES NOTHING ON MONGODB. Until
 *
 *   node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit
 *
 * has actually run AND been proven to enforce (insert twice against a
 * non-existent eventID and confirm the second is refused with P2002), the
 * check-in path's duplicate branch is UNREACHABLE: a second scan of the same
 * person writes a SECOND ROW, every count is silently wrong, and nothing
 * anywhere errors. Verify with:
 *
 *   node scripts/remediation/verify-events-schema.mjs
 *
 * — check [9] must read OK rather than INFO before this switch is flipped.
 *
 * EVENT_QR_SECRET must also be set in the deployment and the app redeployed,
 * or every scan fails closed with ATTENDANCE_NOT_CONFIGURED. Both are tracked
 * as tasks in docs/plans/events/03-pending-mongo-tasks.md.
 *
 * ============================== NEVER `db push` ==============================
 *
 * This script does not need one and neither does the feature. `prisma db push`
 * silently drops User.email_unique_ci, the case-insensitive unique index that
 * is the duplicate-account guard and is not representable in schema.prisma.
 * That is a live incident in this repository, not a theoretical one. Indexes
 * here are created explicitly with createIndexes via $runCommandRaw; the
 * database step for a field-only schema change is `prisma generate`, and
 * nothing else.
 */
import { PrismaClient } from "@prisma/client";
import { inspectWriteReply, isCommit, abort, nowExt } from "./lib/rbac.mjs";

const db = new PrismaClient();

const KEY = "events.attendance.enabled";
const PARENT_KEY = "events.enabled";
const MODES = ["on", "off"];

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MODE = positional[0];
const COMMIT = isCommit();

/**
 * THREE STATES, NEVER TWO: read-ok-with-a-row, read-ok-with-no-row, and
 * COULD-NOT-READ.
 *
 * `$runCommandRaw` does not have one error convention. A command the server
 * rejects can come back as DATA (`{ ok: 0, code, errmsg }`) or as a thrown
 * `PrismaClientKnownRequestError`, depending on the failure — the rule is
 * written out in full in `index-census.mjs`, and a reader that only catches, or
 * only inspects `ok`, mistakes one of them for success.
 *
 * COLLAPSING "COULD NOT READ" INTO "NO ROW" INVERTS THE POST-WRITE VERIFY.
 * If the write lands and the read-back then fails as data, a two-state reader
 * returns null, VERIFY reports `read-back mismatch: expected on, got null`, and
 * the operator walks away believing the door is off. It is on. That is the one
 * outcome this script's whole ceremony exists to prevent.
 *
 * Returns `{ ok: true, row }` | `{ ok: false, why }`.
 */
async function flag(key) {
  let r;
  try {
    r = await db.$runCommandRaw({
      find: "SystemFlag",
      filter: { key },
      limit: 1,
    });
  } catch (e) {
    return { ok: false, why: e?.message ?? String(e) };
  }
  if (!r || r.ok !== 1 || !r.cursor) {
    return {
      ok: false,
      why: `unexpected reply: ${JSON.stringify(r?.errmsg ?? r?.ok ?? null)}`,
    };
  }
  const batch = Array.isArray(r.cursor.firstBatch) ? r.cursor.firstBatch : [];
  // `SystemFlag.key` carries a Prisma `@unique`, AND A PRISMA `@unique` CREATES
  // NOTHING ON MONGODB — the same fact this script's own header states about
  // EventAttendance, applied to the row it writes itself. With two rows under
  // one key, this `find` and the app's `findUnique` can read DIFFERENT
  // documents: the script would print "off" while the door stayed live. Refuse
  // rather than silently pick one. Same countermeasure as
  // verify-recruitment-gate.mjs.
  if (batch.length > 1) {
    return { ok: false, why: `${batch.length} rows share key "${key}"` };
  }
  return { ok: true, row: batch[0] ?? null };
}

async function indexEnforcing() {
  // Read-only. Reports whether EventAttendance's unique index exists, so the
  // operator is told BEFORE flipping the switch rather than discovering it from
  // a wrong headcount afterwards. Absence is not fatal here — this script
  // refuses instead, below — but a failed read must not read as "present".
  try {
    const r = await db.$runCommandRaw({ listIndexes: "EventAttendance" });
    const ix = r?.cursor?.firstBatch ?? [];
    return ix.some(
      (i) =>
        i.unique === true &&
        // Key NAMES and their ORDER, which for a compound index is its meaning.
        // The index's own `name` is deliberately NOT checked: `db push` and a
        // hand-run `createIndexes` produce different names for the same index,
        // so a name match reports a false failure.
        Object.keys(i.key ?? {}).join(",") === "eventID,userID" &&
        // AND IT MUST ENFORCE OVER THE WHOLE COLLECTION. A unique index that is
        // partial, sparse, or collated satisfies both checks above while
        // enforcing almost nothing: `partialFilterExpression: { method: "qr" }`
        // would let a MANUAL check-in of someone already QR-scanned write a
        // second row — silently, which is the precise failure this gate exists
        // to prevent. Anything carrying one of these is not the index we need.
        i.partialFilterExpression === undefined &&
        i.sparse !== true &&
        i.collation === undefined,
    );
  } catch {
    // NamespaceNotFound is the ordinary pre-rollout state, and any other read
    // failure is indistinguishable from here. Either way: not proven present.
    return false;
  }
}

async function main() {
  console.log(`\n=== set-attendance-flag.mjs ===`);

  const [beforeR, parentR, hasIndex] = await Promise.all([
    flag(KEY),
    flag(PARENT_KEY),
    indexEnforcing(),
  ]);

  // A FAILED READ IS RENDERED AS A FAILED READ, never as "(no row)". That is
  // the fabricated-zero class index-census.mjs names: an unreadable flag shown
  // as absent reads as "the door is off" to the person deciding whether it is
  // safe to walk away from it.
  const before = beforeR.ok ? beforeR.row : null;
  const parent = parentR.ok ? parentR.row : null;

  console.log(
    `current: ${
      !beforeR.ok
        ? `UNREADABLE — ${beforeR.why}`
        : before
          ? JSON.stringify(before.value)
          : "(no row — the door is OFF)"
    }`,
  );
  console.log(
    `parent ${PARENT_KEY}: ${
      !parentR.ok
        ? `UNREADABLE — ${parentR.why}`
        : parent
          ? JSON.stringify(parent.value)
          : "(no row — OFF)"
    }`,
  );
  console.log(
    `EventAttendance unique index: ${hasIndex ? "PRESENT" : "NOT PRESENT"}`,
  );

  if (!MODE) {
    console.log(
      `\nusage: node scripts/remediation/set-attendance-flag.mjs <${MODES.join("|")}> [--commit]`,
    );
    return;
  }
  if (!MODES.includes(MODE)) {
    return abort(
      `mode must be one of ${MODES.join(" | ")} — got ${JSON.stringify(MODE)}`,
    );
  }

  // REFUSES TO TURN ON WITHOUT THE INDEX. Turning OFF is always allowed: the
  // whole point of a kill switch is that it works when things are wrong, and
  // making the off-path conditional on a healthy database would be exactly
  // backwards.
  if (MODE === "on" && !hasIndex) {
    return abort(
      `EventAttendance's unique {eventID,userID} index is NOT present, so a\n` +
        `  double scan would write a second row and every headcount would be\n` +
        `  silently wrong. A Prisma @@unique creates nothing on MongoDB.\n\n` +
        `  Run this first, then re-run:\n` +
        `    node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit\n` +
        `    node scripts/remediation/verify-events-schema.mjs\n\n` +
        `  (Turning the flag OFF is never blocked by this check.)`,
    );
  }

  // TURNING ON REQUIRES A SUCCESSFUL READ OF THE PARENT, not merely a read that
  // came back falsy. Turning OFF requires nothing at all: a kill switch that
  // needs a healthy database to pull is not a kill switch, so an unreadable
  // parent must never stand between an operator and `off`.
  if (MODE === "on" && !parentR.ok) {
    return abort(
      `could not read ${PARENT_KEY} (${parentR.why}), so it cannot be proven on.\n` +
        `  Refusing to turn the door on against a flag nobody can read.`,
    );
  }

  if (MODE === "on" && parent?.value !== "on") {
    return abort(
      `${PARENT_KEY} is not "on", so the door would stay dark anyway —\n` +
        `  every attendance procedure asserts the parent flag first. Turn the\n` +
        `  events feature on before its door.`,
    );
  }

  console.log(
    `\n  ${COMMIT ? "+" : "~"} ${KEY}: ${JSON.stringify(before?.value ?? null)} -> ${JSON.stringify(MODE)}`,
  );
  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }

  const reply = await db.$runCommandRaw({
    update: "SystemFlag",
    updates: [
      {
        q: { key: KEY },
        u: {
          $set: {
            key: KEY,
            value: MODE,
            updatedAt: nowExt(),
            updatedBy: "script:set-attendance-flag",
          },
        },
        upsert: true,
      },
    ],
  });
  const r = inspectWriteReply(reply, KEY);
  if (r.writeErrors.length) {
    console.error(`  ! WRITE FAILED: ${JSON.stringify(r.writeErrors)}`);
    return abort(`the flag was NOT changed.`);
  }

  const afterR = await flag(KEY);
  console.log(`\n=== VERIFY ===`);
  // THE WRITE HAS ALREADY LANDED BY THIS POINT, so an unreadable read-back is
  // NOT a mismatch and must not be reported as one. "read-back mismatch:
  // expected on, got null" sends the operator away believing the door is off
  // while it is live — the exact inversion this VERIFY exists to catch. Say
  // what is actually true: the change was sent, and could not be confirmed.
  if (!afterR.ok) {
    console.log(`${KEY} = UNREADABLE — ${afterR.why}`);
    return abort(
      `THE WRITE WAS SENT AND MAY WELL HAVE APPLIED — the read-back failed, so\n` +
        `  this script cannot confirm it either way. DO NOT assume the flag is\n` +
        `  unchanged. Re-run WITHOUT --commit to read it again.`,
    );
  }
  const after = afterR.row;
  console.log(`${KEY} = ${JSON.stringify(after?.value ?? null)}`);
  if (after?.value !== MODE) {
    return abort(
      `read-back mismatch: expected ${MODE}, got ${JSON.stringify(after?.value ?? null)}`,
    );
  }
  if (MODE === "on") {
    console.log(
      `\nThe door is now live for every published event in its check-in window.\n` +
        `If something is wrong at a real door, turn it off from a phone:\n` +
        `  node scripts/remediation/set-attendance-flag.mjs off --commit`,
    );
  }
}

main()
  // CONDITIONAL ON THE EXIT CODE. Every refusal in this file is
  // `return abort(...)`, and abort() sets process.exitCode and RETURNS — it
  // does not throw — so main() resolves and this .then fires on all of them.
  // Printing "Done." underneath an ABORT banner is how an operator skim-reads a
  // refusal as a success, on a phone, in the dark, beside a door that is not
  // working. Same fix and same reason as create-event-phase2-indexes.mjs.
  .then(() =>
    console.log(process.exitCode ? "\nAborted — see above." : "\nDone."),
  )
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
