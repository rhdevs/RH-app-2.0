import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

/* -------------------------------------------------------------------------- */
/* The hall-wide CCA recruitment freeze                                        */
/* -------------------------------------------------------------------------- */

/**
 * The SystemFlag key. Exported because the JCRC control panel prints it — an
 * operator looking at the card should be able to read the key off the screen
 * and go find the row in Atlas without guessing.
 */
export const RECRUITMENT_FLAG_KEY = "cca.recruitment";
const FLAG_TTL_MS = 15_000;

/**
 * The only two states the app ever WRITES. It is deliberately not the only two
 * a READ may encounter — see the four-case table below — which is why the read
 * path narrows to this type rather than trusting it.
 */
export type RecruitmentState = "open" | "closed";

/**
 * What a read of the flag actually produced. THREE outcomes, not two: `unknown`
 * is the case where the database could not be reached at all.
 *
 * Distinguishing it from `closed` is not pedantry, it is the difference between
 * two sentences we say to a resident. Both outcomes REFUSE — see
 * assertRecruitmentOpen — but "the JCRC has closed recruitment" and "we could
 * not check" are different facts, and telling a resident the first when the
 * second is true sends them to the JCRC to ask about a decision the JCRC never
 * made. The refusal is the same; only the explanation differs.
 */
type RecruitmentReadOutcome = RecruitmentState | "unknown";

let recruitmentCache: { at: number; open: boolean } | null = null;

/**
 * Bumped by every resetRecruitmentCache(). Read before the await in
 * readRecruitmentState and compared after it, so a read that was already in
 * flight when the cache was invalidated cannot write its now-stale answer back
 * into the cache. See the long note on resetRecruitmentCache.
 */
let cacheGeneration = 0;

/**
 * THE ONE FLAG IN THIS CODEBASE THAT DEFAULTS TO ON, AND THE ONLY ONE WHOSE
 * NAME DOES NOT END IN `.enabled`. Both facts are deliberate; read this before
 * touching either.
 *
 * `cca.management.enabled`, `cca.applications.enabled` and `scrc.enabled` gate
 * NEW WRITE SURFACES, so for them "behave as the app did yesterday" means
 * DISABLED and an absent row is off (see services/scrcFlag.ts, which argues it
 * at length). This one gates an EXISTING surface: residents can apply to CCAs
 * in production right now. An absent row must therefore mean OPEN, or the day
 * this ships the hall's recruitment stops for a reason nobody chose — a
 * regression wearing a feature's clothes. There is consequently no migration,
 * no seeding step and no deploy coordination: the row simply does not exist
 * until a JCRC first presses Stop.
 *
 * It is named `cca.recruitment` rather than `cca.recruitment.enabled` precisely
 * so that nobody adds it to scripts/remediation/set-cca-flag.mjs's on/off
 * SWITCHES map by reflex and inverts it. That map's whole contract is
 * "on/off, absent means off"; this flag violates the defining property of that
 * family, so it gets a distinct key shape, a distinct vocabulary
 * (open/closed, not on/off) and its own script. It belongs instead with
 * `rbac.booking.enforcement` (services/access.ts) — the "mode vocabulary"
 * family, whose members already do not default to off.
 *
 * THE CASES, and there are FOUR of them, not two:
 *   - no row               -> OPEN    (never configured; yesterday's behaviour)
 *   - value === "open"     -> OPEN
 *   - value === "closed"   -> CLOSED
 *   - row, any other value -> CLOSED  (someone configured this deliberately and
 *                                      we cannot read what they meant. The safe
 *                                      reading of an unreadable FREEZE control
 *                                      is frozen, and a typo — "clsoed", "off" —
 *                                      then fails LOUDLY: recruitment stays shut
 *                                      and somebody reports it within the hour,
 *                                      rather than silently disarming the switch
 *                                      and going unnoticed for a week.)
 * Absence and garbage are different facts and are treated differently. Do not
 * collapse the last two branches into `row?.value !== "closed"`.
 *
 * A THROWN READ RETURNS `unknown`, WHICH REFUSES — fail closed. That is against
 * the "behave as yesterday" instinct that governs the three `.enabled` flags,
 * and it is deliberate: a freeze control that silently disarms itself on a
 * transient Atlas hiccup has the one failure mode a kill switch may not have.
 * A JCRC who pressed Stop must not discover that a failover quietly restarted
 * recruitment. The cost of being wrong in this direction is that some
 * applications are refused for a few seconds during an outage in which most of
 * the app is failing anyway; the cost of being wrong in the other direction is
 * an un-freeze nobody authorised and nobody observes.
 *
 * WHAT THIS COMMENT USED TO SAY, AND WHY IT WAS WRONG. An earlier version
 * justified fail-closed by claiming the case was unreachable — that
 * assertApplicationsEnabled, which every gated procedure calls first, would
 * already have refused a database-unreachable request with
 * CCA_APPLICATIONS_DISABLED. THAT IS FALSE. isApplicationsEnabled
 * (services/ccaApplications.ts) carries its OWN independent 15s cache and
 * answers from it without touching the database, and the two caches are
 * separate module-level variables filled at different instants. So a resident
 * can pass a cached `enabled: true` and then hit a genuinely failing read here.
 * The case is ordinary, not unreachable — which is exactly why the throw path
 * gets its own outcome and its own sentinel instead of being folded into
 * "closed" and blamed on the JCRC.
 *
 * The failure is deliberately NOT cached, same as all four sibling services
 * (scrcFlag, ccaScope, ccaApplications, access), so the next request retries
 * rather than pinning "closed" for 15s on a blip.
 */
