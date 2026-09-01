/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

/**
 * The `cca-images` Vercel Blob store. Named once and reused by both the image
 * allowlist and the CSP below, so the two cannot drift — a host added to one
 * and forgotten in the other is a broken image with a console error nobody
 * reads.
 */
const BLOB_HOST = "inulolpf1lvj86dh.public.blob.vercel-storage.com";

/**
 * SECURITY HEADERS. There were none of these before — not a weak set, none —
 * so every note below describes a hole rather than a tightening.
 *
 * `frame-ancestors` / X-Frame-Options ARE THE LOAD-BEARING PAIR. Without them
 * any site could iframe this app and drive it with the victim's live session:
 * the JCRC role-management surface, the bulk-import commit, the delete-user
 * flow and the door scanner are all one-click actions behind an ordinary
 * session cookie. Both are sent because the modern directive and the legacy
 * header are honoured by different things, and the legacy one is a single word.
 *
 * THE CSP IS DELIBERATELY NOT STRICT ON script-src, AND THIS IS THE HONEST
 * VERSION OF WHY: Next.js's App Router inlines bootstrap and hydration scripts,
 * so a nonce-free policy needs 'unsafe-inline', and 'unsafe-eval' is required by
 * the dev overlay and by React's development build. A CSP with 'unsafe-inline'
 * does NOT stop injected inline script — it is not an XSS defence and must not
 * be described as one in a review. What it does do is bound the HOSTS a page can
 * reach, which turns "inject a tag that loads attacker.js" into "inject a tag
 * that loads nothing", and that is worth having on its own.
 *
 * THE DIRECTIVES THAT DO CARRY REAL WEIGHT HERE, none of which need a nonce:
 *   base-uri 'self'   — an injected <base> tag can otherwise re-point every
 *                       relative URL on the page, including form posts.
 *   form-action 'self'— stops an injected form from posting credentials or a
 *                       CSRF-token-bearing body to another origin.
 *   object-src 'none' — kills the <object>/<embed> plugin surface outright.
 *   frame-ancestors   — see above.
 *
 * MOVING script-src TO NONCES IS THE FOLLOW-UP, and it is a real piece of work
 * rather than a config edit: it needs middleware to mint a per-request nonce and
 * every inline script to carry it. Do not "tighten" this by deleting
 * 'unsafe-inline' without doing that — the app will simply stop rendering.
 *
 * CAMERA IS ALLOWED FOR THIS ORIGIN AND NOTHING ELSE. The event door scanner
 * (src/app/events/[eventID]/door) reads a QR through getUserMedia, so
 * `camera=()` would silently break the check-in feature at the door, which is
 * exactly where nobody can debug it. Geolocation and microphone are denied
 * because nothing here asks for them.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://${BLOB_HOST}`,
  "font-src 'self' data:",
  // The browser uploads directly to Vercel Blob (see api/cca/upload), so the
  // store host and the Blob API host must both be reachable by fetch/XHR.
  `connect-src 'self' https://${BLOB_HOST} https://blob.vercel-storage.com https://*.public.blob.vercel-storage.com`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Two years, subdomains included. Safe to assert unconditionally: the app is
  // served over HTTPS by Vercel and has no plaintext deployment. `preload` is
  // deliberately OMITTED — submitting to the preload list is effectively
  // irreversible and is the domain owner's decision, not a config default.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

/** @type {import("next").NextConfig} */
const config = {
  // Drops the `X-Powered-By: Next.js` banner. Version disclosure is not a
  // vulnerability by itself; it is how an attacker picks which one to try.
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  images: {
    /**
     * The `cca-images` Vercel Blob store (public, sin1) — CCA logos and banners.
     *
     * THIS IS A GLOBAL ALLOWLIST: it governs every next/image in the app, not
     * just CCA logos. The host is pinned EXACTLY rather than wildcarded to
     * `**.public.blob.vercel-storage.com`, because that broader pattern would
     * let any Vercel Blob store on the internet — including someone else's —
     * be rendered through this app's image optimizer, which is both a
     * bandwidth-theft vector and a way to launder arbitrary content through
     * our domain.
     *
     * If the store is ever recreated, its id changes and this must change with
     * it: `vercel blob get-store <id>` prints the Base URL. Keep BLOB_HOST at
     * the top of this file in step — the CSP reads the same constant.
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: BLOB_HOST,
        pathname: "/**",
      },
    ],
  },
};

export default config;
