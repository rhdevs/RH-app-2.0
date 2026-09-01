import { NextResponse } from "next/server";

import { db } from "~/server/db";
import { hashPassword, validatePassword } from "~/lib/password";
import { rateLimit, clientIp } from "~/lib/rateLimit";

interface ResetPayload {
  token: string;
  password: string;
}

export async function POST(req: Request) {
  try {
    /* ---- THROTTLE FIRST --------------------------------------------------
     * THIS ROUTE IS UNAUTHENTICATED AND IT RUNS BCRYPT. Every request that
     * reaches the hash below spends a fixed, deliberately expensive amount of
     * CPU (cost factor 12) on a serverless lambda, on behalf of a caller who
     * has proved nothing. Without a limiter that is a free CPU-exhaustion lever
     * against the whole deployment — the token does not even have to be valid
     * to cost something, and a valid one is not required to keep asking.
     *
     * IT IS NOT A BRUTE-FORCE GUARD FOR THE TOKEN, and should not be described
     * as one: the token is 32 bytes from `randomBytes` (256 bits), so guessing
     * it is not a threat any rate limit is load-bearing against. The budget
     * here is generous precisely because it is a resource guard rather than a
     * secrecy guard — a legitimate user mistyping a new password a few times
     * must not be locked out of their own recovery.
     *
     * Keyed on the IP alone. Keying on the token would let an attacker holding
     * one stolen token exhaust nothing but their own bucket, and there is no
     * account identifier available here that is not derived from the token.
     */
    const limit = await rateLimit(
      `reset-consume:${clientIp(req)}`,
      20,
      15 * 60 * 1000,
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
      );
    }

    const { token, password }: ResetPayload = await req.json();

    if (!token || !password) {
      return NextResponse.json(
        { error: "Missing token or password." },
        { status: 400 },
      );
    }

    // THE SHARED POLICY (src/lib/password.ts), not a private length check. This
    // site and api/register/route.ts each held their own `length < 8`, which is
    // the shape that lets a hardening land on one password writer and silently
    // miss the other.
    const policyError = validatePassword(password);
    if (policyError) {
      return NextResponse.json({ error: policyError }, { status: 400 });
    }

    // The token is the only trusted input — the account is derived from the
    // stored session, never from a client-supplied email (#1).
    const session = await db.passwordResetSession.findUnique({
      where: { token },
    });

    if (!session || session.used || new Date() > session.expiresAt) {
      return NextResponse.json(
        { error: "This reset link is invalid or has expired." },
        { status: 400 },
      );
    }

    const user = await db.user.findFirst({
      where: { email: { equals: session.email, mode: "insensitive" } },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const hashedPassword = await hashPassword(password);

    // Consume the token first (single-use).
    await db.passwordResetSession.update({
      where: { token },
      data: { used: true },
    });

    /* ---- REVOKE EVERY LIVE SESSION, **BEFORE** THE PASSWORD CHANGES -------
     * THE ORDER OF THESE TWO WRITES IS THE SECURITY PROPERTY. Read this before
     * moving either.
     *
     * WHAT THIS FIXES. Sessions are JWTs with a 30-day maxAge and there is no
     * server-side session store, so changing `passwordHash` did NOT end anybody
     * else's session. An attacker holding a stolen session cookie kept full
     * access for up to a month after the victim reset their password — i.e.
     * the recovery flow did not recover the account. `CredentialRevocation` is
     * the watermark the session callback checks; see the model comment in
     * schema.prisma and the revocation branch in src/server/auth.ts.
     *
     * WATERMARK FIRST, PASSWORD SECOND, AND NOT THE OTHER WAY AROUND. Consider
     * each failure:
     *
     *   watermark ok, password write fails  -> every session (the attacker's
     *       included) is evicted, and the stored password is UNCHANGED, so the
     *       legitimate user simply signs in again with their old one and
     *       requests a fresh link. Recoverable, and the intruder is already out.
     *
     *   password written, watermark fails   -> the victim's password is now
     *       changed, they believe they have recovered the account, and the
     *       attacker's session is STILL LIVE for thirty days. Unrecoverable by
     *       any action the user can take.
     *
     * The first outcome is an inconvenience and the second is the whole bug, so
     * the expensive-to-get-wrong write goes first and the password update is
     * REACHED ONLY IF IT SUCCEEDED. That is why this is an early return and not
     * a `.catch(() => {})`: swallowing the failure here reintroduces exactly the
     * state the collection exists to make impossible.
     *
     * An `upsert`, because a user may reset more than once and the watermark is
     * a high-water mark rather than a log.
     */
    try {
      const now = new Date();
      await db.credentialRevocation.upsert({
        where: { userId: user.id },
        create: { userId: user.id, changedAt: now, reason: "password_reset" },
        update: { changedAt: now, reason: "password_reset" },
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "credential_revocation_write_failed",
          userId: user.id,
          err: String(err),
        }),
      );
      return NextResponse.json(
        {
          error:
            "We could not complete the reset securely. Please request a new link.",
        },
        { status: 500 },
      );
    }

    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: hashedPassword },
    });

    return NextResponse.json(
      { message: "Password has been reset." },
      { status: 200 },
    );
  } catch (err) {
    console.error("Error resetting password:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
