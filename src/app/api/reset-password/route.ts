import { NextResponse } from "next/server";

import { db } from "~/server/db";
import { hashPassword } from "~/lib/password";

interface ResetPayload {
  token: string;
  password: string;
}

export async function POST(req: Request) {
  try {
    const { token, password }: ResetPayload = await req.json();

    if (!token || !password) {
      return NextResponse.json(
        { error: "Missing token or password." },
        { status: 400 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password should be at least 8 characters long." },
        { status: 400 },
      );
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

    // Consume the token first (single-use), then update the password.
    await db.passwordResetSession.update({
      where: { token },
      data: { used: true },
    });

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
