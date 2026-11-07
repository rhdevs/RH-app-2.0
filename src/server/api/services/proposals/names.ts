import type { PrismaClient } from "@prisma/client";

/**
 * Display names for canonical user ids (the key CcaHead, history rows and
 * holder rows carry). A person is found by the `userID` on their record or,
 * for an older record without one, by the NUS address the id is derived from.
 *
 * ONLY the display name leaves, never an email, a matric or a password hash
 * (`select` names three columns). A person with no name on file is absent from
 * the map, and the screens say so in words rather than showing an id.
 */

const NAME_MAX = 100;
/** Heads, approvers and a director's CCAs are tens of people, not thousands. */
const LOOKUP_MAX = 500;

const addressOf = (id: string) => `${id.toLowerCase()}@u.nus.edu`;

export async function displayNames(
  db: Pick<PrismaClient, "user">,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)].slice(0, LOOKUP_MAX);
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;

  const users = await db.user.findMany({
    where: {
      OR: [
        { userID: { in: wanted } },
        { email: { in: wanted.map(addressOf), mode: "insensitive" } },
      ],
    },
    select: { userID: true, email: true, displayName: true },
  });
  for (const id of wanted) {
    const user = users.find(
      (u) => u.userID === id || u.email.trim().toLowerCase() === addressOf(id),
    );
    const name = user?.displayName?.trim();
    if (name) out.set(id, name.slice(0, NAME_MAX));
  }
  return out;
}