async function readRecruitmentState(
  db: PrismaClient,
): Promise<RecruitmentReadOutcome> {
  if (recruitmentCache && Date.now() - recruitmentCache.at < FLAG_TTL_MS) {
    return recruitmentCache.open ? "open" : "closed";
  }
  // Captured BEFORE the await. See the assignment guard below.
  const generationAtStart = cacheGeneration;
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: RECRUITMENT_FLAG_KEY },
      select: { value: true },
    });
    // No row is the ONLY thing that means open-by-default. An existing row with
    // an unrecognised value is closed. See the four-case table above.
    const open = row === null ? true : row.value === "open";
    // THE GUARD. If resetRecruitmentCache() ran while this query was in flight,
    // our answer predates the write that caused the reset, and storing it would
    // undo the invalidation and serve the pre-Stop value for a further full TTL
    // measured from now. We still RETURN it to our own caller — that request
    // legitimately read the row before the write landed, and its outcome is
    // settled — but we do not let it poison the cache for everyone after us.
    if (cacheGeneration === generationAtStart) {
      recruitmentCache = { at: Date.now(), open };
    }
    return open ? "open" : "closed";
  } catch {
    return "unknown";
  }
}

/**
 * Is recruitment open? Collapses `unknown` into `false`, because a caller
 * asking a yes/no question during an outage must get the conservative answer.
 *
 * This is the READ-SIDE helper — the one that feeds the cosmetic
 * `recruitmentOpen` field on browse / getCca / myApplications /
 * listApplications. Those surfaces only decide whether a button renders
 * disabled and whether a banner mounts, so collapsing three outcomes into two
 * loses nothing there. Anything that must EXPLAIN a refusal calls
 * assertRecruitmentOpen instead, which keeps the distinction.
 */
export async function isRecruitmentOpen(db: PrismaClient): Promise<boolean> {
  return (await readRecruitmentState(db)) === "open";
}

