import { type Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { accessFor } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import JcrcSelf from "../_components/JcrcSelf";

export const metadata: Metadata = {
  title: "Your JCRC page",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * A JCRC member's own page for their transcript. The segment layout admits
 * admin and jcrc; whether the viewer is a JCRC MEMBER is a live role read here
 * (and again by transcriptManage.jcrc.mine), and an admin without the jcrc role
 * is told there is no JCRC page for them, without asking for one. No userID is ever taken from the
 * address: the identity is the session's.
 */
export default async function JcrcSelfPage() {
  const session = await auth();
  if (!session?.user?.userID) redirect("/login");
  const isMember = accessFor(
    "jcrcSelf",
    await getUserRoles(db, session.user.userID),
  );

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/admin/transcripts"
          className="text-sm font-medium text-emerald-800 underline underline-offset-2"
        >
          Back to transcripts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">
          Your JCRC page
        </h1>
      </header>
      <JcrcSelf userID={session.user.userID} isMember={isMember} />
    </div>
  );
}
