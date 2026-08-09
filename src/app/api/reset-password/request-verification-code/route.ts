import { NextResponse } from "next/server";
import { randomBytes } from "crypto";

import { db } from "~/server/db";
import { env } from "~/env";
import { sendPasswordResetEmail } from "~/lib/email";
import { rateLimit, clientIp } from "~/lib/rateLimit";
import { isNusStudentEmail, normalizeEmail } from "~/lib/identity";
import { pinnedUserIDFor } from "~/server/api/services/authAllowlist";

interface RequestResetPayload {
  email: string;
}

const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * THE CONSTANT RESPONSE — the one and only success-shaped reply this route
 * emits, constructed HERE and nowhere else.
 *
 * A function rather than a shared object because NextResponse bodies are
 * single-use streams; a module-level constant would be consumed by the first
 * request and empty for the second. The point of centralising it is that
 * "every non-error path returns a byte-identical reply" stops being a claim
 * two call sites have to keep agreeing on and becomes a property of there
 * being ONE construction site. Adding a field, a header or a status here
 * changes every path at once, which is the only safe way to change it.
 *
 * WHAT IT MUST BE INDISTINGUISHABLE ACROSS (see the ORDER note in POST):
 *   - the address is not eligible at all (neither @u.nus.edu nor allowlisted)
 *   - the address is eligible but no User row exists
 *   - the address is eligible, the User row exists, and a link was sent
 * Those three are the whole answer set an attacker wants.
 */
function sameResponse() {
  return NextResponse.json(
    {
      message: "If an account exists for that email, a reset link has been sent.",
    },
    { status: 200 },
  );
}

/**
 * ORDER OF OPERATIONS IS THE SECURITY PROPERTY OF THIS ROUTE. Read this before
 * moving any block.
 *
 * THIS ENDPOINT IS UNAUTHENTICATED. Every observable it produces — status,
 * body, headers — is a free read of server state for anybody on the internet.
 * The rule it now follows:
 *
 *   REFUSE ONLY ON FACTS THE CLIENT COULD HAVE COMPUTED ITSELF.
 *
 * "The body has no email field" is such a fact. "This address is on the
 * AuthAllowlist" is emphatically not: it is server state, and it is the single
 * highest-value bit in the system.
 *
 * THE ORACLE THIS REPLACED, STATED PLAINLY SO IT IS NOT RE-INTRODUCED. The
 * eligibility check used to sit ABOVE the rate limiter and return
 * `400 {"error":"Invalid Email"}`. Once the first AuthAllowlist row exists:
 *
 *     POST {email:"ngocanh.mai@nus.edu.sg"}  -> 200 + generic message
 *     POST {email:"someone.else@nus.edu.sg"} -> 400 + "Invalid Email"
 *
 * Status AND body differed, no throttle budget was consumed (the 400 returned
 * before any rate-limit key was even computed), and the address space is
 * guessable — `firstname.lastname@nus.edu.sg`. Sweeping it enumerates exactly
 * which staff addresses carry an `EXT:` authorization key, which is the target
 * list for every other attack on this feature. The pre-allowlist code did not
 * have this hole: `endsWith("@u.nus.edu")` gave EVERY @nus.edu.sg address the
 * same 400, so the bit did not exist to be read.
 *
 * TWO CHANGES CLOSE IT, and both are needed:
 *   1. The rate limiter moved ABOVE the eligibility decision, so a rejected
 *      probe costs the same budget as an accepted one. A sweep is now bounded
 *      at 20 addresses per IP per 15 minutes rather than unlimited.
 *   2. The rejection returns `sameResponse()` — the SAME object the success
 *      path returns — instead of a distinguishable 400.
 *
 * WHAT REMAINS, HONESTLY. A sent email is a network round-trip to Resend, so
 * the eligible-and-registered path is measurably slower than the ineligible
 * one. That timing channel is PRE-EXISTING IN KIND — the route has always been
 * slower for a registered @u.nus.edu address than an unregistered one, and its
 * own constant-response comment already accepted that — and it is now metered
 * by (1), which is the mitigation that actually bounds it. Do not "fix" it by
 * making the send fire-and-forget: a Resend failure currently propagates to a
 * 500, and that is the only way an operator learns delivery is broken.
 */
