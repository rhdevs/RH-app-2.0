import { z } from "zod";

/**
 * Milestone evidence photos (merge proposal F21, PR 15). Server-import-free, so
 * the uploader runs the same checks as the procedures.
 *
 * The files live in a SEPARATE, PRIVATE Vercel Blob store (a private store is
 * its own store: access is fixed when it is created). Nothing here is, or
 * produces, an address the browser can fetch from the store: the app stores a
 * PATHNAME, and a browser only ever gets the evidence's own id, served by
 * src/app/api/milestone-evidence/[id]/route.ts after an access check.
 */

/** Everything stored for evidence sits under this top-level folder. */
export const EVIDENCE_PREFIX = "milestone-evidence";

/** The image types accepted. NEVER SVG: it can carry script. */
export const EVIDENCE_CONTENT_TYPES = [
  "image/webp",
  "image/png",
  "image/jpeg",
] as const;
export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

/**
 * 4 MiB. The photo is proxied through a serverless function on every view, and
 * Vercel caps a function's response body at 4.5 MB, so a larger file could be
 * stored but never shown.
 */
export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

/** Most not-yet-attached photos one CCA may hold at a time. */
export const EVIDENCE_MAX_UNATTACHED = 20;

/** An unattached photo older than this is removed by the next upload for its CCA. */
export const EVIDENCE_UNATTACHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Most stale photos one upload will clear, so a backlog cannot make it slow. */
export const EVIDENCE_CLEANUP_BATCH = 10;

/**
 * How long an upload token lasts: about five minutes, enough to send one photo.
 * The SDK's default is an hour, and one token can send many files, none of which
 * would have a row to count against the cap.
 */
export const EVIDENCE_TOKEN_VALID_MS = 5 * 60 * 1000;

/**
 * Most blobs one cleanup lists under a CCA's folder when it looks for files
 * that have no row (uploaded but never recorded). The listing is bounded, so a
 * big folder is swept over several uploads, not read whole.
 */
export const EVIDENCE_ORPHAN_SCAN_MAX = 200;

const EXT_TYPE: Record<string, EvidenceContentType> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** The content type a file name's extension stands for, or null. */
export function contentTypeForExtension(
  ext: string,
): EvidenceContentType | null {
  return EXT_TYPE[ext] ?? null;
}

/** The folder one CCA's evidence goes in. The server decides it, never the body. */
export function evidenceFolder(ccaID: number): string {
  return `${EVIDENCE_PREFIX}/${ccaID}/`;
}

/**
 * The pathname the uploader asks for. Vercel inserts `-<random>` before the
 * extension (addRandomSuffix), so the stored name is unguessable too.
 */
export function evidenceUploadPath(ccaID: number, ext: string): string {
  return `${evidenceFolder(ccaID)}evidence.${ext}`;
}

// A strict, closed shape: no dot but the extension's, no slash but the two
// separators, no percent sign, backslash, `?` or `#`. So `..`, `.`, empty
// segments and encoded separators cannot match at all.
const PATHNAME =
  /^milestone-evidence\/([1-9]\d{0,8})\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.(webp|png|jpg|jpeg)$/;

export type ParsedEvidencePath = {
  ccaID: number;
  name: string;
  ext: string;
  contentType: EvidenceContentType;
};

/**
 * The CCA and file a pathname names, or null when it is not exactly one of our
 * evidence pathnames. Case-sensitive, like blob keys.
 */
export function parseEvidencePath(pathname: string): ParsedEvidencePath | null {
  const m = PATHNAME.exec(pathname);
  if (!m) return null;
  const contentType = contentTypeForExtension(m[3]!);
  if (contentType === null) return null;
  return { ccaID: Number(m[1]), name: m[2]!, ext: m[3]!, contentType };
}

/** The host a private store's addresses have, from its id. */
export function privateStoreHost(storeID: string): string {
  return `${storeID.toLowerCase()}.private.blob.vercel-storage.com`;
}

/**
 * The pathname inside an address the upload returned, or null unless the
 * address is, EXACTLY, `https://<this private store>/<an evidence pathname>`.
 *
 * The load-bearing check at record time, since the browser sends back whatever
 * it was given. The address is parsed, then REBUILT from its parts and compared
 * with the original string, so anything the URL parser would quietly rewrite
 * (a `..` or `.` segment, a doubled slash, a default port, a backslash) makes the two differ and is refused. A `?`, a `#`, credentials,
 * a port and any percent sign (an encoded separator, say) are refused outright.
 */
export function evidencePathFromUrl(
  url: string,
  storeHost: string,
): string | null {
  if (url.length > 2048 || /[?#%\\\s]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  if (parsed.hostname !== storeHost.toLowerCase()) return null;
  const pathname = parsed.pathname.slice(1);
  if (parseEvidencePath(pathname) === null) return null;
  // Only the host's letter case may differ (host names are case-insensitive).
  const rest = url.slice("https://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const spelled = `https://${rest.slice(0, slash).toLowerCase()}/${rest.slice(slash + 1)}`;
  if (spelled !== `https://${parsed.hostname}/${pathname}`) return null;
  return pathname;
}

/** A stored evidence id: a 24-character hex ObjectId. */
export const EVIDENCE_ID = /^[a-f\d]{24}$/i;

export const evidenceListInput = z.object({
  ccaID: z.number().int().positive(),
});

/** What the browser sends after the upload: the CCA, and the address it got back. */
export const evidenceRecordInput = z.object({
  ccaID: z.number().int().positive(),
  url: z.string().min(1).max(2048),
});

export const evidenceRemoveInput = z.object({
  id: z.string().regex(EVIDENCE_ID),
});
