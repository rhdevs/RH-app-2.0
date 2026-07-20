import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import Header from "~/app/_components/header";

/** Session-dependent; never cached (a shared CCA list would leak one user's
 *  membership badges to the next viewer). */
export const dynamic = "force-dynamic";

/**
 * The resident-facing CCA surface: browse every CCA and apply to join.
 *
 * Unlike /cca (the head dashboard) this has NO headship gate — every signed-in,
 * eligible resident may browse. Authorization for the actions lives in the
 * procedures (assertApplicationsEnabled + ownership), so this layout only
 * establishes "signed in", the same defence-in-depth role /cca/layout plays.
 */
export default async function CcasLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Must match the nav link's `name` in header.tsx. */}
      <Header currentPage="CCAs" />
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
