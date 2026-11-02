import { BlobNotFoundError, del, get, head } from "@vercel/blob";
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

/** What the evidence services need from the store; tests pass a fake. */
export interface EvidenceStorage {
  /** The host the store's addresses have. Throws when not configured. */
  host(): string;
  /** The blob's size and type, or null when it is not in the store. */
  head(pathname: string): Promise<StoredEvidenceHead | null>;
  /** The blob's bytes, or null when it is not in the store. */
  read(pathname: string): Promise<StoredEvidenceRead | null>;
  /**
   * Delete a blob. Never throws: false means it could not be removed (logged
   * by error name only, never the message). A blob that is already gone counts
   * as removed.
   */
  remove(pathname: string): Promise<boolean>;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export const evidenceStorage: EvidenceStorage = {
  host() {
    const storeID = storeIdOf(evidenceToken());
    return privateStoreHost(storeID!);
  },

  async head(pathname) {
    try {
      const meta = await head(pathname, { token: evidenceToken() });
      return { size: meta.size, contentType: meta.contentType };
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
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
      await del(pathname, { token: evidenceToken() });
      return true;
    } catch (err) {
      if (err instanceof BlobNotFoundError) return true;
      console.error(
        JSON.stringify({
          evt: "milestone_evidence_delete_failed",
          error: errorName(err),
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
