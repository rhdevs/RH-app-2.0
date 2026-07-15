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
      userID: string;
      bio: string;
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
        const user = await db.user.findFirst({
          where: {
            email: {
              mode: "insensitive",
              equals: email,
            },
          },
        });
        if (!user?.passwordHash) return null;

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
          bio: user.bio,
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  secret: env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  callbacks: {
    async jwt({ token, user }) {
      // This runs on sign-in
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
        session.user.userID = (token.email ?? "")
          .toUpperCase()
          .replace("@U.NUS.EDU", "");
        session.user.email = token.email;
        session.user.name = token.name;
      }
      return session;
    },
    async redirect({ baseUrl }) {
      return `${baseUrl}/`;
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
