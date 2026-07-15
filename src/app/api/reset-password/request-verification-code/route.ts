import { NextResponse } from "next/server";
import { randomBytes } from "crypto";

import { db } from "~/server/db";
import { env } from "~/env";
import { sendPasswordResetEmail } from "~/lib/email";
import { rateLimit, clientIp } from "~/lib/rateLimit";

interface RequestResetPayload {
  email: string;
}

const TOKEN_TTL_MS = 15 * 60 * 1000;

export async function POST(req: Request) {
  try {
    const { email }: RequestResetPayload = await req.json();

    if (!email) {
      return NextResponse.json(
        { error: "Please enter your email." },
        { status: 400 },
      );
    }

    const normalizedEmail = email.toLowerCase();

    if (!normalizedEmail.endsWith("@u.nus.edu")) {
      return NextResponse.json({ error: "Invalid Email" }, { status: 400 });
    }

    // Throttle by email and by IP (#5).
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

      // Delivered to the account's own @u.nus.edu address (not a client-supplied one).
      await sendPasswordResetEmail(existingUser.email, resetUrl);
    }

    return NextResponse.json(
      {
        message:
          "If an account exists for that email, a reset link has been sent.",
      },
      { status: 200 },
    );
  } catch (err) {
    console.error("Error requesting password reset:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
