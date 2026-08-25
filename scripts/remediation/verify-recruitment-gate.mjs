/**
 * CCA recruitment freeze — invariant check and standing census. READ-ONLY.
 *
 *   node scripts/remediation/verify-recruitment-gate.mjs
 *
 * THIS SCRIPT PERFORMS NO WRITES. There is no --commit flag: it measures the
 * one SystemFlag row (`cca.recruitment`) that gates
 * ccaApplications.submitApplication, ccaApplications.bookSlot and
 * ccaApplicationsHead.decide's `accepted` branch — the three points at which
 * the applicant pool or the roster grows — and the population currently in
 * flight under it. `isCommit()` is
 * consulted ONLY to refuse — same discipline as verify-user-admin-safety.mjs.
 *
 * WHAT IT CANNOT CHECK, said plainly so nobody reads a PASS as more than it is.
 * The reader has THREE outcomes, not two: open, closed, and `unknown` — the
 * last being "the database could not be reached", which fails CLOSED and throws
 * RECRUITMENT_UNKNOWN rather than RECRUITMENT_CLOSED. This script models only
 * the two-state row mapping. It cannot model the third for the obvious reason
 * that a script whose own reads are failing cannot report on anything, so
 * fail-closed-on-throw — the freeze's most safety-critical property — is
 * asserted by nothing here and is verified only by reading
 * services/ccaRecruitment.ts or by pointing a deployment at a dead database.
 *
 * It cannot call tRPC (this is a plain Mongo script, not a Next request), so it
 * cannot exercise isRecruitmentOpen() itself. Instead it checks the DATA the
 * server-side reader depends on, encoding the same D3/D5 rule by hand
 * (mirrored in describe() below, and it must never drift from
 * isRecruitmentOpen() in src/server/api/services/ccaRecruitment.ts) so a
 * misconfigured row is caught here before a resident or a head hits it live.
 *
 * WHAT EACH CHECK IS FOR:
 * WHAT "CLOSED" REFUSES, as of 2026-08-25 — the list this script's output
 * describes, and the list a reader should check the code against:
 *   REFUSED   ccaApplications.submitApplication   (a resident applying)
 *   REFUSED   ccaApplications.bookSlot            (claiming an interview seat,
 *                                                  including rescheduling)
 *   REFUSED   ccaApplicationsHead.decide/accepted (a head accepting)
 *   ALLOWED   reject, withdraw, either side's cancelSlot, the head's slot
 *             creation, markInterviewed, and every read.
 * The rule is grow-versus-shrink: a freeze stops the pool growing, so anything
 * that leaves it the same size or smaller stays open.
 *
 *   [1] at most one cca.recruitment row     the SystemFlag.key unique index
 *                                            should make this impossible; this
 *                                            re-checks it directly rather than
 *                                            trusting the index held
 *   [2] the row's value is in vocabulary    "will be treated as CLOSED" is
 *                                            printed for anything else — the
 *                                            loud-failure property D5 exists
 *                                            for is only useful if something
 *                                            actually looks for it
 *   [3] updatedBy shape (warn only)         a hand-edited row should carry a
 *                                            real identity (E-format or an EXT
 *                                            pin), not garbage typed into Atlas
 *   [4] current state + in-flight counts    the same numbers the admin panel
 *                                            shows, so an operator can confirm
 *                                            from the shell what the card claims
 *   [5] ccaRecruitment.set audit history    freeze history, checkable without
 *                                            the admin UI
 *
 * EXIT CODES. The distinction that matters is 1 vs 2: a 1 means the checks RAN
 * and something is wrong with the data; a 2 means nothing was measured at all,
 * so it is NOT evidence that the flag is healthy.
 *   0  invariants hold. Checks [3]-[5] are informational and never affect this.
 *   1  a BLOCKING invariant failed:
 *      [1] more than one cca.recruitment row exists
 *      [2] the row exists but its value is neither "open" nor "closed"
 *   2  nothing was measured: could not connect, an unexpected throw, or the
 *      script refused to run because it was invoked with --commit / APPLY=yes.
 *      That refusal deliberately does NOT exit 1 — a misuse of the CLI must not
 *      be indistinguishable from a real invariant failure in someone's CI log.
 *
 * `process.exitCode`, never `process.exit()`. Modelled on
 * verify-user-admin-safety.mjs rather than verify-interview-slots.mjs, which
 * calls process.exit() and thereby (a) skips its own
 * `.finally(() => db.$disconnect())` and (b) can truncate buffered stdout when
 * the output is piped — including, on a bad day, the PASS/FAIL banner printed
 * one line earlier, which is the single line anyone actually reads.
 */
import { PrismaClient } from "@prisma/client";
import { findAll, countWhere, E_FORMAT, isCommit, abort } from "./lib/rbac.mjs";
import { isExtUserID } from "./lib/identity.mjs";

const db = new PrismaClient();
const KEY = "cca.recruitment";

let failed = 0;
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failed++;
};
const warn = (m) => console.log(`  warn  ${m}`);

