import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { sendVerificationCodeEmail } from "~/lib/email";

const prisma = new PrismaClient();

function generateResetCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export async function POST(req: Request) {
  try {
    const { email, personalEmail } = await req.json();
    if (!email) {
      return NextResponse.json(
        { error: "Please fill in all fields." },
        { status: 400 },
      );
    }

    if (!email.endsWith("@u.nus.edu") || email.endsWith("@nus.edu.sg")) {
      return NextResponse.json({ error: "Invalid Email" }, { status: 400 });
    }

    const existingUser = await prisma.user.findFirst({
      where: { email },
    });

    if (!existingUser) {
      return NextResponse.json(
        { error: "User does not exists." },
        { status: 400 },
      );
    }
    const code = generateResetCode();

    await prisma.passwordResetSession.create({
      data: {
        email: email.toLowerCase(),
        token: code,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    sendVerificationCodeEmail(personalEmail, code);
    return NextResponse.json(
      { message: "Verification code has been sent to your email." },
      { status: 201 },
    );
  } catch (err: any) {
    console.error("Error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
