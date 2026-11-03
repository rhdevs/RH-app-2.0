/**
 * Choice logic for the surface theme (dark mode on the new screens only).
 * Pure functions, no DOM access beyond what the caller passes in, so every
 * branch is unit-testable. The choice is Light, Dark or System.
 */
export const THEME_STORAGE_KEY = "rhapp.surfaceTheme";

export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const DEFAULT_THEME_CHOICE: ThemeChoice = "system";

/** Anything that is not exactly one of the three choices is System. */
export const parseThemeChoice = (raw: unknown): ThemeChoice =>
  raw === "light" || raw === "dark" || raw === "system"
    ? raw
    : DEFAULT_THEME_CHOICE;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Storage can be missing or throw (private window, blocked site data). */
export const readThemeChoice = (
  getStorage: () => StorageLike | undefined,
): ThemeChoice => {
  try {
    return parseThemeChoice(getStorage()?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_CHOICE;
  }
};

/** Returns whether the choice was kept; a failed write is not an error. */
export const writeThemeChoice = (
  getStorage: () => StorageLike | undefined,
  choice: ThemeChoice,
): boolean => {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
};

/** Dark when chosen, or when the choice is System and the system is dark. */
export const isDarkFor = (choice: ThemeChoice, systemPrefersDark: boolean) =>
  choice === "dark" || (choice === "system" && systemPrefersDark);
