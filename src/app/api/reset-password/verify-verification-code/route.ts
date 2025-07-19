import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function POST(req: Request) {
  try {
    const code = await req.json();

    const session = await prisma.passwordResetSession.findFirst({
      where: {
        email: code.email.toLowerCase(),
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!session) {
      return NextResponse.json({ error: "No code found." }, { status: 400 });
    }

    if (session.token !== code.code) {
      return NextResponse.json({ error: "Invalid code." }, { status: 400 });
    }

    if (new Date() > session.expiresAt) {
      return NextResponse.json({ error: "Code expired." }, { status: 400 });
    }
    return NextResponse.json(
      { message: "Verified successfully." },
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
