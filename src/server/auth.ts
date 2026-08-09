import type {
  GetServerSidePropsContext,
  NextApiRequest,
  NextApiResponse,
} from "next";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { type DefaultSession, type NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth/next";
import { type Adapter } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";

import { env } from "~/env";
import { db } from "~/server/db";
import { verifyPassword } from "~/lib/password";
import {
  REQUIRED_PROFILE_FIELDS,
  computeProfileGaps,
  requiredProfileFieldsFor,
} from "~/lib/profileCompleteness";
import type { CanonicalUserID } from "~/lib/identity";
// `canonicalUserID` is deliberately NOT imported here any more: the session
// callback resolves through resolvePrincipalID below, which composes it with
// the allowlist. Importing it again would invite a second, half-aware
// derivation of the session key.
import { isNusStudentEmail, normalizeEmail } from "~/lib/identity";
import {
  BASELINE_ROLE,
  ADMIN_ROLE,
  ensureBaseline,
  normalizeStoredRoles,
  redeemPendingGrants,
} from "~/server/api/services/roles";
import {
  getAuthEnforcement,
  isMatricRequired,
} from "~/server/api/services/access";
// The D-7 break-glass ALLOWLIST — the collection half. Read its header before
// touching either call site below: it is the only thing in this app that can
// turn an address the domain rule rejects into an authorization key, and the
// mechanism that keeps that safe (M2, namespace re-validation at every read)
// lives there, not here.
import {
  pinnedUserIDFor,
  resolvePrincipalID,
} from "~/server/api/services/authAllowlist";
// The ONE derivation of "does another live User row resolve to this NUSNET id".
// Imported rather than restated: a second copy is a second chance to write the
// equality-on-email version, which misses the whitespace variants that are
// precisely the rows the merge scripts delete. See the deleted-row branch below.
import { findCanonicalIdCollisions } from "~/server/api/services/userAdmin";

/**
 * D-7 + I-12. THE domain half of the eligibility predicate. The rule itself
 * lives in ~/lib/identity — this wrapper adds nothing but the ENV-VAR
 * break-glass allowlist.
 *
 * THE ENV ALLOWLIST IS SIGN-IN ONLY, AND STILL IS. An address admitted by
 * `AUTH_EMAIL_ALLOWLIST` still has `canonicalUserID() === null`, so it receives
 * no stored baseline (I-8d), holds no roles and cannot book. `resolvePrincipalID`
 * — the function that decides what key a session gets — does NOT consult this
 * variable, only the `AuthAllowlist` COLLECTION. That asymmetry is deliberate
 * and is the whole reason both survive:
 *
 *   env var    admits a sign-in during an outage in which THE DATABASE is the
 *              broken thing. Confers no identity, so it cannot be a privilege
 *              escalation vector — there is nothing to escalate.
 *   collection admits a sign-in AND mints an `EXT:` principal key. It is
 *              administered through an audited adminProcedure, revocable in
 *              seconds, and every read of it re-validates the namespace.
 *
 * If you ever make the env var mint a key, you have created an unaudited,
 * un-revocable, deploy-time identity source. Do not.
 *
 * Read from process.env rather than ~/env because src/env.js is outside this
 * change's scope; unset means "no exceptions", which is the safe default.
 */
function passesDomainRule(rawEmail: string | null | undefined): boolean {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  if (isNusStudentEmail(email)) return true;
  const allow = (process.env.AUTH_EMAIL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email);
}

/**
 * I-11 — the flag-aware D-7 decision, and the ONLY thing sign-in paths call.
 *
 * `passesDomainRule` above is the rule; this is whether we ACT on it. Split
 * deliberately: gating the rule itself would also gate the allowlist and the
 * empty-email rejection, and an empty email must be refused in every mode
 * (it canonicalizes to "", which is the ""-keyed-role hazard of I-8d).
 *
 * With the flag "off" — the default, and the state on deploy day — this
 * returns true for every non-empty address, so sign-in behaves exactly as it
 * did before D-7 shipped. See getAuthEnforcement for why this is a row and not
 * an env var.
 */
async function maySignIn(
  rawEmail: string | null | undefined,
): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  if (passesDomainRule(email)) return true;

  // The COLLECTION half of the break-glass (08 §3 Branch C). Reached ONLY for
  // an address the domain rule and the env allowlist have both already
  // rejected, so no @u.nus.edu sign-in pays for it.
  //
  // WITHOUT THIS LINE the admin-provisioned staff accounts are admitted today
  // only by accident: `rbac.auth.enforcement` defaults to "off", and in that
  // mode the fall-through below returns true for every non-empty address. The
  // day someone flips that switch to "enforce" — which is the whole point of
  // the switch existing — the hall office is locked out. Relying on a kill
  // switch staying off is not a design.
  //
  // Fails CLOSED: pinnedUserIDFor returns the absent value on any fault and
  // never throws, so a database outage degrades this to "not allowlisted",
  // which is exactly the behaviour that predates the collection.
  if ((await pinnedUserIDFor(db, email)) !== null) return true;

  const mode = await getAuthEnforcement(db);
  if (mode === "enforce") return false;

  if (mode === "permissive") {
    // Discovery mode: surface WHO would be denied, without denying them. The
    // full address is logged here (unlike the enforce-path warning, which logs
    // the domain only) because the entire point is to hand you the remediation
    // list — and unlike that path, this party is not an unauthenticated
    // stranger being probed away, it is an existing user you are about to lock
    // out. Turn this off once you have the list.
    console.warn(
      JSON.stringify({ evt: "signin_would_be_rejected", email, mode }),
    );
  }
  return true;
}

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      /**
       * C9 / 09 §5.2 / D-B. `null` — NOT `""` — is the absent identity. The
       * absent case is deliberately outside the `string` domain so that
       * `where: { userID }`, `x === userID` and `dict[userID]` do not silently
       * accept it; `tsc --noEmit` reports every such site. Runtime value is
       * unchanged in FALSINESS, so pre-existing `if (!userID)` guards still
       * hold. Narrow it once at the tRPC boundary with `identifiedProcedure`
       * (trpc.ts) rather than per site.
       */
      userID: CanonicalUserID | null;
      // `bio` was declared here but never populated by any callback, so every
      // reader got `undefined` while the type promised `string`. The profile
      // page reads bio from the tRPC query, not the session.
      // Matric attribute exposed on the session for the login gate. `matric`
      // is the stored A-format number (or null if not yet set); `hasMatric` is
      // the boolean the client guard / server middleware enforce on.
      matric: string | null;
      hasMatric: boolean;
      /**
       * I-11. Live read of the `rbac.matric.enforcement` kill switch, so the
       * client `MatricGate` is inert by default exactly like the server
       * `matricProcedure`. WITHOUT this the gate would redirect every existing
       * user to onboarding on deploy (UserMatric is new and empty) and no flag
       * flip could stop it — only a redeploy.
       */
      matricRequired: boolean;
      /**
       * Fields an account-merge could not reconcile automatically and which the
       * user must re-supply — e.g. `["matric", "telegramHandle"]`. Empty for
       * everybody who was never merged, which is everybody but a handful of
       * accounts.
       *
       * A LIVE read (I-4) of the `ProfileCompletion` collection, exactly like
       * `matric`/`roles` above and for the same reason: the user clears the
       * prompt by filling the form, and a value baked into the 30-day JWT would
       * keep prompting them until the token expired. It lives in its own
       * collection rather than on `User` because `User` carries a DB-level
       * `$jsonSchema` validator that rejects unknown fields.
       *
       * Already-resolved rows read as `[]` — see the session callback.
       */
      profileNeedsFields: string[];
      /**
       * STRICT PROFILE GATE. `profileIncomplete` is true when the user's own
       * details are missing or improper — a blank / NUSNET-id display name, no
       * Telegram handle, no block, or no matric — per
       * `src/lib/profileCompleteness.ts`. Evaluated for EVERY identified session
       * with no kill switch: the product decision is to enforce this for
       * everyone, immediately. The client `MatricGate` routes such a session to
       * `/profile` and shows a non-dismissable completion dialog;
       * `profileMissingFields` names the offending fields. A LIVE read (I-4):
       * the moment the user fills the fields and the session refreshes, this
       * clears — nothing is baked into the 30-day JWT.
       */
      profileIncomplete: boolean;
      profileMissingFields: string[];
      /**
       * D-7. False only for a pre-cutover JWT on an ineligible address, or a
       * blank/malformed stored email. RENDER-ONLY — protectedProcedure
       * re-derives it server-side.
       */
      eligible: boolean;
      /**
       * D-C. The IDENTITY FACT, not the enforcement decision: `userID !== null`,
       * i.e. this session has a canonical @u.nus.edu-derived id.
       *
       * It exists because `eligible` above is flag-aware (I-11) and therefore
       * answers a different question — "is this principal admitted under the
       * current `rbac.auth.enforcement` mode" — which is `true` for an
       * empty-identity session in every mode except `enforce`. The two agreed
       * once and silently stopped agreeing; overloading one word for both is
       * what produced 09 §2.5. Every RENDER-LAYER branch that means "does this
       * account have an identity at all" keys off THIS field (MatricGate,
       * getCurrentUserData/profile). No procedure may authorize off it, and it
       * must never be added to `protectedProcedure` — that is the kill switch
       * again, one layer down.
       */
      hasIdentity: boolean;
      /**
       * The `User` row this session was minted against (`session.user.id`, the
       * Mongo `_id` frozen into the JWT at sign-in) NO LONGER EXISTS.
       *
       * A SEPARATE FACT FROM `eligible`, and it has to be, because two very
       * different things produce it and only one of them is a revocation:
       *   - `userAdmin.delete` removed the account. The human is gone;
       *     `eligible` goes false with this.
       *   - an account MERGE removed the LOSING row (merge-by-canonical.mjs and
       *     the four one-off fix-*.mjs scripts all end in
       *     `db.user.delete({ where: { id } })`). The human is fine, their
       *     surviving row and every canonical-keyed record of theirs are intact,
       *     and `eligible` must NOT move — marking them ineligible would 403
       *     every request they make for up to the 30-day JWT lifetime for having
       *     been on the wrong half of a duplicate pair.
       *
       * RENDER-LAYER ONLY, like `hasIdentity`. It exists so MatricGate has
       * somewhere to send these sessions: in both cases the token points at a
       * row that is gone and the only action that resolves it is signing out and
       * back in. Without it the deleted case renders the whole app shell with
       * every tRPC call failing FORBIDDEN and no explanation, because
       * `hasIdentity` is still true (the email still canonicalises) and every
       * other gate flag was set to its non-blocking value.
       */
      accountMissing: boolean;
      /**
       * Live role list, re-read from the database on EVERY session read
       * (invariant I-4 — never baked into the 30-day JWT).
       *
       * FOR RENDERING ONLY (invariant I-5). Never authorize a mutation off
       * this value; every privilege-changing procedure re-reads from the DB.
       */
      roles: string[];
      isAdmin: boolean;
    } & DefaultSession["user"];
  }

  // interface User {
  //   // ...other properties
  //   // role: UserRole;
  // }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions = {
  adapter: PrismaAdapter(db) as Adapter,
  providers: [
    // Google OAuth is only registered when both credentials are configured, so
    // a deployment without them still boots (env vars are validated in env.js).
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            /**
             * RECURRENCE GUARD for the duplicate-identity class (#16).
             *
             * The registration route already normalizes (api/register/route.ts:74).
             * This is the OTHER write path into `User`, and it does not go
             * through any of our code: PrismaAdapter.createUser writes
             * `profile.email` VERBATIM into a brand-new row. So a provider
             * profile whose email differs from the stored one by case or
             * surrounding whitespace creates a SECOND User for a person who
             * already has one — the same defect merge-by-canonical.mjs exists
             * to clean up, re-created from the other side.
             *
             * `email_unique_ci` does not close this: it is a collation, which
             * folds case and NOT whitespace (that is exactly why the live row
             * "e0425010@u.nus.edu " survived every previous dedupe). The only
             * place whitespace can be removed is before the write, here.
             *
             * Overriding profile() means restating the default mapping; these
             * four fields ARE the next-auth Google default, changed only in
             * that `email` passes through the shared normalizer (I-12).
             */
            profile(profile) {
              return {
                id: profile.sub,
                name: profile.name,
                email: normalizeEmail(profile.email),
                image: profile.picture,
              };
            },
          }),
        ]
      : []),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsedCredentials = z
          .object({
            email: z.string().email(),
            password: z.string(),
          })
          .safeParse(credentials);

        if (!parsedCredentials.success) return null;

        const { email, password } = parsedCredentials.data;

        // D-7 gate #1, before any DB work. Return null (not throw) so the
        // response shape is identical to a wrong password — this endpoint must
        // not become an oracle for "which domains are accepted".
        if (!(await maySignIn(email))) return null;

        const user = await db.user.findFirst({
          where: {
            email: {
              mode: "insensitive",
              equals: email,
            },
          },
        });
        if (!user?.passwordHash) return null;

        // D-7 gate #2, on the STORED address. The lookup above is
        // case-insensitive-equals, so the stored value can differ from the
        // submitted one, and only the stored value is used downstream to
        // derive the canonical role key.
        if (!(await maySignIn(user.email))) return null;

        // Verifies bcrypt or legacy SHA-256 (#3); transparently upgrades the
        // stored hash to bcrypt on a successful legacy login.
        const { valid, upgradedHash } = await verifyPassword(
          password,
          user.passwordHash,
        );
        if (!valid) return null;

        if (upgradedHash) {
          await db.user.update({
            where: { id: user.id },
            data: { passwordHash: upgradedHash },
          });
        }

        return {
          id: user.id,
          email: user.email,
          name: user.displayName,
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
    // Without this, a rejected OAuth sign-in lands on NextAuth's unbranded
    // /api/auth/error. Pointing it at /login means the denial surfaces as
    // /login?error=AccessDenied, which the login page renders.
    error: "/login",
  },
  secret: env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  callbacks: {
    /**
     * D-7. Runs BEFORE PrismaAdapter persists anything on the OAuth path, so a
     * rejected Google account leaves NO User row and NO Account row behind —
     * and therefore never reaches events.createUser (G-B), so no baseline is
     * minted for an ineligible identity. This callback keeps EXACTLY ONE JOB:
     * return false for non-NUS. The baseline grant does NOT go here — it would
     * turn a failed write into a sign-in denial, and the User row does not yet
     * exist at this point.
     *
     * Returns `false`, never a redirect string. On the CREDENTIALS branch a
     * string return yields HTTP 200 with no `status` field, so
     * signIn(..., { redirect: false }) computes ok:true on the client while no
     * session cookie was set — a "successful" login into nothing. `false`
     * gives 403 + ?error=AccessDenied on both providers, and `pages.error`
     * routes it to /login.
     *
     * PROSPECTIVE ONLY: session.maxAge is 30 days and this does not re-run for
     * a live token. Ineligible legacy sessions are marked `eligible: false` in
     * the session callback and denied server-side.
     */
    async signIn({ user, account, profile }) {
      const email = normalizeEmail(user?.email);
      if (!(await maySignIn(email))) {
        // Log the DOMAIN only — never the full address of a denied,
        // unauthenticated party.
        console.warn(
          JSON.stringify({
            evt: "signin_rejected_domain",
            provider: account?.provider,
            domain: email.split("@")[1] ?? "(none)",
          }),
        );
        return false;
      }
      // OAuth only: an unverified profile email is an unauthenticated claim,
      // and under D-1 a successful sign-in confers booking capability.
      if (
        account?.type === "oauth" &&
        (profile as { email_verified?: boolean } | undefined)
          ?.email_verified !== true
      ) {
        return false;
      }
      return true;
    },
    async jwt({ token, user }) {
      // This runs on sign-in
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    /**
     * THE hot path: trpc.ts calls auth() on every tRPC request, and under the
     * JWT strategy there is no server-side session cache, so this body runs on
     * every single authenticated request. Two rules govern every line below.
     *
     * 1. It must never throw. A rejected session callback force-logs-out the
     *    user, which is an unrecoverable state — so no promise originated here
     *    may reject, not just ensureBaseline.
     * 2. Steady state must issue ZERO reads and ZERO writes beyond the two
     *    indexed findUniques that were already required.
     */
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
        // I-1: anchored derivation via the ONE shared helper, replacing an
        // unanchored .replace() with no .trim() that returned garbage-but-truthy
        // keys like "ALICE@GMAIL.COM" for non-NUS addresses.
        //
        // resolvePrincipalID = canonicalUserID(email) ?? pinnedUserIDFor(...).
        //
        // COSTS NOTHING IN STEADY STATE. The `??` short-circuits, so for every
        // @u.nus.edu address — which is all live traffic — the right operand is
        // never evaluated and NO query is issued. Rule 2 above ("ZERO reads
        // beyond the two indexed findUniques") is preserved exactly. Only a
        // non-canonical session pays, and it pays one findUnique on a unique
        // index over a collection holding single-digit rows, behind a 15s cache.
        // Those sessions previously early-returned below with zero queries, so
        // this is +1 for them and +0 for everyone else.
        //
        // IT CANNOT THROW. resolvePrincipalID wraps its read and degrades to the
        // absent identity — rule 1 above, and the degraded behaviour is
        // byte-identical to what this line did before the allowlist existed.
        //
        // THE PIN IS DELIBERATELY NOT STAMPED ON THE TOKEN. `jwt` above writes
        // only id/email/name and MUST STAY THAT WAY. session.maxAge is 30 days
        // and updateAge is 24h, so a pin baked into the token would mean
        // REMOVING AN AuthAllowlist ROW DOES NOT REVOKE THE IDENTITY FOR UP TO
        // A MONTH — and that identity carries `scrc`. This is the same argument
        // this file already makes for `roles` (I-4) and `matricRequired`
        // (I-11); resolving live is what makes revocation take effect in 15
        // seconds instead of 30 days.
        const userID = await resolvePrincipalID(db, token.email);
        session.user.userID = userID;
        // D-C: the identity fact, derived HERE and nowhere else (no new query —
        // it is line 302's value, named). Deliberately NOT flag-aware: unlike
        // `eligible` below it does not move when a kill switch moves.
        session.user.hasIdentity = userID !== null;
        // Default for every path below. Only the deleted-account branch raises
        // it, and it must be a boolean on every branch — MatricGate reads it
        // first, and `undefined` there would be a silent "everything is fine".
        session.user.accountMissing = false;
        // I-11. `eligible` is the D-7 DECISION, so it follows the switch: with
        // the flag "off" nobody is marked ineligible and protectedProcedure's
        // backstop never fires, which is what keeps deploy day inert for
        // existing non-NUS sessions. The `userID === null` early return below is
        // NOT gated — it guards the ""-keyed-role hazard (I-8d), which has
        // nothing to do with D-7 and must hold in every mode.
        session.user.eligible =
          userID !== null || (await getAuthEnforcement(db)) !== "enforce";
        session.user.email = token.email;
        session.user.name = token.name;

        if (userID === null) {
          // Branches on userID, NOT on `eligible`: since I-11 made `eligible`
          // flag-aware, keying this on it would let a ""-canonicalizing
          // principal fall through to the lookups below whenever the switch is
          // off — the exact hazard the paragraph beneath describes.
          //
          // Backstop for a JWT minted before the D-7 deploy, or a
          // blank/malformed stored email. Do NOT throw — see rule 1 above.
          // Mark it and let the server-side checks deny.
          //
          // The early RETURN is load-bearing, not tidiness: without it this
          // callback would run userRole.findUnique({ where: { userID: "" } }),
          // and if a ""-keyed UserRole row ever exists (I-8d calls one a red
          // line) EVERY non-canonicalizable principal would inherit its roles
          // wholesale, including `admin`, with no grant path and therefore no
          // escalation guard firing. getUserRoles already guards this; the
          // session callback must not be weaker than the read boundary it
          // feeds. ensureBaseline is likewise skipped entirely.
          session.user.matric = null;
          session.user.hasMatric = false;
          // Irrelevant on this branch — MatricGate routes ineligible users to
          // the ineligibility page before it ever consults hasMatric — but it
          // must be a boolean, and "false" is the non-blocking value.
          session.user.matricRequired = false;
          // Likewise irrelevant here — the gate routes an empty identity to the
          // ineligibility page before it consults this — but it must be an
          // array, and empty is the non-blocking value. It is also the only
          // correct value: ProfileCompletion is keyed by CANONICAL id (I-1), so
          // there is nothing to look up on this branch, and looking it up with
          // "" would be the ""-keyed-row hazard of I-8d one collection over.
          session.user.profileNeedsFields = [];
          // Non-blocking on this branch: an empty identity is routed to the
          // ineligibility page before the profile gate is ever consulted, and
          // "not incomplete" is the only correct value with no canonical id to
          // key a profile read on.
          session.user.profileIncomplete = false;
          session.user.profileMissingFields = [];
          session.user.roles = [];
          session.user.isAdmin = false;
          return session;
        }

        // Parallel indexed lookups — one round-trip of latency, not two. The
        // matric lookup is the pre-existing one, unchanged in meaning: reading
        // it live (rather than baking it into the stateless JWT) means a user
        // who submits their matric is un-gated on the very next session read,
        // with no re-login and no waiting out `updateAge`. The userRole lookup
        // was ALWAYS going to be required to read admin/jcrc, which are not
        // derivable from anything — so the self-heal below adds no query.
        //
        // This callback runs in the Node runtime (getServerSession / the
        // /api/auth/session route), so Prisma/Atlas is reachable here; this is
        // also why the matric gate is NOT a Next edge middleware.
        // The third read costs nothing in steady state: getMatricEnforcement
        // shares access.ts's 15s per-lambda flag cache, so it issues a query at
        // most once per instance per 15s, and it never throws (it degrades to
        // "off" = no gate).
        //
        // The fourth read joins the SAME round trip, so it costs latency only
        // if it is the slowest of the four, and it is a single indexed
        // findUnique on `userID @unique`. Its `.catch` is not decoration: rule 1
        // above says this callback must never throw, and an un-caught rejection
        // inside Promise.all rejects the whole thing and force-logs-out the
        // user. The two lookups beside it predate that rule; a NEW promise here
        // must not widen the blast radius, so a ProfileCompletion fault degrades
        // to "not flagged" (no prompt) rather than to "logged out".
        const [record, roleRow, matricRequired, completionRow, userRead] =
          await Promise.all([
            db.userMatric.findUnique({ where: { userID } }),
            db.userRole.findUnique({ where: { userID } }),
            isMatricRequired(db),
            db.profileCompletion
              .findUnique({ where: { userID } })
              .catch(() => null),
            // The live profile fields the strict gate checks. Read by primary
            // key (session.user.id is the User _id) with an EXPLICIT select — a
            // bare read throws on a passwordHash-less Google row (I-2), and the
            // `.catch` upholds rule 1 (this callback must never throw): a fault
            // degrades to "no profile data" -> not gated, never logged out.
            //
            // WRAPPED IN A TAG rather than collapsed to `null`. "The read
            // faulted" and "the row is not there" are DIFFERENT FACTS and the
            // branch below acts on only one of them; `.catch(() => null)` erases
            // the distinction, and acting on the merged value would log users
            // out on a transient Atlas hiccup. `ok` is the discriminator.
            db.user
              .findUnique({
                where: { id: session.user.id },
                select: {
                  displayName: true,
                  telegramHandle: true,
                  block: true,
                },
              })
              .then((row) => ({ ok: true as const, row }))
              .catch(() => ({ ok: false as const, row: null })),
          ]);

        const userDoc = userRead.row;

        /* ---- THE User ROW THIS TOKEN NAMES IS GONE -------------------------
         * Sessions are JWTs with a 30-day maxAge and there is NO server-side
         * session store to delete, so `userAdmin.delete` cannot revoke a token
         * that is already in a browser. Without this branch the delete is not a
         * delete: the very next request from that browser reaches the I-8b
         * self-heal below, `stored` is [] (the cascade removed the UserRole
         * document), and `ensureBaseline` UPSERTS a fresh
         * `UserRole { roles: ["resident"] }` under the departed canonical id —
         * re-creating exactly the orphaned role row that 05-verification.md
         * §613 names as escalation residue and that the cascade deletes in its
         * step 2. From there `user.setMatric` (a plain protectedProcedure)
         * re-admits them through matricProcedure and they can write Bookings and
         * Posts keyed to a userID with no User row, for up to a month.
         *
         * ONLY on a PROVABLY absent row (`ok` and no row). A faulted read keeps
         * the old degrade-safely behaviour — over-prompt, never log out.
         *
         * "THE ROW IS GONE" IS NOT "THE ACCOUNT WAS DELETED", and conflating the
         * two was a lockout. `session.user.id` is the `_id` frozen into the JWT
         * at sign-in, and FIVE remediation scripts delete `User` rows as their
         * NORMAL operation — merge-by-canonical.mjs, fix-claresta-duplicate.mjs,
         * fix-lgd-duplicate.mjs, merge-mingyuan-duplicate.mjs, dedupe-users.mjs
         * all end in `db.user.delete({ where: { id } })` for the LOSING row of a
         * duplicate pair. A resident who was signed in on that row keeps a
         * 30-day token pointing at a dead `_id` while their canonical identity,
         * their surviving `User` row and every canonical-keyed record of theirs
         * are intact. Marking them ineligible would make every
         * protectedProcedure throw NUS_ACCOUNT_REQUIRED — bookings, profile,
         * CCA, everything — for having been merged.
         *
         * So EXISTENCE IS DECIDED ON THE IDENTITY, NOT ON THE `_id`: if any
         * other live row canonicalises to the same NUSNET id, this was a merge
         * and `eligible` does not move. Only when nothing of theirs survives is
         * the session's authority revoked. The probe reuses
         * `findCanonicalIdCollisions` — the same over-broad-then-filtered
         * derivation the delete refusal uses — rather than an equality on the
         * email, which would MISS the whitespace variants that are exactly the
         * rows the merge scripts delete. It costs a query only on this branch,
         * which is unreachable in steady state, so rule 2 above still holds. It
         * cannot throw (rule 1).
         *
         * IT FAILS CLOSED — `.catch(() => false)`, i.e. toward REVOKING, and
         * that is the opposite of this file's usual degrade direction because
         * here the two outcomes do NOT have different remedies. The usual
         * argument ("over-prompt, never lock out") assumes a wrongly-gated user
         * loses something; on THIS branch they do not. `accountMissing` is set
         * to true on BOTH sides of the probe, and MatricGate checks it FIRST and
         * routes both cases to /onboarding/ineligible, whose only action is sign
         * out — which is also the remedy for a merged user (signing back in
         * mints a JWT against the surviving row). So a merged user misclassified
         * as "not merged" loses nothing they were not already being redirected
         * away from, while a DELETED user misclassified as "merged" keeps
         * `eligible: true` from line 440 and with it full protectedProcedure
         * authority for up to 30 days — `user.setMatric` is a plain
         * protectedProcedure and would write a UserMatric row under a canonical
         * id with no owning User row, and `evaluateBooking`'s repair-on-deny
         * calls `ensureBaseline`, re-creating the very orphaned UserRole this
         * branch's early return exists to prevent.
         *
         * The asymmetry is why the fault matters at all: this is the single
         * most timeout-prone query in this callback (an unindexed
         * `contains` + `mode: "insensitive"` regex, i.e. a collection scan over
         * ~1382 rows), and it sits in the same Promise.all as an indexed
         * findUnique that can succeed while it faults. "One collection scan
         * timed out" must not be a way to keep a deleted account's authority.
         *
         * BOTH CASES STILL RETURN EARLY, and that is the security half. There is
         * deliberately no self-heal and no pending-grant redemption on this
         * path: `ensureBaseline` would UPSERT a fresh
         * `UserRole { roles: ["resident"] }` under this canonical id — the
         * orphaned role row 05-verification.md §613 names as escalation residue
         * and that the cascade deletes in its step 2 — and it would do so for a
         * token naming a row nobody can point at. Skipping it closes that in
         * both cases, whether or not `eligible` moved.
         *
         * `accountMissing` is what routes the browser (MatricGate). Without it
         * this branch left `hasIdentity` true and every other flag non-blocking,
         * so nothing redirected: the app shell rendered with every tRPC call
         * failing FORBIDDEN, no explanation and no sign-out prompt, for up to
         * the 30-day JWT lifetime.
         */
        if (userRead.ok && userRead.row === null) {
          const mergedAway = await findCanonicalIdCollisions(
            db,
            userID,
            session.user.id,
          )
            .then((rows) => rows.length > 0)
            // UNPROVEN COLLISION => NOT MERGED => authority revoked. See the
            // "fails closed" paragraph above before changing this to `true`.
            .catch(() => false);

          session.user.accountMissing = true;
          // Authority is revoked ONLY when nothing of theirs survives.
          if (!mergedAway) session.user.eligible = false;
          session.user.matric = null;
          session.user.hasMatric = false;
          session.user.matricRequired = false;
          session.user.profileNeedsFields = [];
          session.user.profileIncomplete = false;
          session.user.profileMissingFields = [];
          session.user.roles = [];
          session.user.isAdmin = false;
          return session;
        }

        session.user.matric = record?.matric ?? null;
        session.user.hasMatric = Boolean(record?.matric);
        session.user.matricRequired = matricRequired;
        // No row (every unmerged user) => []. A row whose `resolvedAt` is set is
        // history, not a live prompt, and reads as [] too, so a user who has
        // already filled the form is never re-prompted even though the row is
        // kept for the audit trail.
        // READ HERE, PUBLISHED BELOW. The value cannot be assigned yet: it is
        // now filtered by the user's ROLES (see where it lands, just after
        // `session.user.roles`), and the role set does not exist until the
        // self-heal has run. Splitting the read from the publish keeps the
        // `resolvedAt` semantics next to the query they describe.
        const rawNeedsFields =
          completionRow && completionRow.resolvedAt == null
            ? (completionRow.needsFields ?? [])
            : [];

        // Legacy-tolerant read for the D-6 dual-write window. Removing this
        // fallback belongs to doc 06 — dropping it early silently demotes any
        // admin/jcrc row the backfill missed, and unlike `resident` those roles
        // have no self-heal path: nothing puts them back.
        let stored: string[] = roleRow?.roles?.length
          ? roleRow.roles
          : roleRow?.role
            ? [roleRow.role]
            : [];

        // ---- I-8b SELF-HEAL. Cold path only. ----------------------------
        // In steady state (row exists AND contains "resident") this block is a
        // single Array.includes() on a <=4-element array and issues NOTHING.
        //
        // It is AWAITED, unlike a fire-and-forget materialization, so the SAME
        // request sees the repaired set. That is sound because this callback
        // runs before every authoritative check: repairing here repairs BEFORE
        // USE. ensureBaseline never throws, so awaiting it cannot reject the
        // session, and its circuit breaker bounds a UserRole-scoped write fault
        // to one attempt per lambda per window.
        if (!stored.includes(BASELINE_ROLE)) {
          // Pass the EMAIL, not the id: ensureBaseline canonicalizes internally
          // so the write cannot be reached without an @u.nus.edu address having
          // been presented (I-8d — provenance, not shape).
          //
          // FOR AN `EXT:` PRINCIPAL THIS BLOCK RUNS ON EVERY REQUEST, FOREVER,
          // AND THAT IS BY DESIGN — not a bug for the next reader to "fix".
          // 08 §3.4: an allowlist-pinned identity receives NO `resident`
          // baseline, so `stored` never contains it and this condition is
          // always true for them. The call costs one function invocation and
          // NOTHING ELSE: ensureBaseline canonicalizes the email itself, gets
          // null for an @nus.edu.sg address, and returns false at its `!userID`
          // clause BEFORE issuing any query or any write. That the baseline is
          // withheld mechanically — by the email failing to canonicalize —
          // rather than by an `if (isExt)` somewhere is exactly what makes it
          // trustworthy; see isCanonicalResidentID's note in ~/lib/identity.
          const healed = await ensureBaseline(db, token.email);
          if (healed) stored = [...stored, BASELINE_ROLE];
          // If it did NOT heal we do NOT synthesise the role. The stored value
          // is the truth (I-8); access.ts retries the repair once more before
          // denying a booking (repair-on-deny).
        }
        // ------------------------------------------------------------------

        // I-4: resolved LIVE, per request. Nothing here is written into the
        // token — a revoked admin loses admin on the very next page load
        // rather than at the end of the 30-day JWT lifetime.
        const roles = normalizeStoredRoles(stored);
        session.user.roles = roles;
        session.user.isAdmin = roles.includes(ADMIN_ROLE);

        /* ---- WALL 2: the POST-MERGE completion prompt ----------------------
         * ROLE-AWARE, AND IT HAS TO BE, because MatricGate checks THIS BEFORE
         * the strict profile gate below (`needsProfileCompletion` gates
         * `needsProfileDetails`) and routes to /onboarding/complete-profile.
         *
         * Without the filter, an exempt account carrying a ProfileCompletion
         * row that names `matric` / `block` / `telegramHandle` would be held at
         * that page permanently: the fields it demands are exactly the ones the
         * exemption says they will never have, so there is no input that clears
         * the prompt. `profileIncomplete` being false would not help — the gate
         * never reaches it. That is the resident-stranding trap
         * unstick-profile-completion.mjs was written to release 18 people from,
         * re-created for a population that cannot escape it at all.
         *
         * LATENT TODAY, FIXED ANYWAY. Only the merge scripts write
         * ProfileCompletion rows, and an EXT identity cannot have been merged
         * (nothing else canonicalises to a pin). But "unreachable" here rests on
         * a property of a different subsystem, and the cost of not depending on
         * that is four lines.
         *
         * THE FILTER IS CONSERVATIVE IN THE SAME DIRECTION userAdmin's WALL 2
         * is: a name this deploy's vocabulary does not recognise is KEPT, never
         * dropped, because a deploy cannot judge a field it does not understand.
         * Only a field that IS in the strict vocabulary AND is not required of
         * THIS user is removed. For every non-exempt account the required set
         * IS the strict vocabulary, so this filter is the identity function and
         * all 1382 residents behave byte-identically.
         */
        const requiredForUser = new Set<string>(requiredProfileFieldsFor(roles));
        const strictVocabulary = new Set<string>(REQUIRED_PROFILE_FIELDS);
        session.user.profileNeedsFields = rawNeedsFields.filter(
          (f) => !strictVocabulary.has(f) || requiredForUser.has(f),
        );

        // STRICT PROFILE GATE. Computed live from the profile fields + matric
        // above, using the SAME rules the client dialog mirrors, so the two
        // never disagree about who is gated. `userDoc` may be null if the read
        // faulted — treat that as "no data to prove completeness", i.e. gated,
        // EXCEPT it degrades safely: computeProfileGaps on all-null returns the
        // full set, which routes to /profile where the user can fix it (never a
        // hard lockout). A transient fault therefore over-prompts, not
        // over-admits.
        //
        // MOVED BELOW THE ROLE RESOLUTION. computeProfileGaps is now ROLE-AWARE
        // (src/lib/profileCompleteness.ts: MINIMAL_PROFILE_ROLES — hall office
        // staff hold no matric, live in no block, and have no reason to publish
        // a Telegram handle to residents), so the gate must read the SAME live
        // role set the rest of this callback does. Nothing between the old
        // position and this one reads profileGaps, so the move is inert for
        // every existing user.
        //
        // DO NOT compute a second, earlier role set to keep this where it was.
        // That is a second derivation of the same fact in the same function and
        // it WILL drift — and when it drifts, the session gate and the tRPC
        // walls in userAdmin.ts stop agreeing about who is held, which is the
        // exact state unstick-profile-completion.mjs exists to clean up.
        const profileGaps = computeProfileGaps(
          {
            displayName: userDoc?.displayName ?? null,
            telegramHandle: userDoc?.telegramHandle ?? null,
            block: userDoc?.block ?? null,
            matric: record?.matric ?? null,
          },
          roles,
        );
        session.user.profileMissingFields = profileGaps;
        session.user.profileIncomplete = profileGaps.length > 0;

        // D-8 pending-grant redemption. `pendingCheckedAt` is stamped
        // unconditionally by redeemPendingGrants as its final step (INCLUDING
        // the no-grants and expired cases), which is what makes this check cost
        // ZERO queries forever after one run per user.
        //
        // FIRE-AND-FORGET, with its own .catch() even though redeemPendingGrants
        // already contains its own failures: an unhandled rejection on this path
        // is a lambda-level fault on the hottest route in the app, i.e. a mass
        // availability event rather than a single-user one. Deliberately NOT
        // awaited — unlike the I-8b self-heal, a newly claimed jcrc/admin role
        // does not need to be visible in THIS request (the claimant has just
        // signed up and is being redirected anyway), and awaiting it would put a
        // multi-write path in front of every first page load.
        //
        // FOR AN `EXT:` PRINCIPAL BEFORE ITS FIRST ROLE GRANT there is no
        // UserRole row at all, so `roleRow` is null, `pendingCheckedAt` is
        // undefined and this fires on every request. It costs one findUnique on
        // PendingRoleGrant plus one FAILING update, both swallowed — and,
        // importantly, IT CANNOT CREATE A STRAY UserRole ROW: stampPendingChecked
        // uses `update`, not `upsert`, inside its own try/catch, so a missing
        // document throws P2025 into that catch rather than inserting an empty,
        // role-less row under the pin. Two wasted queries per request for one
        // account until the `scrc` grant lands, after which the row exists and
        // this stamps once and never runs again.
        if (roleRow?.pendingCheckedAt == null) {
          void redeemPendingGrants(db, userID).catch(() => {
            /* contained */
          });
        }
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      // The old unconditional `${baseUrl}/` form discarded every URL including
      // NextAuth's own error redirect, so a D-7-rejected user was silently
      // bounced to "/" with no indication of why. Same-origin pass-through;
      // anything external still collapses to home.
      return url.startsWith(baseUrl) ? url : `${baseUrl}/`;
    },
  },
  events: {
    /**
     * G-B / I-8a — the resident grant for Google first sign-in. PrismaAdapter
     * creates the User row itself, and events.createUser is the only hook that
     * fires exactly once, immediately after that insert, with the created user
     * in hand. Not callbacks.signIn (runs BEFORE the row exists, and its return
     * value is the D-7 gate — one job only); not events.linkAccount (fires when
     * an Account is attached to an EXISTING user, who already holds a baseline).
     *
     * MUST be individually try/caught. next-auth v4 awaits events.createUser
     * inside callback-handler, and a rejection propagates to routes/callback,
     * which redirects to /api/auth/error?error=Callback — i.e. the user's FIRST
     * Google sign-in fails. It self-recovers (on retry the User row exists,
     * createUser does not re-fire, and I-8b heals them), but do not write "a
     * rejection does not deny the sign-in" here: it does.
     */
    async createUser({ user }) {
      try {
        // PrismaAdapter writes ONLY email/name/image/emailVerified — User.userID
        // is NOT set on adapter-created rows. Reading user.userID here yields
        // null and silently keys the grant on "": the classic mis-keyed grant.
        // The key comes from the EMAIL (I-1), and ensureBaseline canonicalizes
        // it itself (I-8d).
        await ensureBaseline(db, user.email ?? "");
      } catch (e) {
        console.error(
          JSON.stringify({ evt: "baseline_grant_failed", err: String(e) }),
        );
      }
    },
  },
} satisfies NextAuthOptions;

/**
 * Wrapper for `getServerSession` so that you don't need to import the `authOptions` in every file.
 *
 * @see https://next-auth.js.org/configuration/nextjs
 */
export function auth(
  ...args:
    | [GetServerSidePropsContext["req"], GetServerSidePropsContext["res"]]
    | [NextApiRequest, NextApiResponse]
    | []
) {
  return getServerSession(...args, authOptions);
}
