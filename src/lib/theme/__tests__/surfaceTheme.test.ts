import { describe, expect, it, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  isDarkFor,
  parseThemeChoice,
  readThemeChoice,
  writeThemeChoice,
} from "../surfaceTheme";

describe("parseThemeChoice", () => {
  it.each(["light", "dark", "system"] as const)("keeps %s", (v) => {
    expect(parseThemeChoice(v)).toBe(v);
  });

  it.each([null, undefined, "", "Dark", "auto", 1, {}])(
    "falls back to system for %j",
    (v) => {
      expect(parseThemeChoice(v)).toBe("system");
    },
  );
});

describe("readThemeChoice", () => {
  it("reads the stored value under the surface key", () => {
    const getItem = vi.fn().mockReturnValue("dark");
    expect(readThemeChoice(() => ({ getItem, setItem: vi.fn() }))).toBe("dark");
    expect(getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  });

  it("falls back to system when nothing is stored or the value is junk", () => {
    const store = (v: string | null) => () => ({
      getItem: () => v,
      setItem: vi.fn(),
    });
    expect(readThemeChoice(store(null))).toBe("system");
    expect(readThemeChoice(store("purple"))).toBe("system");
  });

  it("falls back to system when storage is missing", () => {
    expect(readThemeChoice(() => undefined)).toBe("system");
  });

  it("falls back to system when reading throws", () => {
    const throwing = () => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: vi.fn(),
    });
    expect(readThemeChoice(throwing)).toBe("system");
    expect(
      readThemeChoice(() => {
        throw new Error("accessor blocked");
      }),
    ).toBe("system");
  });
});

describe("writeThemeChoice", () => {
  it("stores the choice and reports success", () => {
    const setItem = vi.fn();
    expect(
      writeThemeChoice(() => ({ getItem: vi.fn(), setItem }), "dark"),
    ).toBe(true);
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
  });

  it("reports false, without throwing, when storage throws or is missing", () => {
    const throwing = () => ({
      getItem: vi.fn(),
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(writeThemeChoice(throwing, "light")).toBe(false);
    expect(writeThemeChoice(() => undefined, "light")).toBe(false);
  });
});

describe("isDarkFor", () => {
  it("is dark when chosen, whatever the system says", () => {
    expect(isDarkFor("dark", false)).toBe(true);
    expect(isDarkFor("dark", true)).toBe(true);
  });

  it("is light when chosen, whatever the system says", () => {
    expect(isDarkFor("light", true)).toBe(false);
    expect(isDarkFor("light", false)).toBe(false);
  });

  it("follows the system when the choice is system", () => {
    expect(isDarkFor("system", true)).toBe(true);
    expect(isDarkFor("system", false)).toBe(false);
  });
});
