/**
 * THE LOCAL-DATABASE GATE shared by the dev scripts (seed-transcript.mjs and
 * db-push.mjs): they refuse to touch anything but the local Docker database,
 * `rhapp_transcript_dev` on localhost or 127.0.0.1. It runs before any client
 * is created, so a `.env` that points at production can never be written to.
 */
import { existsSync, readFileSync } from "node:fs";

export const REQUIRED_DB = "rhapp_transcript_dev";

/** DATABASE_URL from the environment, else from `.env`, else undefined. */
export function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^DATABASE_URL=("?)(.*)\1$/.exec(line.trim());
      if (m) return m[2];
    }
  }
  return undefined;
}

/** Why `url` is not the local dev database, or null when it is. */
export function localDatabaseProblem(url) {
  if (!url) return "DATABASE_URL is not set.";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "DATABASE_URL is not a valid URL.";
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    dbName !== REQUIRED_DB
  ) {
    return (
      `host must be localhost/127.0.0.1 and database must be "${REQUIRED_DB}" ` +
      `(got host "${parsed.hostname}", database "${dbName}").`
    );
  }
  return null;
}

/**
 * The local dev database URL, or the process exits with "Refusing to <what>:
 * ...". Also pins DATABASE_URL in this process to the URL it checked.
 */
export function requireLocalDatabase(what) {
  const url = loadDatabaseUrl();
  const problem = localDatabaseProblem(url);
  if (problem) {
    console.error(`Refusing to ${what}: ${problem}`);
    process.exit(1);
  }
  process.env.DATABASE_URL = url;
  return url;
}
