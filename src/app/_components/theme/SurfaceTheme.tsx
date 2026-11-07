"use client";

import { useCallback, useEffect, useState } from "react";

import {
  THEME_CHOICES,
  isDarkFor,
  readThemeChoice,
  writeThemeChoice,
  type ThemeChoice,
} from "~/lib/theme/surfaceTheme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

const LABELS: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const getLocalStorage = () =>
  typeof window === "undefined" ? undefined : window.localStorage;

/**
 * The look of the surface, decided. `dark` goes on this div only. The class
 * must sit on an ANCESTOR of the styled elements (Tailwind's `dark:` matches a
 * descendant of `.dark`), so the content div is nested inside it.
 */
export function ThemedSurface({
  isDark,
  className = "",
  children,
}: {
  isDark: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={isDark ? "dark" : undefined} data-surface-theme>
      <div
        className={`${className} dark:bg-background dark:bg-none dark:text-foreground`.trim()}
      >
        {children}
      </div>
    </div>
  );
}

/** Light, Dark or System. A labelled group of buttons, usable by keyboard. */
export function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (next: ThemeChoice) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="mb-4 flex justify-end"
    >
      <div className="inline-flex overflow-hidden rounded-md border border-gray-300 bg-white text-xs dark:border-border dark:bg-card">
        {THEME_CHOICES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={choice === c}
            onClick={() => onChange(c)}
            className={`px-3 py-1.5 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600 ${
              choice === c
                ? "bg-emerald-700 text-white"
                : "text-gray-700 hover:bg-gray-50 dark:text-muted-foreground dark:hover:bg-muted"
            }`}
          >
            {LABELS[c]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Wraps one new screen. It never touches `document.documentElement`, so every
 * page that existed before stays exactly as it was. Before hydration the
 * surface renders light (a brief flash is the accepted trade-off).
 */
export default function SurfaceTheme({
  className,
  mainClassName,
  children,
}: {
  className?: string;
  /** When given, the content (and the toggle) sit in a `<main>` with these classes. */
  mainClassName?: string;
  children: React.ReactNode;
}) {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    setChoice(readThemeChoice(getLocalStorage));
    let query: MediaQueryList | undefined;
    try {
      query = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    setSystemDark(query.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query?.removeEventListener("change", onChange);
  }, []);

  const change = useCallback((next: ThemeChoice) => {
    setChoice(next);
    writeThemeChoice(getLocalStorage, next);
  }, []);

  return (
    <ThemedSurface isDark={isDarkFor(choice, systemDark)} className={className}>
      {mainClassName === undefined ? (
        <>
          <ThemeToggle choice={choice} onChange={change} />
          {children}
        </>
      ) : (
        <main className={mainClassName}>
          <ThemeToggle choice={choice} onChange={change} />
          {children}
        </main>
      )}
    </ThemedSurface>
  );
}
