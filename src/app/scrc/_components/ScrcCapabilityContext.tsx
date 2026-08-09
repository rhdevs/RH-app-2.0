"use client";

import { createContext, useContext } from "react";
import type { Capabilities } from "~/server/api/services/roles";

/**
 * THE only place in src/app/scrc/ that may inspect authority — the same rule
 * AdminCapabilityContext states for src/app/admin/, for the same reason.
 *
 * The rule every other file under src/app/scrc/ obeys: no component branches on
 * a role string. Every conditional render reads a named boolean off this object.
 * The gate is
 *   grep -rn 'roles.includes\|isAdmin\|"scrc"' src/app/scrc/
 * returning zero hits outside this file.
 *
 * That is a maintainability rule, not a security one — the layout guard plus the
 * per-procedure guards are the security (I-7); everything here is cosmetic. In
 * particular NOTHING here knows whether the `scrc.enabled` kill switch is on:
 * computeCapabilities is synchronous and DB-free by design, so the switch is
 * only ever learned from a procedure refusing with SCRC_DISABLED. That is why
 * the panels render a switched-off state rather than hiding themselves.
 *
 * The type comes from `~/server/api/services/roles`, which is deliberately
 * runtime-pure (its PrismaClient import is type-only), so importing it from a
 * client component pulls in no server code. Do not "fix" this by copying the
 * Capabilities shape locally — two copies of a capability set is how a surface
 * starts rendering a control the server will refuse.
 */
const Ctx = createContext<Capabilities | null>(null);

export function ScrcCapabilityProvider({
  value,
  children,
}: {
  value: Capabilities;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScrcCapabilities(): Capabilities {
  const v = useContext(Ctx);
  if (!v) throw new Error("useScrcCapabilities outside ScrcCapabilityProvider");
  return v;
}
