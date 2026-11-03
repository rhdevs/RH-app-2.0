import {
  contentTypeForExtension,
  type EvidenceContentType,
} from "~/lib/schemas/milestoneEvidence";

/**
 * The optional return photo of an equipment loan. It follows the milestone
 * evidence pattern (lib/schemas/milestoneEvidence.ts): a PRIVATE store, a
 * pathname the server decides, and an app route that checks access on every
 * view. Type, size, token lifetime and cleanup window are the evidence ones;
 * only the folder and who may see it differ. Server-import free.
 */

/** Everything stored for return photos sits under this top-level folder. */
export const EQUIPMENT_PHOTO_PREFIX = "equipment-return";

/** The one name an upload may ask for; Vercel adds `-<random>` before the extension. */
export const EQUIPMENT_PHOTO_NAME = "photo";

export const LOAN_ID = /^[a-f\d]{24}$/i;

/** The folder one loan's photo goes in. The server decides it, never the body. */
export const equipmentPhotoFolder = (loanID: string) =>
  `${EQUIPMENT_PHOTO_PREFIX}/${loanID.toLowerCase()}/`;

export const equipmentPhotoUploadPath = (loanID: string, ext: string) =>
  `${equipmentPhotoFolder(loanID)}${EQUIPMENT_PHOTO_NAME}.${ext}`;

// A closed shape, as in the evidence pathname: no `..`, no encoded separator.
const PATHNAME =
  /^equipment-return\/([a-f0-9]{24})\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.(webp|png|jpg|jpeg)$/;

export type ParsedPhotoPath = {
  loanID: string;
  name: string;
  ext: string;
  contentType: EvidenceContentType;
};

/** The loan and file a pathname names, or null when it is not exactly ours. */
export function parseEquipmentPhotoPath(
  pathname: string,
): ParsedPhotoPath | null {
  const m = PATHNAME.exec(pathname);
  if (!m) return null;
  const contentType = contentTypeForExtension(m[3]!);
  if (contentType === null) return null;
  return { loanID: m[1]!, name: m[2]!, ext: m[3]!, contentType };
}

/**
 * The pathname inside an address the upload returned, or null unless the
 * address is, EXACTLY, `https://<this private store>/<a return-photo
 * pathname>`. The same rebuild-and-compare as evidencePathFromUrl: anything the
 * URL parser would quietly rewrite makes the two differ and is refused.
 */
export function equipmentPhotoPathFromUrl(
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
  if (parseEquipmentPhotoPath(pathname) === null) return null;
  const rest = url.slice("https://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const spelled = `https://${rest.slice(0, slash).toLowerCase()}/${rest.slice(slash + 1)}`;
  if (spelled !== `https://${parsed.hostname}/${pathname}`) return null;
  return pathname;
}
