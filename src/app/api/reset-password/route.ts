import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

const prisma = new PrismaClient();

interface ResetPayload {
  email: string;
  password: string;
}

export async function POST(req: Request) {
  try {
    const { email, password }: ResetPayload = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Missing email or password." },
        { status: 400 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password should be at least 8 characters long." },
        { status: 400 },
      );
    }

    const existingUser = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
    });

    if (!existingUser) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const hashedPassword = createHash("sha256").update(password).digest("hex");

    await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        passwordHash: hashedPassword,
      },
    });

    return NextResponse.json(
      { message: "Password has been reset." },
      { status: 201 },
    );
  } catch (err) {
    console.error("Error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
