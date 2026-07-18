"use client";

import { createContext, useContext } from "react";
import type { Capabilities } from "~/server/api/services/roles";

/**
 * THE only place in src/app/admin/ that may inspect authority (03 §1.2).
 *
 * The rule every other file under src/app/admin/ obeys: no component branches
 * on a role string. Every conditional render reads a named boolean off this
 * object. The gate is
 *   grep -rn 'roles.includes\|isAdmin' src/app/admin/
 * returning zero hits outside this file.
 *
 * That is a maintainability rule, not a security one — v1 forked on `isAdmin`
 * in seven independent places and none of them was a hole, but seven copies of
 * a policy is how the eighth gets it wrong. Security is the layout guards plus
 * the procedure guards (I-7); everything here is cosmetic.
 *
 * The type comes from `~/server/api/services/roles`, which is deliberately
 * runtime-pure (its PrismaClient import is type-only), so importing it from a
 * client component pulls in no server code. Do not "fix" this by copying the
 * Capabilities shape locally — two copies of a capability set is how the
 * dashboard starts rendering a control the server will refuse.
 */
const Ctx = createContext<Capabilities | null>(null);

export function AdminCapabilityProvider({
  value,
  children,
}: {
  value: Capabilities;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCapabilities(): Capabilities {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCapabilities outside AdminCapabilityProvider");
  return v;
}
