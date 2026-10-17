/**
 * Dashboard sections that are for this CCA's own heads only. Today that is just
 * Points: JCRC and admin reach the other sections through the dashboard's
 * manager access, but the points page admits only the CCA's heads.
 */
const HEADS_ONLY_SLUGS: readonly string[] = ["points"];

/**
 * Does the viewer head THIS CCA? `listMine` is "the CCAs I head", so a match means
 * a real CcaHead row. False while the list is loading (undefined) and for JCRC or
 * admin who do not head this CCA, so heads-only tabs never flash up for them.
 */
export function headsThisCca(
  mine: readonly { ccaID: number }[] | undefined,
  ccaID: number,
): boolean {
  return mine?.some((c) => c.ccaID === ccaID) ?? false;
}

/** `headsThisCca` is false while loading, so heads-only tabs never flash up. */
export function visibleSections<T extends { slug: string }>(
  sections: readonly T[],
  headsThisCca: boolean,
): T[] {
  return sections.filter(
    (s) => headsThisCca || !HEADS_ONLY_SLUGS.includes(s.slug),
  );
}
