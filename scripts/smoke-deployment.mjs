/**
 * POST-DEPLOY SMOKE CHECK. Probes a deployed URL for the failures that a build
 * cannot see.
 *
 *   node scripts/smoke-deployment.mjs https://www.rhapp.lol
 *   node scripts/smoke-deployment.mjs            # defaults to SMOKE_URL env
 *
 * ---------------------------------------------------------------------------
 * WHY: THE AUTH PATH FAILED WHILE EVERY OTHER CHECK WAS GREEN
 * ---------------------------------------------------------------------------
 *
 * When bcrypt 6 broke the native-addon bundle, production looked healthy from
 * outside. `/`, `/login`, `/events` and `/availability` all returned 200 — they
 * do not import the auth module. Only `/api/auth/session` and the pages calling
 * `auth()` returned 500, so an uptime monitor pointed at the homepage saw
 * nothing wrong while nobody in the hall could sign in.
 *
 * THE LESSON IS THE SHAPE OF THE CHECK, NOT THE BUG. A module-scope import
 * failure takes out one dependency graph and leaves the rest of the app
 * standing. Probing the root URL cannot detect that. This probes the auth
 * endpoint specifically, because that is the graph with the most upstream
 * dependencies and the worst blast radius.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ASSERTS
 * ---------------------------------------------------------------------------
 *
 *   /api/auth/session   200 AND parses as JSON.
 *                       This is THE check. Unauthenticated it returns `{}`, so a
 *                       200 here proves the whole auth import graph — next-auth,
 *                       the Prisma client, the hashing module and its native
 *                       binary — loaded inside the real lambda. It is also why a
 *                       500 is unambiguous: with no session cookie the request
 *                       never reaches any of our callbacks, so a failure can
 *                       only be module load.
 *
 *   Security headers    CSP and X-Frame-Options present. Cheap regression
 *                       detection for next.config.js being reverted or a
 *                       platform-level override appearing.
 *
 *   Page routes         200 on a few representative pages, including one that
 *                       calls auth() server-side — the class of page that went
 *                       down while the static ones stayed up.
 *
 * Exits non-zero on any failure so CI can gate on it. Read-only: it issues GETs
 * and signs into nothing.
 */

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "").replace(/\/$/, "");

if (!BASE) {
  console.error(
    "\nusage: node scripts/smoke-deployment.mjs <url>   (or set SMOKE_URL)\n",
  );
  process.exit(2);
}

const TIMEOUT_MS = 20_000;

async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "rhapp-smoke-check" },
    });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    return { status: 0, headers: new Headers(), body: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log(`\nSmoke-checking ${BASE}\n`);

/* ---- 1. THE AUTH GRAPH ---------------------------------------------------
 * The one check that would have caught the bcrypt incident. */
const session = await get("/api/auth/session");
if (session.status !== 200) {
  record(false, "/api/auth/session", `HTTP ${session.status} (expected 200)`);
} else {
  try {
    JSON.parse(session.body);
    record(true, "/api/auth/session", "200 and valid JSON — auth graph loaded");
  } catch {
    // An HTML error page served with a 200 still means the route is broken.
    record(false, "/api/auth/session", "200 but body is not JSON");
  }
}

/* ---- 2. SECURITY HEADERS ------------------------------------------------- */
const root = await get("/");
const csp = root.headers.get("content-security-policy");
const xfo = root.headers.get("x-frame-options");
record(Boolean(csp), "Content-Security-Policy", csp ? "present" : "MISSING");
record(xfo === "DENY", "X-Frame-Options", xfo ?? "MISSING");

/* ---- 3. REPRESENTATIVE ROUTES -------------------------------------------
 * `/ccas` is deliberately included: it calls auth() server-side and was among
 * the 500s while the static pages stayed green. */
for (const path of ["/", "/login", "/availability", "/ccas"]) {
  const res = await get(path);
  record(res.status === 200, `GET ${path}`, `HTTP ${res.status}`);
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length > 0) {
  console.error(`${failed.length} of ${results.length} checks FAILED:\n`);
  for (const f of failed) console.error(`   ${f.label} — ${f.detail}`);
  console.error("\nThis deployment is not healthy.\n");
  process.exit(1);
}
console.log(`All ${results.length} checks passed.\n`);
