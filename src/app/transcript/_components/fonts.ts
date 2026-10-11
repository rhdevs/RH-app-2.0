import { EB_Garamond } from "next/font/google";

// Self-hosted by next/font at build time, so the CSP's `font-src 'self'` holds.

/**
 * Letterhead only. The record itself is set in plain Arial, the way official
 * transcripts are: it should read as an administrative document, not a
 * certificate.
 */
export const letterheadSerif = EB_Garamond({
  subsets: ["latin"],
  display: "swap",
});
