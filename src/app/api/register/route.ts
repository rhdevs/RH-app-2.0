import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { hashPassword, validatePassword } from "~/lib/password";
import { rateLimit, clientIp } from "~/lib/rateLimit";
import {
  canonicalUserID,
  isNusStudentEmail,
  normalizeEmail,
} from "~/lib/identity";
import { ensureBaseline } from "~/server/api/services/roles";

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
    const limit = await rateLimit(
      `register:${clientIp(req)}`,
      10,
      60 * 60 * 1000,
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
      );
    }

    const {
      email: rawEmail,
      password,
      confirmPassword,
      fullName,
      bio,
      blockNumber,
      telegramHandle,
    }: registerPayload = await req.json();
    if (
      !rawEmail ||
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

    // 09 §2.7 / C4. ONE normalized binding from here down — the gate, the
    // duplicate probe, the stored `email` and the userID derivation all read
    // it, so none of them can be defeated by whitespace.
    //
    // This is a REGRESSION GUARD, not a fix for deployed behaviour: the
    // shipped code gated with a case-sensitive endsWith("@u.nus.edu"), which
    // incidentally rejected " e1234567@u.nus.edu " (it does not end with the
    // literal). isNusStudentEmail() trims (identity.ts:41-42), so moving to
    // the shared predicate would let the spaced form through — while the
    // probe below folds CASE only (`mode: "insensitive"` is a collation, not
    // a trim). It would miss the existing clean row and create a second User
    // with the SAME userID: an account nobody can ever log into, because
    // auth.ts parses the login form with z.string().email(), which rejects
    // surrounding whitespace. Registration would still return 201.
    // dedupe-users.mjs's unique index is collation strength 2 — also case,
    // also not whitespace — so it would not catch the pair either. Hence this
    // must land before that script is ever run (09 §4.4).
    const email = normalizeEmail(rawEmail);

    // D-7 via the ONE shared predicate (I-12). This replaces an endsWith()
    // pair that was a live bug: it rejected "E1234567@U.NUS.EDU" outright
    // (endsWith is case-sensitive) and accepted "bob@u.nus.edu.evil.com" and
    // "bob@evil.com@u.nus.edu". A user who cannot register cannot receive the
    // resident baseline, so this rejection was a lockout, not just an
    // inconvenience. The @nus.edu.sg clause is now subsumed: the anchored
    // regex admits u.nus.edu and nothing else.
    //
    // DELIBERATELY NOT WIDENED TO THE AuthAllowlist COLLECTION, unlike
    // src/app/api/reset-password/request-verification-code/route.ts, which is.
    // SELF-REGISTRATION STAYS @u.nus.edu-ONLY, FOREVER. This is the boundary
    // that keeps the allowlist from becoming a signup path: a pin lets an
    // ADMIN-CREATED account set its first password, it must never let a
    // stranger create an account. A staff address is provisioned by an admin
    // (scripts/remediation/provision-ext-account.mjs, or
    // admin.addAuthAllowlistEntry) and never self-served. Widening this line
    // would mean anyone holding a pinned address could mint their own `User`
    // row with their own password and their own displayName, outside the
    // audited provisioning path.
    if (!isNusStudentEmail(email)) {
      return NextResponse.json({ error: "Invalid Email" }, { status: 400 });
    }

    // THE SHARED POLICY (src/lib/password.ts), not a private length check. This
    // site and api/reset-password/route.ts each held their own `length < 8`,
    // which is the shape that lets a hardening land on one password writer and
    // silently miss the other.
    const policyError = validatePassword(password);
    if (policyError) {
      return NextResponse.json({ error: policyError }, { status: 400 });
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
        // Already lower-cased and trimmed by normalizeEmail() above.
        email: email,
        passwordHash: hashedPassword,
        // I-1: the anchored shared derivation, not an unanchored .replace().
        // Guaranteed non-empty here — isNusStudentEmail() passed above, and
        // canonicalUserID() !== "" is exactly equivalent to it by construction.
        userID: canonicalUserID(email),
        telegramHandle: telegramHandle,
        displayName: fullName,
        block: Number(blockNumber),
        bio: bio,
      },
    });

    // G-A / I-8a: every path that creates a User must ensure the resident
    // baseline in the SAME request, or the account it created is silently
    // unable to book.
    //
    // Deliberately AFTER the create and deliberately NOT in a cross-collection
    // transaction with it: the baseline is repairable and the User row is not,
    // so a transaction failure would fail an otherwise-good registration to
    // protect the cheaper half. ensureBaseline never throws and takes the
    // EMAIL, canonicalizing internally (I-8d). If it returns false we still
    // return 201 — I-8b repairs at first login.
    await ensureBaseline(db, email);

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
