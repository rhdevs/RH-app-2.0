import { z } from "zod";

import { CCA_BLOB_HOST } from "~/lib/schemas/cca";
import {
  EVENT_IMAGE_CONTENT_TYPES,
  EVENT_IMAGE_MAX_BYTES,
} from "~/lib/schemas/event";

/**
 * Proposal posters and document links (merge proposal 4.5, F09, F10).
 * Server-import-free, so the form runs the same checks as the procedure.
 *
 * POSTERS follow the Event image pattern: the browser uploads straight to the
 * public Vercel Blob store with a short-lived token, and the server stores only
 * a validated address. The store is public and addresses are unguessable
 * (random suffix), which is how Event images work too.
 *
 * DOCUMENT LINKS are text. The server never fetches one.
 */

export const PROPOSAL_BLOB_HOST = CCA_BLOB_HOST;
export const PROPOSAL_POSTER_CONTENT_TYPES = EVENT_IMAGE_CONTENT_TYPES;
export const PROPOSAL_POSTER_MAX_BYTES = EVENT_IMAGE_MAX_BYTES;
export const PROPOSAL_DOC_LINK_MAX = 2048;

const PROPOSAL_ID = /^[a-f\d]{24}$/i;

/** Upload pathname for a poster; Vercel appends `-<random>.<ext>`. */
export function proposalPosterPath(proposalID: string): string {
  return `proposal/${proposalID}/poster`;
}

/** The proposal a client-supplied upload pathname names, or null. */
export function parseProposalUploadPath(
  pathname: string,
): { proposalID: string } | null {
  const m = /^proposal\/([a-f\d]{24})\/poster$/.exec(pathname);
  return m ? { proposalID: m[1]! } : null;
}

/**
 * The stored form of a poster address, or null if it is not one of OUR poster
 * blobs for THIS proposal. The load-bearing check, since the browser sends
 * whatever address it got back. Requires https, no credentials, port, query
 * string or fragment, the store's exact host, and a path that is, CASE-
 * SENSITIVELY (blob keys are), `/proposal/<this id>/poster` plus Vercel's
 * random suffix. Another proposal's poster, an Event image and a CCA image all
 * fail. The result is `origin + pathname`, so two spellings of one blob can
 * never be stored, or compared, as different addresses.
 */
export function normalizePosterUrl(
  url: string,
  proposalID: string,
): string | null {
  if (!PROPOSAL_ID.test(proposalID)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.host !== PROPOSAL_BLOB_HOST) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (url.includes("?") || url.includes("#")) return null;
  const prefix = `/${proposalPosterPath(proposalID.toLowerCase())}`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  if (!/^[-\w.]*$/.test(parsed.pathname.slice(prefix.length))) return null;
  return `${parsed.origin}${parsed.pathname}`;
}

export function isOwnProposalPosterUrl(
  url: string,
  proposalID: string,
): boolean {
  return normalizePosterUrl(url, proposalID) !== null;
}

/**
 * A document link as it will be stored, or null if it is not acceptable:
 * https only, at most 2048 characters (before and after normalising), no
 * credentials, no whitespace or control characters, and a host.
 */
export function normalizeDocLink(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.length > PROPOSAL_DOC_LINK_MAX) return null;
  if (/[\s\p{Cc}\p{Cf}]/u.test(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname === "") return null;
  if (parsed.href.length > PROPOSAL_DOC_LINK_MAX) return null;
  return parsed.href;
}

/** Blank clears the link (null); anything else must pass `normalizeDocLink`. */
export const docLinkField = z
  .string()
  .max(PROPOSAL_DOC_LINK_MAX * 2)
  .transform((s, ctx) => {
    if (s.trim() === "") return null;
    const link = normalizeDocLink(s);
    if (link === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "The link must start with https:// and be at most 2048 characters, with no username or password",
      });
      return z.NEVER;
    }
    return link;
  })
  .nullable();
