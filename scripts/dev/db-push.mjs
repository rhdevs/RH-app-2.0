/**
 * `npm run dev:db:push`: `prisma db push` for the LOCAL Docker database ONLY.
 * It refuses (and runs nothing) unless DATABASE_URL points at localhost or
 * 127.0.0.1 and the database is `rhapp_transcript_dev`: the same gate as the
 * seed. Never run a bare `prisma db push` against a shared database: it
 * silently drops `User.email_unique_ci`. Production indexes come from
 * scripts/remediation/create-transcript-indexes.mjs.
 */
import { spawnSync } from "node:child_process";
import { requireLocalDatabase } from "./localDatabase.mjs";

const url = requireLocalDatabase("push the schema");

// The checked URL is passed explicitly, so Prisma cannot pick another one.
const result = spawnSync("npx", ["prisma", "db", "push"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(result.status ?? 1);
