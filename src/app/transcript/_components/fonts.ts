import { EB_Garamond } from "next/font/google";

// Self-hosted by next/font at build time, so the CSP's `font-src 'self'` holds.

/** Body face of the document: reads as a certificate, not as app chrome. */
export const documentSerif = EB_Garamond({
  subsets: ["latin"],
  display: "swap",
});
