import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Pick a layout from a container's OWN width, not the window's: the CCA pages
 * put a side menu beside the content, so a wide window can still leave a narrow
 * column. No dependency: a ResizeObserver on the element.
 */

/** The width the roster table needs (its `min-w-[56rem]`, at 16px). */
export const ROSTER_TABLE_MIN_WIDTH = 896;

export type RosterLayout = "table" | "cards";

/** Cards when the container is narrower than the table needs, or not measured yet. */
export function rosterLayoutFor(
  width: number | null,
  tableMinWidth: number = ROSTER_TABLE_MIN_WIDTH,
): RosterLayout {
  return width !== null && width >= tableMinWidth ? "table" : "cards";
}

const useIsoLayoutEffect =
  typeof window === "undefined" ? () => undefined : useLayoutEffect;

/** The element's content width in px, kept current; null until measured. */
export function useContainerWidth<T extends HTMLElement>(): [
  (node: T | null) => void,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null);
  const [node, setNode] = useState<T | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => setNode(el), []);

  useIsoLayoutEffect(() => {
    observer.current?.disconnect();
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(node);
    observer.current = ro;
    return () => ro.disconnect();
  }, [node]);

  return [ref, width];
}
