import { EB_Garamond, Mrs_Saint_Delafield } from "next/font/google";

// Self-hosted by next/font at build time, so the CSP's `font-src 'self'` holds.

/** Body face of the document: reads as a certificate, not as app chrome. */
export const documentSerif = EB_Garamond({
  subsets: ["latin"],
  display: "swap",
});

/**
 * THE "SIGNATURES" ARE THIS FONT. Deliberately — a script face is visibly a
 * stand-in, where an image of a hand-drawn mark would invite someone to treat
 * it as the real thing. A real transcript proves sign-off with a recorded
 * approval, not with a picture of anyone's handwriting.
 */
export const signatureScript = Mrs_Saint_Delafield({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});