/** Extended-JSON date -> ISO string | null. Same `.$date ?? v` pattern as
 *  dedupe-users.mjs / merge-accounts.mjs — raw $runCommandRaw replies do not
 *  come back as plain Date objects. */
const toISO = (v) => {
  if (v == null) return null;
  const d = v.$date ?? v;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toISOString();
};

/**
 * Mirrors isRecruitmentOpen()'s D3/D5 reading of the row, kept here ONLY so
 * this script can report the same answer the server would give — never call
 * this from application code, and if isRecruitmentOpen() ever changes, this
 * copy must change with it. Absence -> open. Exactly "open" -> open. Exactly
 * "closed" -> closed. Anything else -> closed, flagged unrecognised.
 */
function describe(row) {
  if (!row) return { open: true, label: `(no row — default "open")`, recognised: true };
  if (row.value === "open") return { open: true, label: `"open"`, recognised: true };
  if (row.value === "closed") return { open: false, label: `"closed"`, recognised: true };
  return {
    open: false,
    label: `${JSON.stringify(row.value)}`,
    recognised: false,
  };
}

async function main() {
  console.log(`\n=== verify-recruitment-gate.mjs (READ-ONLY) ===  ${new Date().toISOString()}\n`);

  if (isCommit()) {
    // abort() sets exitCode 1, which is this script's "an invariant is broken"
    // signal. Refusing a misuse of the CLI is a different fact and must not be
    // reported as a data problem, so the code is corrected to 2 (see the exit
    // table in the header). abort() is still used for its message formatting
    // and because every sibling refusal in this directory looks like this.
    abort(
      "verify-recruitment-gate.mjs is READ-ONLY and has no write path. Drop --commit / APPLY=yes.",
    );
    process.exitCode = 2;
    return;
  }

  // findAll() drains the WHOLE collection — SystemFlag is tiny (a handful of
  // rows: cca.management.enabled, cca.applications.enabled, scrc.enabled,
  // rbac.booking.enforcement, cca.recruitment), so filtering client-side is
  // cheaper than trusting the unique index and asking Mongo for "at most one".
  const allFlags = await findAll(db, "SystemFlag", { key: 1, value: 1, updatedAt: 1, updatedBy: 1 });
  const rows = allFlags.filter((r) => r.key === KEY);

  /* [1] AT MOST ONE ROW ----------------------------------------------------- */
  // SystemFlag.key carries a @unique index (prisma/schema.prisma), so this
  // should be structurally impossible. Checked directly anyway: an index can be
  // dropped by hand, or by a `prisma db push` run against advice (R4), and a
  // second cca.recruitment row with a different value would make "the current
  // state" genuinely ambiguous rather than merely misread.
  console.log(`[1] at most one "${KEY}" row (blocking)`);
  console.log(`  rows found: ${rows.length}`);
  if (rows.length > 1) {
    fail(
      `${rows.length} rows carry key ${JSON.stringify(KEY)}. The unique index did not hold, ` +
        `or was dropped. Values: ${rows.map((r) => JSON.stringify(r.value)).join(", ")}`,
    );
  }

  const row = rows[0] ?? null;
  const state = describe(row);

  /* [2] VALUE IN VOCABULARY --------------------------------------------------*/
  // Absence and garbage are different facts (plan D5): no row is a green
  // "never configured, defaults open"; a row that exists but is unreadable is
  // reported as CLOSED because that is what isRecruitmentOpen() will actually
  // do with it, and a typo must fail loudly rather than silently disarm the
  // freeze.
  console.log(`\n[2] value in {"open","closed"} (blocking)`);
  if (!row) {
    console.log(`  no row — nothing to check. Default applies: OPEN.`);
  } else if (!state.recognised) {
    fail(
      `${KEY} = ${state.label} — not "open" or "closed". ` +
        `WILL BE TREATED AS CLOSED by isRecruitmentOpen() (D5): until this is ` +
        `corrected, a resident cannot apply, nobody can book or reschedule an ` +
        `interview, and a head cannot accept.`,
    );
  } else {
    console.log(`  ${KEY} = ${state.label} — recognised.`);
  }

  /* [3] updatedBy SHAPE (warn only) ------------------------------------------*/
  // Not blocking: an odd updatedBy does not change what the flag DOES, only
  // whether "who changed this" is trustworthy. `script:`-prefixed values are
  // legitimate (set-cca-recruitment.mjs writes `script:set-cca-recruitment`;
  // other break-glass scripts write their own `script:...` literals) and are
  // never held to the identity shape below.
  console.log(`\n[3] updatedBy shape (warn only)`);
  if (row && row.updatedBy != null && !String(row.updatedBy).startsWith("script:")) {
    const ub = String(row.updatedBy);
    const looksValid = E_FORMAT.test(ub) || isExtUserID(ub);
    console.log(`  updatedBy: ${JSON.stringify(ub)}`);
    if (!looksValid) {
      warn(
        `updatedBy ${JSON.stringify(ub)} is neither E-format (${E_FORMAT}) nor an EXT pin, ` +
          `and is not "script:"-prefixed. Looks hand-typed into Atlas rather than written by the ` +
          `admin panel or a remediation script.`,
      );
    }
  } else if (row) {
    console.log(`  updatedBy: ${row.updatedBy == null ? "(absent)" : JSON.stringify(row.updatedBy)}`);
  } else {
    console.log(`  n/a — no row.`);
  }

  /* [4] CURRENT STATE + IN-FLIGHT COUNTS -------------------------------------*/
  // The same numbers RecruitmentControlPanel reads (minus the 15s-cache vs
  // direct-read distinction — this script always reads directly, same as the
  // panel per plan D17), so an operator can confirm from the shell what the
  // card on /admin/ccas claims without trusting the UI.
  console.log(`\n[4] current state + in-flight counts`);
  console.log(`  state:      ${state.open ? "OPEN" : "CLOSED"}  (${state.label})`);
  console.log(`  updatedAt:  ${row ? (toISO(row.updatedAt) ?? "(absent)") : "n/a — no row"}`);
  console.log(`  updatedBy:  ${row ? (row.updatedBy ?? "(absent)") : "n/a — no row"}`);

  const submitted = await countWhere(db, "CcaApplication", { status: "submitted" });
  const interviewScheduled = await countWhere(db, "CcaApplication", { status: "interview_scheduled" });
  const interviewed = await countWhere(db, "CcaApplication", { status: "interviewed" });
  const ccaCount = await countWhere(db, "CCA", {});
  console.log(`  CcaApplication status=submitted:            ${submitted}`);
  console.log(`  CcaApplication status=interview_scheduled:  ${interviewScheduled}`);
  console.log(`  CcaApplication status=interviewed:           ${interviewed}`);
  console.log(`  CCA (total):                                 ${ccaCount}`);
  if (!state.open && (submitted > 0 || interviewScheduled > 0 || interviewed > 0)) {
    console.log(
      `  (recruitment is CLOSED — these are applicants already in the pipeline. ` +
        `They cannot apply, book or reschedule an interview, or be accepted; ` +
        `reject, withdraw, cancelling a slot and running an already-booked ` +
        `interview all still work.)`,
    );
  }

  /* [5] AUDIT HISTORY ---------------------------------------------------------*/
  // "ccaRecruitment.set" is registered in AUDIT_ACTIONS (roles.ts) precisely so
  // it is not the kind of unregistered garbage action R6 warns about — but
  // AuditEntry.action is still bare `string`, so this script reads it back the
  // same defensive way rather than assuming the registration was honoured.
  //
  // SERVER-SIDE FILTERED, deliberately NOT findAll(). Every other read in this
  // script drains a tiny collection (SystemFlag holds a handful of rows), but
  // RoleAuditLog is the append-only history of every role change, bulk import,
  // denial and PII read this hall has ever produced — it is the largest
  // collection in the database and it only grows. Draining it into memory to
  // filter five rows out client-side would make a read-only census script the
  // heaviest query anyone runs, and it would get slower every month. The
  // `at_desc` index serves the sort, and the limit bounds the reply.
  console.log(`\n[5] "ccaRecruitment.set" audit history`);
  const auditCount = await countWhere(db, "RoleAuditLog", {
    action: "ccaRecruitment.set",
  });
  const lastReply = await db.$runCommandRaw({
    find: "RoleAuditLog",
    filter: { action: "ccaRecruitment.set" },
    projection: { at: 1, actorUserID: 1, rolesAfter: 1, reason: 1 },
    sort: { at: -1 },
    limit: 1,
  });
  const recruitmentAudit = lastReply?.cursor?.firstBatch ?? [];
  console.log(`  rows: ${auditCount}`);
  if (recruitmentAudit.length > 0) {
    const last = recruitmentAudit[0];
    console.log(
      `  most recent: at=${toISO(last.at)}  actor=${last.actorUserID}  ` +
        `state=${(last.rolesAfter ?? []).join(",") || "(none)"}` +
        `${last.reason ? `  reason=${JSON.stringify(last.reason)}` : ""}`,
    );
  } else {
    console.log(`  none yet — the flag has never been changed through an audited path ` +
      `(the admin panel, or a remediation script writing this action).`);
  }

  console.log(`\n=== ${failed === 0 ? "PASS" : `FAIL (${failed} blocking)`} ===\n`);
  // exitCode, not exit(): see the header. Setting it lets the process end
  // naturally, which runs the .finally() below and flushes stdout.
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(`\nUNEXPECTED: ${e?.stack ?? e}\n`);
    // NOT an unconditional 2. Checks [1] and [2] — the only blocking ones —
    // complete before any of the throwing reads further down ([4]'s counts and
    // [5]'s audit query). So a run that has ALREADY proved a blocking failure
    // and then loses the connection would report 2, whose documented meaning is
    // "nothing was measured, this is NOT evidence the flag is healthy" — and CI
    // could not tell a duplicated cca.recruitment row from a network blip. A
    // detected failure outranks a later connectivity problem: once `failed` is
    // non-zero we know something is wrong with the DATA, and that is a 1.
    process.exitCode = failed > 0 ? 1 : 2;
  })
  .finally(() => db.$disconnect());