/**
 * Test/ops seam: drop the per-lambda cache so the next read hits the row.
 *
 * Bumping the generation is not decoration. Without it, this sequence undoes
 * the reset entirely:
 *
 *   t+0ms   a resident's browse misses the cache and issues its findUnique,
 *           which reads the row while it still says "open"
 *   t+50ms  the JCRC's setState — ON THE SAME LAMBDA — upserts "closed" and
 *           calls this function, setting the cache to null
 *   t+80ms  the resident's query resolves with the pre-write "open" and
 *           assigns recruitmentCache = { at: t+80, open: true }
 *
 * The cache is now repopulated with the stale value, stamped AFTER the
 * invalidation, and serves OPEN for a further full TTL measured from t+80 —
 * so the stale-open window on that lambda exceeds the 15s the UI promises by
 * exactly the query's latency. The generation counter makes the assignment at
 * t+80 a no-op instead.
 */
export function resetRecruitmentCache(): void {
  recruitmentCache = null;
  cacheGeneration++;
}

/**
 * UNCACHED read, for the JCRC control panel ONLY.
 *
 * The panel must show what the ROW SAYS, not what this lambda last cached: a
 * JCRC who clicks Stop and then watches the card keep saying OPEN for fifteen
 * seconds concludes the button is broken. The propagation delay across the
 * other lambdas is real, and it is communicated in the panel's copy ("takes
 * effect within about 15 seconds") rather than papered over by lying about the
 * stored state.
 *
 * Never call this on a request path. It is one findUnique per load of one admin
 * screen; on the applications paths that cost is exactly what the cache above
 * exists to avoid.
 *
 * It deliberately does NOT catch: a panel that cannot read the flag must show
 * its error state, not a confident "open". The throw surfaces as the query's
 * `isError` and the card renders the retry strip.
 *
 * Note this narrows an arbitrary stored string to RecruitmentState using the
 * same rule as readRecruitmentState — anything that is not literally "open" is
 * reported as "closed" — so the panel and the gate can never disagree about
 * what a garbage value means.
 */
