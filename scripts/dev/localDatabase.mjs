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
  // Plain mongodb:// only: a mongodb+srv:// name is looked up in DNS, so the
  // host it names is not the host it connects to.
  if (parsed.protocol !== "mongodb:") {
    return `the scheme must be "mongodb:" (got "${parsed.protocol}").`;
  }
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.pathname !== `/${REQUIRED_DB}`
  ) {
    return (
      `host must be localhost/127.0.0.1 and the path must be "/${REQUIRED_DB}" ` +
      `(got host "${parsed.hostname}", path "${parsed.pathname}").`
    );
  }
  // What was checked is what is used: a URL the parser had to rewrite (such
  // as "/prod/../${REQUIRED_DB}") may name another database to the driver.
  if (parsed.href !== url) {
    return "DATABASE_URL must be written exactly as it parses (no dot segments).";
  }
  return null;
}

/**
 * The local dev database URL, or the process exits with "Refusing to <what>:
 * ...". The URL passed on is the one rebuilt from the parsed parts that were
 * checked, and DATABASE_URL in this process is pinned to it.
 */
export function requireLocalDatabase(what) {
  const url = loadDatabaseUrl();
  const problem = localDatabaseProblem(url);
  if (problem) {
    console.error(`Refusing to ${what}: ${problem}`);
    process.exit(1);
  }
  const checked = new URL(url).href;
  process.env.DATABASE_URL = checked;
  return checked;
}
