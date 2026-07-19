/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

/** @type {import("next").NextConfig} */
const config = {
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
     * it: `vercel blob get-store <id>` prints the Base URL.
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: "inulolpf1lvj86dh.public.blob.vercel-storage.com",
        pathname: "/**",
      },
    ],
  },
};

export default config;
