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
import { computeProfileGaps } from "~/lib/profileCompleteness";
import type { CanonicalUserID } from "~/lib/identity";
import {
  canonicalUserID,
  isNusStudentEmail,
  normalizeEmail,
} from "~/lib/identity";
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

/**
 * D-7 + I-12. THE eligibility predicate for sign-in, and the only one. The
 * domain rule itself lives in ~/lib/identity — this wrapper adds nothing but
 * the break-glass allowlist, which is SIGN-IN ONLY: an allowlisted non-NUS
 * address still has canonicalUserID() === null, so it receives no stored
 * baseline (I-8d), holds no roles and cannot book.
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
        const userID = canonicalUserID(token.email);
        session.user.userID = userID;
        // D-C: the identity fact, derived HERE and nowhere else (no new query —
        // it is line 302's value, named). Deliberately NOT flag-aware: unlike
        // `eligible` below it does not move when a kill switch moves.
        session.user.hasIdentity = userID !== null;
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
        const [record, roleRow, matricRequired, completionRow, userDoc] =
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
            db.user
              .findUnique({
                where: { id: session.user.id },
                select: { displayName: true, telegramHandle: true, block: true },
              })
              .catch(() => null),
          ]);

        session.user.matric = record?.matric ?? null;
        session.user.hasMatric = Boolean(record?.matric);
        session.user.matricRequired = matricRequired;
        // No row (every unmerged user) => []. A row whose `resolvedAt` is set is
        // history, not a live prompt, and reads as [] too, so a user who has
        // already filled the form is never re-prompted even though the row is
        // kept for the audit trail.
        session.user.profileNeedsFields =
          completionRow && completionRow.resolvedAt == null
            ? (completionRow.needsFields ?? [])
            : [];

        // STRICT PROFILE GATE. Computed live from the profile fields + matric
        // above, using the SAME rules the client dialog mirrors, so the two
        // never disagree about who is gated. `userDoc` may be null if the read
        // faulted — treat that as "no data to prove completeness", i.e. gated,
        // EXCEPT it degrades safely: computeProfileGaps on all-null returns the
        // full set, which routes to /profile where the user can fix it (never a
        // hard lockout). A transient fault therefore over-prompts, not
        // over-admits.
        const profileGaps = computeProfileGaps(
          {
            displayName: userDoc?.displayName ?? null,
            telegramHandle: userDoc?.telegramHandle ?? null,
            block: userDoc?.block ?? null,
            matric: record?.matric ?? null,
          },
          { userID, email: token.email },
        );
        session.user.profileMissingFields = profileGaps;
        session.user.profileIncomplete = profileGaps.length > 0;

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
