/**
 * `listUsers` returns a UNION of two differently-shaped branches — it pages
 * `User` normally, but pages `UserRole` when a role filter is active (paging
 * the small collection first). The two arms agree on every field the UI reads
 * but not on their exact scalar types (`block` in particular), so
 * `RouterOutputs[...]["items"][number]` is a union that TypeScript will not
 * flatMap cleanly across pages.
 *
 * This is the one shape both arms are assignable to. It is deliberately a
 * WIDENING of the server type, never a redefinition of one: if the server adds
 * a field this stays valid, and if it removes one the assignment breaks here
 * rather than silently rendering undefined.
 */
export type AdminUserRow = {
  id: string;
  /** The canonical E-format key. The ONLY id any mutation may submit (I-1). */
  canonicalUserID: string;
  /** DISPLAY ONLY — holds an A-format matric for ~515 rows. */
  legacyUserID: string | null;
  email: string | null;
  displayName: string | null;
  block: string | number | null;
  hasAccount: boolean;
  /** Server-computed: canonicalUserID(email) !== "". Never guessed here. */
  eligible: boolean;
  keyMismatch: boolean;
  /** Stored roles, with `admin` redacted for viewers without seeAdminIdentities. */
  roles: string[];
};