export async function readRecruitmentRow(db: PrismaClient): Promise<{
  state: RecruitmentState;
  updatedAt: Date | null;
  updatedBy: string | null;
}> {
  const row = await db.systemFlag.findUnique({
    where: { key: RECRUITMENT_FLAG_KEY },
    select: { value: true, updatedAt: true, updatedBy: true },
  });
  if (!row) return { state: "open", updatedAt: null, updatedBy: null };
  return {
    state: row.value === "open" ? "open" : "closed",
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Assert recruitment is open, or throw the sentinel that explains why not.
 *
 * TWO DIFFERENT REFUSALS, and the difference is the whole reason this function
 * exists rather than `if (!(await isRecruitmentOpen(db))) throw`:
 *
 *   RECRUITMENT_CLOSED   the flag says closed. A person decided this.
 *   RECRUITMENT_UNKNOWN  the flag could not be read. Nobody decided anything;
 *                        the database is unreachable.
 *
 * Both refuse. Only the message differs, and the client maps them to different
 * copy — "recruitment is closed right now" versus "we couldn't check, try
 * again in a moment". Collapsing them would tell a resident during an Atlas
 * failover that the JCRC had frozen recruitment, and they would go and ask the
 * JCRC about a decision that was never made. Do not collapse them.
 *
 * CALLED BY EXACTLY FIVE CALL SITES, in three procedures, each of which is a
 * point where the applicant pool or the roster GROWS:
 *   - ccaApplications.submitApplication  (x2: fail-fast, then inside the lock)
 *   - ccaApplications.bookSlot           (x2: same pattern)
 *   - the `accepted` BRANCH of ccaApplicationsHead.decide
 * That reach is the design, not an oversight. Read the gating matrix in the
 * plan before adding a sixth.
 *
 * BOOKING WAS ADDED ON 2026-08-25, at the user's explicit direction ("no it
 * also stops interview booking"), REVERSING plan decision D11 which had argued
 * booking should stay live so heads could finish interviewing the pool they
 * already had. The plan's D11 and §8 item 2 are annotated with the reversal.
 * Note what was NOT done: no third flag value, no second predicate. `closed`
 * simply MEANS more than it did, and there is still one flag and one predicate.
 *
 * THE PRINCIPLE THAT DECIDES WHAT IS GATED is grow-versus-shrink, and it is
 * what keeps this list from expanding by vibes. A freeze stops the pool
 * GROWING; anything that leaves it the same size or smaller stays open. So this
 * must NOT be called by:
 *   - REJECT — blocking it strands every `submitted` applicant with no way to
 *     be told no. Freezing intake is not a gag order;
 *   - WITHDRAW — it is the resident's own exit from their own application, and
 *     blocking it traps them for a reason that has nothing to do with them;
 *   - cancelSlot, either side's — and NOTE THE REASON, because the obvious one
 *     is wrong now. It is NOT "releasing a seat shrinks occupancy": while
 *     frozen nobody can claim a released seat, so the shrink buys nobody
 *     anything and that argument is void. It stays open because a resident must
 *     be able to give up a slot they cannot attend; gating it would force them
 *     to hold an interview they will miss, or to withdraw the whole application
 *     to escape it. Both directions strand somebody, so this is a choice of
 *     which harm to carry, and the harm we carry — that cancelling is ONE-WAY
 *     while frozen — is surfaced as an explicit confirmation in
 *     CancelInterviewButton rather than left to be discovered;
 *   - the head's slot CREATION procedures — a head preparing slots during a
 *     freeze is harmless precisely because this gate means nobody can claim
 *     them. "Prepare now, book later" is the inverse of the workflow D11 was
 *     written to protect, and it survives the reversal intact;
 *   - markInterviewed — it records something that already happened.
 *
 * WHAT THE FREEZE DOES NOT COVER, stated plainly because a maintainer will read
 * this file and nothing else before building on it. THE FREEZE IS NOT ABSOLUTE.
 * There are three writers of a CCA membership in this repo, and this function
 * guards two of them:
 *
 *   ccaApplications.submitApplication          GATED
 *   ccaApplicationsHead.decide (accepted)      GATED
 *   ccaAdmin.addMember (routers/ccaAdmin.ts)   *** NOT GATED — deliberate ***
 *
 * `ccaAdmin.addMember` calls the identical addCcaMember (services/ccaMembers.ts)
 * and writes the identical `ccaMember.add` audit row, and it is EXEMPT by
 * design (plan D8). It is admin-only, it sits behind its own separate
 * `cca.management.enabled` switch, it lives on a different page
 * (/admin/manage-ccas), and it is the break-glass correction path: gating it
 * would mean a roster mistake made during a freeze could not be fixed without
 * unfreezing the whole hall, which is a worse outcome and one an admin would
 * simply route around by unfreezing anyway. So: AN ADMIN CAN STILL ADD A MEMBER
 * WHILE RECRUITMENT IS FROZEN, through a differently-named and separately-
 * switched surface. If you are adding a fourth membership writer, it is your
 * job to decide which of these two lists it joins.
 *
 * What holding `manageCcaRecruitment` does NOT buy is an exemption *here*: an
 * admin who accepts an applicant through the head's `decide` is refused exactly
 * like a head, because a freeze is an operational state of the hall rather than
 * an authorisation tier, and a silent admin exemption would mean the person
 * most likely to verify the freeze is the one person who cannot observe it
 * working.
 *
 * It takes NO userID, and must not grow one. The freeze is hall-wide and
 * identity-free by construction; handing it an identity parameter is how a
 * per-user exemption sneaks in later, and it would also drag this function into
 * the absent-identity bug class (an `undefined` spent as if it were a real key)
 * for no benefit at all.
 */
export async function assertRecruitmentOpen(db: PrismaClient): Promise<void> {
  const state = await readRecruitmentState(db);
  if (state === "open") return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: state === "unknown" ? "RECRUITMENT_UNKNOWN" : "RECRUITMENT_CLOSED",
  });
}
