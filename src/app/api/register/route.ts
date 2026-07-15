import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { hashPassword } from "~/lib/password";
import { rateLimit, clientIp } from "~/lib/rateLimit";

interface registerPayload {
  email: string;
  password: string;
  confirmPassword: string;
  fullName: string;
  bio: string;
  blockNumber: string;
  telegramHandle: string;
}

export async function POST(req: Request) {
  try {
    // Throttle account creation per IP (#5).
    const limit = await rateLimit(`register:${clientIp(req)}`, 10, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
      );
    }

    const {
      email,
      password,
      confirmPassword,
      fullName,
      bio,
      blockNumber,
      telegramHandle,
    }: registerPayload = await req.json();
    if (
      !email ||
      !password ||
      !confirmPassword ||
      !fullName ||
      !bio ||
      !blockNumber ||
      !telegramHandle
    ) {
      return NextResponse.json(
        { error: "Please fill in all fields." },
        { status: 400 },
      );
    }

    if (!email.endsWith("@u.nus.edu") || email.endsWith("@nus.edu.sg")) {
      return NextResponse.json({ error: "Invalid Email" }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password should be at least 8 characters long." },
        { status: 400 },
      );
    }
    if (password !== confirmPassword) {
      return NextResponse.json(
        { error: "Passwords do not match." },
        { status: 400 },
      );
    }

    const existingUser = await db.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
      },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User already exists." },
        { status: 400 },
      );
    }

    const hashedPassword = await hashPassword(password);
    const newUser = await db.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: hashedPassword,
        userID: email.toUpperCase().replace("@U.NUS.EDU", ""),
        telegramHandle: telegramHandle,
        displayName: fullName,
        block: Number(blockNumber),
        bio: bio,
      },
    });

    return NextResponse.json(
      { message: "User created successfully.", userId: newUser.id },
      { status: 201 },
    );
  } catch (err) {
    console.error("Registration error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
