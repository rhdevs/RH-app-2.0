/**
 * Dashboard sections that are for this CCA's own heads only. Today that is just
 * Points: JCRC and admin reach the other sections through the dashboard's
 * manager access, but the points page admits only the CCA's heads.
 */
const HEADS_ONLY_SLUGS: readonly string[] = ["points"];

/** `headsThisCca` is false while loading, so heads-only tabs never flash up. */
export function visibleSections<T extends { slug: string }>(
  sections: readonly T[],
  headsThisCca: boolean,
): T[] {
  return sections.filter(
    (s) => headsThisCca || !HEADS_ONLY_SLUGS.includes(s.slug),
  );
}
