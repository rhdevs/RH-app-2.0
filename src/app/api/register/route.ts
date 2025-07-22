import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

const prisma = new PrismaClient();

export async function POST(req: Request) {
  try {
    const { email, password, confirmPassword } = await req.json();
    if (!email || !password || !confirmPassword) {
      return NextResponse.json(
        { error: "Please fill in all fields." },
        { status: 400 }
      );
    }

    if (!(email.endsWith("@u.nus.edu")) || (email.endsWith("@nus.edu.sg"))){
      return NextResponse.json(
        { error: "Invalid Email" },
        { status: 400 }
      );
    }

    if (password.length < 8){
      return NextResponse.json(
        { error: "Password should be at least 8 characters long." },
        { status: 400 }
      );
    }
    if (password !== confirmPassword) {
      return NextResponse.json(
        { error: "Passwords do not match." },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findFirst({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User already exists." },
        { status: 400 }
      );
    }

    const hashedPassword = createHash("sha256").update(password).digest("hex");
    // console.log("Creating user with:", { email, password: hashedPassword });
    const newUser = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: hashedPassword,
        userID: email.toUpperCase().replace("@U.NUS.EDU", "")
      },
    });

    return NextResponse.json(
      { message: "User created successfully.", userId: newUser.id },
      { status: 201 }
    );
  } catch (err: any) {
    console.error("Registration error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
