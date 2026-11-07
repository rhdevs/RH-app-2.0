import {
  BlobAccessError,
  BlobClientTokenExpiredError,
  BlobContentTypeNotAllowedError,
  BlobError,
  BlobFileTooLargeError,
  BlobNotFoundError,
  BlobPathnameMismatchError,
  BlobRequestAbortedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  BlobUnknownError,
  del,
  get,
  head,
  list,
} from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { env } from "~/env";
import { privateStoreHost } from "~/lib/schemas/milestoneEvidence";

/**
 * EVERY call to the private evidence store lives in this one file, so changing
 * the storage (another provider, signed URLs, a different Blob mode) is a
 * change here and nowhere else. Kept out of services/milestones/ on purpose:
 * that folder's code catches nothing (proposalSourceScans), and the delete
 * below must catch. A source scan keeps the evidence code away from the public
 * event upload path (milestoneSourceScans.test.ts).
 *
 * WHY EVERY CALL PASSES THE TOKEN EXPLICITLY. The SDK falls back to
 * BLOB_READ_WRITE_TOKEN, the PUBLIC store's token, when no `token` is given.
 * Evidence sent that way would land in the public store and be readable by
 * anyone with its address. So there is no code path here that omits the token,
 * and a missing or misconfigured private token REFUSES (it never falls back).
 *
 * The browser uploads straight to the store with a short-lived client token
 * minted in api/milestone-evidence/upload/route.ts. Reads cannot be given to
 * the browser at all: a private store's addresses need the token, so the app
 * reads the bytes here and serves them itself (api/milestone-evidence/[id]).
 */

export const MILESTONE_STORAGE_NOT_CONFIGURED =
  "MILESTONE_STORAGE_NOT_CONFIGURED";

const TOKEN_SHAPE = /^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/;

/** The store id inside a read-write token, or null if it is not one. */
function storeIdOf(token: string): string | null {
  return TOKEN_SHAPE.exec(token)?.[1] ?? null;
}

/**
 * The private store's token. Throws MILESTONE_STORAGE_NOT_CONFIGURED when it is
 * unset, is not a read-write token, or names the SAME store as the public
 * token (which would put evidence in the public store).
 */
export function evidenceToken(): string {
  const token = env.MILESTONE_BLOB_READ_WRITE_TOKEN;
  const storeID = token ? storeIdOf(token) : null;
  if (!token || storeID === null) {
    throw new Error(MILESTONE_STORAGE_NOT_CONFIGURED);
  }
  const publicToken = env.BLOB_READ_WRITE_TOKEN;
  const publicStore = publicToken ? storeIdOf(publicToken) : null;
  if (
    publicStore !== null &&
    publicStore.toLowerCase() === storeID.toLowerCase()
  ) {
    throw new Error(MILESTONE_STORAGE_NOT_CONFIGURED);
  }
  return token;
}

/** Is the private store set up? Never throws. */
export function isEvidenceStorageConfigured(): boolean {
  try {
    evidenceToken();
    return true;
  } catch {
    return false;
  }
}

export type StoredEvidenceHead = { size: number; contentType: string };
export type StoredEvidenceRead = StoredEvidenceHead & {
  stream: ReadableStream<Uint8Array>;
};
export type StoredEvidenceListing = { pathname: string; uploadedAt: Date };

/** Page size when listing; the caller's `limit` caps the total. */
const LIST_PAGE_SIZE = 100;

/** What the evidence services need from the store; tests pass a fake. */
export interface EvidenceStorage {
  /** The host the store's addresses have. Throws when not configured. */
  host(): string;
  /** The blob's size and type, or null when it is not in the store. */
  head(pathname: string): Promise<StoredEvidenceHead | null>;
  /**
   * Up to `limit` blobs whose pathname starts with `prefix`. Never throws: a
   * listing that fails is logged by code and answers an empty list, so the
   * sweep that wanted it is skipped and nothing else is blocked.
   */
  listBlobs(prefix: string, limit: number): Promise<StoredEvidenceListing[]>;
  /** The blob's bytes, or null when it is not in the store. */
  read(pathname: string): Promise<StoredEvidenceRead | null>;
  /**
   * Delete a blob. Never throws: false means it could not be removed (logged
   * by error name only, never the message). A blob that is already gone counts
   * as removed.
   */
  remove(pathname: string): Promise<boolean>;
}

