import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The gate every database test runs behind: the SAME rule as the dev scripts
 * (scripts/dev/localDatabase.mjs, `localDatabaseProblem`), so the tests touch
 * only what the seed and dev:db:push would: plain mongodb:// on localhost or
 * 127.0.0.1, the exact `rhapp_transcript_dev` path, written as it parses.
 * Loaded by path so the type checker does not read the plain .mjs file.
 */
const gate = pathToFileURL(
  join(process.cwd(), "scripts", "dev", "localDatabase.mjs"),
).href;
const { localDatabaseProblem } = (await import(/* @vite-ignore */ gate)) as {
  localDatabaseProblem: (url: string | undefined) => string | null;
};

export function isLocalDevDatabase(url: string | undefined): boolean {
  return localDatabaseProblem(url) === null;
}