export async function POST(req: Request) {
  try {
    const { email }: RequestResetPayload = await req.json();

    // ADDRESS-INDEPENDENT, so it is not an oracle: it says something about the
    // REQUEST, not about any account. The client already checks this itself
    // before submitting, so it reveals nothing it did not already know.
    if (!email) {
      return NextResponse.json(
        { error: "Please enter your email." },
        { status: 400 },
      );
    }

    // I-12: THE shared normalizer. What was here was `email.toLowerCase()`
    // with NO `.trim()`, so a pasted "  e1234567@u.nus.edu " was rejected.
    const normalizedEmail = normalizeEmail(email);

    /* ---- THROTTLE FIRST (#5) --------------------------------------------
     * MOVED ABOVE THE ELIGIBILITY DECISION, and that position is the fix, not
     * a tidy-up. Below it, a rejected probe returned before any rate-limit key
     * was computed, so probing was free AND unlimited — the two properties that
     * turn a one-bit difference into a full enumeration of the staff address
     * space. Metering the refusal is what bounds a sweep to 20 addresses per IP
     * per 15 minutes, and it is also the only thing that bounds the timing
     * channel noted in the header.
     *
     * A CONSEQUENCE, ACCEPTED DELIBERATELY: the per-email bucket is now keyed
     * on addresses that may not exist, so junk keys can land in `RateLimit`.
     * The per-IP bucket caps that at 20 per IP per window, and these rows carry
     * an `expiresAt`. That is a strictly better trade than free probing.
     *
     * The 429 is NOT an oracle: it depends on request volume, never on any
     * property of the address, and it is reachable by every address equally.
     */
    const [byEmail, byIp] = await Promise.all([
      rateLimit(`reset:${normalizedEmail}`, 5, 15 * 60 * 1000),
      rateLimit(`reset-ip:${clientIp(req)}`, 20, 15 * 60 * 1000),
    ]);
    if (!byEmail.allowed || !byIp.allowed) {
      const retryAfter = Math.max(byEmail.retryAfter, byIp.retryAfter);
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    /* ---- D-7 eligibility, through the ONE shared predicate ---------------
     * THIS SITE HELD A PRIVATE COPY OF THE DOMAIN RULE, AND A BUGGY ONE:
     * `normalizedEmail.endsWith("@u.nus.edu")`. A SUFFIX TEST IS NOT AN
     * ANCHORED MATCH, so `bob@evil.com@u.nus.edu` passed it — harmless only by
     * accident, because the `db.user.findFirst` below then missed.
     * 00-overview.md §374 claims the credentials `authorize` check and the
     * register and reset-password routes were all centralised on the domain
     * rule. That claim was false for exactly this one. `isNusStudentEmail` is
     * anchored, rejects the double-@ form by its character class, and is the
     * same function the sign-in gate uses.
     *
     * THE ALLOWLIST CONSULT IS WHAT MAKES ADMIN-PROVISIONED STAFF ACCOUNTS
     * USABLE AT ALL. Such a row is created with NO passwordHash — auth.ts's
     * credentials `authorize` returns null on `!user?.passwordHash`, so the
     * account cannot be logged into until one exists — which makes THIS ROUTE
     * THE ONLY WAY IN. Without this branch the provisioned account is a
     * permanent dead end and the failure looks like a mail-delivery problem.
     *
     * NOTE WHAT IS NOT WIDENED: src/app/api/register/route.ts. Self-registration
     * stays @u.nus.edu-only, forever. That is the boundary that keeps
     * AuthAllowlist from becoming a signup path — an allowlist row lets an
     * admin-created account SET A PASSWORD, never lets a stranger CREATE one.
     *
     * IT IS A `let eligible`, NOT AN EARLY RETURN. The ineligible path must
     * fall through to the SAME `sameResponse()` every other path reaches; an
     * early return here is precisely what re-creates the oracle, whatever
     * status it carries. `isNusStudentEmail` is short-circuited first so a
     * student address never issues the allowlist query.
     *
     * Fails closed: pinnedUserIDFor returns null on any fault and never throws,
     * so a database problem degrades this to the pre-allowlist behaviour.
     */
    const eligible =
      isNusStudentEmail(normalizedEmail) ||
      (await pinnedUserIDFor(db, normalizedEmail)) !== null;

    if (eligible) {
      const existingUser = await db.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      });

      // Only send when the account actually exists, but always return the same
      // response so this endpoint doesn't reveal which emails are registered.
      if (existingUser) {
        const token = randomBytes(32).toString("hex");

        // Invalidate any earlier outstanding tokens for this account.
        await db.passwordResetSession.deleteMany({
          where: { email: normalizedEmail },
        });

        await db.passwordResetSession.create({
          data: {
            email: normalizedEmail,
            token,
            expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
          },
        });

        const base = env.APP_URL ?? env.NEXTAUTH_URL;
        const resetUrl = `${base}/reset-password?token=${token}`;

        // Delivered to the account's own stored address, never a client-supplied
        // one — the lookup above is case-insensitive, so the two can differ.
        await sendPasswordResetEmail(existingUser.email, resetUrl);
      }
    }

    // THE ONLY EXIT for every non-error path: ineligible, eligible-but-absent,
    // and eligible-and-sent all land here. See sameResponse().
    return sameResponse();
  } catch (err) {
    console.error("Error requesting password reset:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