/**
 * The SDK's errors never set `name`, so every one of them would log as "Error".
 * This answers a short fixed code from the error's CLASS instead, which carries
 * no store address, token, pathname or message. The subclasses come before the
 * base class. Any other error is named by its own `name` (a Prisma or network
 * error class), and anything that is not an Error by its type.
 */
const SDK_ERROR_CODES: readonly (readonly [
  abstract new (...args: never[]) => Error,
  string,
])[] = [
  [BlobNotFoundError, "blob_not_found"],
  [BlobAccessError, "blob_access_denied"],
  [BlobStoreNotFoundError, "blob_store_not_found"],
  [BlobStoreSuspendedError, "blob_store_suspended"],
  [BlobServiceNotAvailable, "blob_service_unavailable"],
  [BlobServiceRateLimited, "blob_rate_limited"],
  [BlobRequestAbortedError, "blob_request_aborted"],
  [BlobClientTokenExpiredError, "blob_token_expired"],
  [BlobFileTooLargeError, "blob_file_too_large"],
  [BlobContentTypeNotAllowedError, "blob_content_type_not_allowed"],
  [BlobPathnameMismatchError, "blob_pathname_mismatch"],
  [BlobUnknownError, "blob_unknown"],
  [BlobError, "blob_error"],
];

export function evidenceErrorCode(err: unknown): string {
  for (const [cls, code] of SDK_ERROR_CODES) {
    if (err instanceof cls) return code;
  }
  return err instanceof Error ? err.name : typeof err;
}

/**
 * The address of a blob in the private store. `head` and `del` are given the
 * full address rather than the bare pathname: the docs accept either, but every
 * documented example passes the address, so that is the form certain to work.
 */
function blobAddress(pathname: string): string {
  const storeID = storeIdOf(evidenceToken());
  return `https://${privateStoreHost(storeID!)}/${pathname}`;
}

export const evidenceStorage: EvidenceStorage = {
  host() {
    const storeID = storeIdOf(evidenceToken());
    return privateStoreHost(storeID!);
  },

  async head(pathname) {
    try {
      const meta = await head(blobAddress(pathname), {
        token: evidenceToken(),
      });
      return { size: meta.size, contentType: meta.contentType };
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
  },

  async listBlobs(prefix, limit) {
    const found: StoredEvidenceListing[] = [];
    try {
      let cursor: string | undefined;
      while (found.length < limit) {
        const page = await list({
          prefix,
          limit: Math.min(LIST_PAGE_SIZE, limit - found.length),
          cursor,
          token: evidenceToken(),
        });
        for (const blob of page.blobs) {
          found.push({ pathname: blob.pathname, uploadedAt: blob.uploadedAt });
        }
        if (!page.hasMore || !page.cursor) break;
        cursor = page.cursor;
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "milestone_evidence_list_failed",
          error: evidenceErrorCode(err),
        }),
      );
      return [];
    }
    return found.slice(0, limit);
  },

  async read(pathname) {
    const result = await get(pathname, {
      access: "private",
      token: evidenceToken(),
    });
    if (result?.statusCode !== 200) return null;
    return {
      stream: result.stream,
      size: result.blob.size,
      contentType: result.blob.contentType,
    };
  },

  async remove(pathname) {
    try {
      await del(blobAddress(pathname), { token: evidenceToken() });
      return true;
    } catch (err) {
      if (err instanceof BlobNotFoundError) return true;
      console.error(
        JSON.stringify({
          evt: "milestone_evidence_delete_failed",
          error: evidenceErrorCode(err),
        }),
      );
      return false;
    }
  },
};

/**
 * Hand a client-upload request to Blob with the PRIVATE token. The caller's
 * `onBeforeGenerateToken` is the whole authorisation boundary; this only makes
 * sure the token it is signed with is the private store's. `onUploadCompleted`
 * is deliberately not supplied (it does not fire on localhost, and the row is
 * saved by the guarded record call, never from a callback).
 */
export function handleEvidenceUpload(args: {
  body: HandleUploadBody;
  request: Request;
  onBeforeGenerateToken: (
    pathname: string,
  ) => ReturnType<Parameters<typeof handleUpload>[0]["onBeforeGenerateToken"]>;
}): ReturnType<typeof handleUpload> {
  return handleUpload({
    token: evidenceToken(),
    body: args.body,
    request: args.request,
    onBeforeGenerateToken: (pathname) => args.onBeforeGenerateToken(pathname),
  });
}
