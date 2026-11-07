import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import Header from "~/app/_components/header";

/** Session-dependent; never cached. */
export const dynamic = "force-dynamic";

/**
 * A signed-in surface, and nothing more. WHO MAY SEE WHAT is decided by the
 * procedures behind it, from the stored rows, every time: a signed-in person
 * who directs no CCA gets a one-line refusal here and no proposal data. This
 * layout does not read roles, so it cannot be widened by a stale session.
 */
export default async function DirectorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <Header currentPage="Director" />
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
