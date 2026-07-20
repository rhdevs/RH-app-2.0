import { z } from "zod";

/**
 * Shared CCA-profile validation. Deliberately NOT under `src/server/`: the
 * client mirrors this validation with a real `safeParse`, so it needs the
 * runtime VALUE, and a `"use client"` component value-importing from the server
 * tree risks pulling Prisma into the browser bundle. Same reasoning, same
 * location, as `profile.ts` beside it.
 */

export const CCA_DESCRIPTION_MAX = 1000;

/* -------------------------------------------------------------------------- */
/* Image uploads                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The public `cca-images` Vercel Blob store (region sin1).
 *
 * NOT a secret — it is the public origin every CCA logo is served from, and it
 * is already in next.config.js's remotePatterns. It lives here because the URL
 * validator below is shared by client and server, and both must agree on
 * exactly one host.
 *
 * If the store is recreated its id changes: `vercel blob get-store <id>` prints
 * the Base URL, and BOTH this constant and next.config.js must be updated.
 */
export const CCA_BLOB_HOST = "inulolpf1lvj86dh.public.blob.vercel-storage.com";

/** What the browser downscales to before uploading. Convenience, not a control. */
export const LOGO_MAX_PX = 512;
export const BANNER_MAX_W = 1600;
export const BANNER_MAX_H = 400;

/**
 * The cap that actually holds, enforced by Vercel when it mints the upload
 * token (`maximumSizeInBytes` in onBeforeGenerateToken). The client-side
 * resize keeps honest uploads far below this; this stops a crafted one.
 */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export const UPLOAD_CONTENT_TYPES = [
  "image/webp",
  "image/png",
  "image/jpeg",
] as const;

export const CCA_IMAGE_KINDS = ["logo", "banner"] as const;
export type CcaImageKind = (typeof CCA_IMAGE_KINDS)[number];

/**
 * The upload pathname for a CCA's image. Vercel appends a random suffix, so the
 * stored blob is e.g. `cca/12/logo-Xy7Qa1.webp` — unguessable and immutable,
 * which is what lets the CDN cache it indefinitely.
 *
 * Built here so the client (which requests the token) and the route (which
 * authorises it) cannot disagree about the shape.
 */
export function ccaUploadPath(ccaID: number, kind: CcaImageKind): string {
  return `cca/${ccaID}/${kind}`;
}

/**
 * Inverse of ccaUploadPath, used by the upload route to work out WHICH CCA a
 * token is being requested for.
 *
 * The pathname is client-supplied, so this parse is not itself a security
 * boundary — the caller must pass the result to assertHeadsCca. What it does
 * guarantee is that a token can only ever be minted for a well-formed
 * CCA-scoped path, never for an arbitrary location in the store.
 */
export function parseCcaUploadPath(
  pathname: string,
): { ccaID: number; kind: CcaImageKind } | null {
  const m = /^cca\/(\d+)\/(logo|banner)$/.exec(pathname);
  if (!m) return null;
  const ccaID = Number(m[1]);
  if (!Number.isSafeInteger(ccaID) || ccaID <= 0) return null;
  return { ccaID, kind: m[2] as CcaImageKind };
}

/**
 * Is this URL one of OUR blobs, for THIS CCA?
 *
 * THE LOAD-BEARING CHECK. Image URLs reach the server from the client: the
 * browser uploads straight to Blob and then calls updateProfile with whatever
 * URL it got back. Without this, `updateProfile` is an arbitrary-URL write —
 * a head could point their CCA at an external image (offsite content served
 * under our name, and a hotlinking hole) or at another CCA's blob.
 *
 * Three things are checked, and all three matter:
 *   - protocol is https, so `javascript:` and `data:` can never be stored
 *   - host is EXACTLY the store's, not a suffix match — `evil-inulolpf1lvj86dh
 *     .public.blob.vercel-storage.com.attacker.test` must not pass
 *   - the path is under this CCA's own prefix
 */
export function isOwnCcaBlobUrl(
  url: string,
  ccaID: number,
  kind: CcaImageKind,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.host !== CCA_BLOB_HOST) return false;
  return parsed.pathname.startsWith(`/${ccaUploadPath(ccaID, kind)}`);
}

/* -------------------------------------------------------------------------- */
/* The mutation payload                                                        */
/* -------------------------------------------------------------------------- */

/**
 * SECURITY: this schema must NEVER gain a `ccaName`, `category`, `userID` or
 * `roles` key.
 *
 * `ccaName` and `category` live on the validator-guarded `CCA` collection and
 * are renamed only by admins through `ccaAdmin.rename`; letting a CCA head
 * submit them here would hand every head the ability to rename any CCA they
 * head, bypassing that gate. `ccaID` is present but is the TARGET, not a
 * payload field — `assertHeadsCca` authorises it per request.
 *
 * zod strips unknown keys, so the only way a head writes something they
 * shouldn't is if someone ADDS the key here.
 */
export const ccaProfileInput = z
  .object({
    // .positive(), not .nonnegative(): ccaID 0 is RESERVED — see the guards in
    // src/server/api/services/cascade.ts.
    ccaID: z.number().int().positive(),

    /**
     * Trim and length ONLY — no sanitization, matching `bio` in profile.ts.
     *
     * React escapes this on render, which is what prevents XSS. `sanitizeName`
     * exists for `displayName` alone, because that value is rendered AS AN
     * IDENTITY on other people's bookings and is therefore an impersonation
     * vector (homoglyphs, bidi overrides). A CCA description is prose displayed
     * as prose; stripping format characters from it would corrupt legitimate
     * text for no security gain. Do not copy sanitizeName here.
     *
     * "" is allowed and means "no description" — clearing one is a normal edit.
     */
    description: z
      .string()
      .trim()
      .max(
        CCA_DESCRIPTION_MAX,
        `Description must be ${CCA_DESCRIPTION_MAX} characters or fewer`,
      ),

    // null means "remove the image". Checked against isOwnCcaBlobUrl below —
    // z.string().url() alone would happily accept https://evil.example/x.png.
    logoUrl: z.string().url().nullable().default(null),
    bannerUrl: z.string().url().nullable().default(null),
  })
  .superRefine((val, ctx) => {
    if (val.logoUrl !== null && !isOwnCcaBlobUrl(val.logoUrl, val.ccaID, "logo")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["logoUrl"],
        message: "NOT_A_VALID_CCA_IMAGE_URL",
      });
    }
    if (
      val.bannerUrl !== null &&
      !isOwnCcaBlobUrl(val.bannerUrl, val.ccaID, "banner")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bannerUrl"],
        message: "NOT_A_VALID_CCA_IMAGE_URL",
      });
    }
  });

export type CcaProfileInput = z.input<typeof ccaProfileInput>;
