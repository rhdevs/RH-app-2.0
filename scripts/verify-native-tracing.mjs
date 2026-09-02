/**
 * BUILD GUARD: every native addon a route needs must actually be BUNDLED into
 * that route's serverless function.
 *
 *   node scripts/verify-native-tracing.mjs     # run AFTER `next build`
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — a real outage, not a hypothetical
 * ---------------------------------------------------------------------------
 *
 * Bumping `bcrypt` 5.x -> 6.x took production authentication down. Everything
 * else stayed up: `/`, `/login`, `/events` all served 200 while
 * `/api/auth/session` and every page calling `auth()` returned 500. Nobody could
 * sign in.
 *
 * The cause was not the code. bcrypt 6 changed how it ships its binary:
 *
 *     5.x   node-pre-gyp   -> lib/binding/napi-v3/bcrypt_lib.node
 *     6.x   prebuildify    -> prebuilds/<platform>/bcrypt.node
 *
 * Next.js output-file tracing follows the first and MISSES the second, so the
 * `.node` file never reaches the lambda. `src/server/auth.ts` imports
 * `verifyPassword` at module scope, so one un-resolvable binary took down every
 * route in the auth graph.
 *
 * WHAT MAKES IT DANGEROUS IS THAT EVERY CHECK PASSED. `tsc`, `eslint`,
 * `next build`, a direct `require('bcrypt')` in Node, and the Vercel BUILD all
 * succeed — the binary is present on the build machine. It fails only at RUNTIME
 * inside the deployed function, which is the one place none of those look.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CHECKS
 * ---------------------------------------------------------------------------
 *
 * After a build, Next.js writes a `.nft.json` beside each server entrypoint
 * listing every file traced into it. This walks those manifests and asserts
 * that for each package in NATIVE_PACKAGES, any route that traces the package's
 * JavaScript ALSO traces at least one `.node` binary from it.
 *
 * Tracing the JS but not the binary is exactly the failure above, and it is
 * detectable here in milliseconds.
 *
 * IT IS NOT A GENERAL "does the app work" TEST. It answers one narrow question
 * that a type checker and a build cannot: did the bytes that the running code
 * will `require()` actually get shipped.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Packages that load a native addon at require() time.
 *
 * ADD TO THIS LIST when a dependency ships a `.node` file and is reachable from
 * server code. The cost of a missing entry is an outage that no other check
 * sees; the cost of a spurious entry is a loud, obvious failure here.
 */
const NATIVE_PACKAGES = ["bcrypt"];

const SERVER_DIR = ".next/server";

function findManifests(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findManifests(full, out);
    else if (entry.name.endsWith(".nft.json")) out.push(full);
  }
  return out;
}

const manifests = findManifests(SERVER_DIR);
if (manifests.length === 0) {
  console.error(
    `\n*** no .nft.json manifests under ${SERVER_DIR} — run \`next build\` first ***\n`,
  );
  process.exit(2);
}

let failures = 0;
let checked = 0;

for (const manifestPath of manifests) {
  let files;
  try {
    files = JSON.parse(fs.readFileSync(manifestPath, "utf8")).files ?? [];
  } catch {
    continue;
  }

  for (const pkg of NATIVE_PACKAGES) {
    // Match the package directory, not merely the substring: "bcryptjs" must not
    // satisfy a check written for "bcrypt".
    const owned = files.filter((f) =>
      f.replace(/\\/g, "/").includes(`node_modules/${pkg}/`),
    );
    if (owned.length === 0) continue; // this route does not use the package

    checked++;
    const binaries = owned.filter((f) => f.endsWith(".node"));
    const route = manifestPath
      .replace(/\\/g, "/")
      .replace(`${SERVER_DIR}/`, "")
      .replace(".nft.json", "");

    if (binaries.length === 0) {
      failures++;
      console.error(`\n*** ${pkg}: NO NATIVE BINARY TRACED into ${route} ***`);
      console.error(
        `    ${owned.length} JavaScript file(s) were traced, but no .node file.`,
      );
      console.error(
        `    This route will throw at require() time in the deployed function`,
      );
      console.error(
        `    while building and running perfectly on this machine.\n`,
      );
      console.error(`    Traced from ${pkg}:`);
      for (const f of owned.slice(0, 6)) {
        console.error(`      ${f.replace(/\\/g, "/").split("node_modules/").pop()}`);
      }
      console.error(
        `\n    Fix: pin the package to a version whose binary layout Next.js`,
      );
      console.error(
        `    traces, replace it with a pure-JavaScript equivalent, or force the`,
      );
      console.error(
        `    file in with experimental.outputFileTracingIncludes in next.config.js.\n`,
      );
    } else {
      console.log(
        `  ok  ${pkg} -> ${route}  (${binaries.length} binary, ${owned.length} files)`,
      );
    }
  }
}

if (checked === 0) {
  console.log(
    `\nNo route traces any of: ${NATIVE_PACKAGES.join(", ")}. Nothing to verify.`,
  );
  console.log(
    `If that is a surprise, the package may have been removed or renamed.\n`,
  );
} else if (failures > 0) {
  console.error(`\n${failures} route(s) would fail at runtime. Build not safe to deploy.\n`);
  process.exit(1);
} else {
  console.log(`\nAll ${checked} native-package route(s) have their binaries bundled.\n`);
}
