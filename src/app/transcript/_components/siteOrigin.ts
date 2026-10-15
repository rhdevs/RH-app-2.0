import "server-only";

import { headers } from "next/headers";
import { env } from "~/env";
import { resolveSiteOrigin } from "~/lib/transcript/pageState";

/**
 * The site's own verification address, e.g. "https://example.org/verify", for
 * the text printed on a transcript's notes page. Derived from the request (so a
 * preview deploy prints its own address) with NEXTAUTH_URL as the fallback;
 * undefined when neither is usable, and the document words around it.
 */
export function getVerifyUrl(): string | undefined {
  const h = headers();
  const origin = resolveSiteOrigin({
    host: h.get("x-forwarded-host") ?? h.get("host"),
    proto: h.get("x-forwarded-proto"),
    envUrl: env.NEXTAUTH_URL,
  });
  return origin ? `${origin}/verify` : undefined;
}
