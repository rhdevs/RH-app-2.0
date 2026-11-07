import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import Header from "~/app/_components/header";

/** Session-dependent; never cached. */
export const dynamic = "force-dynamic";

/**
 * A signed-in surface, and nothing more. What a person sees on it is decided
 * by the procedures behind it, from the stored rows, every time: this layout
 * reads no roles, so a stale session cannot widen it.
 */
export default async function CalendarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <Header currentPage="Calendar" />
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
