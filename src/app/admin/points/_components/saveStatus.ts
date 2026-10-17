export type SaveStatus = { text: string; tone: "ok" | "warn" };

/**
 * The line shown after a successful save. If re-reading the settings failed, the
 * page may be showing stale data next to "Saved", so say that instead.
 */
export function saveStatus(message: string, reloaded: boolean): SaveStatus {
  return reloaded
    ? { text: message, tone: "ok" }
    : {
        text: "Saved, but couldn't reload the current settings. Reload the page.",
        tone: "warn",
      };
}

/**
 * Whether to show the line. A warning always shows (it says the page may be stale);
 * a plain "Saved" is hidden once the form has been edited again.
 */
export const statusVisible = (s: SaveStatus, dirty: boolean): boolean =>
  s.tone === "warn" || !dirty;

export const statusClass = (s: SaveStatus): string =>
  s.tone === "ok" ? "text-emerald-700" : "text-amber-700";
