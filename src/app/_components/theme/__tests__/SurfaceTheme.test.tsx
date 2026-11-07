import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SurfaceTheme, { ThemeToggle, ThemedSurface } from "../SurfaceTheme";

const hasDarkClass = (html: string) => html.includes('class="dark"');

describe("ThemedSurface", () => {
  it("adds the dark class when dark", () => {
    const html = renderToStaticMarkup(
      <ThemedSurface isDark>
        <p>x</p>
      </ThemedSurface>,
    );
    expect(hasDarkClass(html)).toBe(true);
  });

  it("does not add the dark class when light", () => {
    const html = renderToStaticMarkup(
      <ThemedSurface isDark={false}>
        <p>x</p>
      </ThemedSurface>,
    );
    expect(hasDarkClass(html)).toBe(false);
    expect(html).not.toContain('class="dark ');
  });

  it("puts the dark class on an ancestor of the styled content", () => {
    const html = renderToStaticMarkup(
      <ThemedSurface isDark className="bg-white">
        <p>x</p>
      </ThemedSurface>,
    );
    expect(html.indexOf('class="dark"')).toBeLessThan(html.indexOf("bg-white"));
  });
});

describe("SurfaceTheme", () => {
  it("renders light before hydration, with a labelled toggle", () => {
    const html = renderToStaticMarkup(
      <SurfaceTheme mainClassName="m">
        <p>body</p>
      </SurfaceTheme>,
    );
    expect(hasDarkClass(html)).toBe(false);
    expect(html).toContain('aria-label="Colour theme"');
    expect(html).toContain("<main");
    for (const label of ["Light", "Dark", "System"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders no main element unless asked", () => {
    const html = renderToStaticMarkup(
      <SurfaceTheme>
        <p>body</p>
      </SurfaceTheme>,
    );
    expect(html).not.toContain("<main");
  });
});

describe("ThemeToggle", () => {
  it("marks only the current choice as pressed", () => {
    const html = renderToStaticMarkup(
      <ThemeToggle choice="dark" onChange={() => undefined} />,
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
  });
});

describe("scope", () => {
  const read = (...p: string[]) =>
    readFileSync(join(process.cwd(), ...p), "utf8");

  it("never touches the document element or mounts a root provider", () => {
    const src = [
      read("src/app/_components/theme/SurfaceTheme.tsx"),
      read("src/lib/theme/surfaceTheme.ts"),
    ]
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/documentElement/);
    expect(src).not.toMatch(/classList/);
    expect(src).not.toMatch(/next-themes/);
  });

  it("leaves the root layout and the home page without the wrapper", () => {
    for (const f of ["src/app/layout.tsx", "src/app/page.tsx"]) {
      const src = read(...f.split("/"));
      expect(src).not.toMatch(/SurfaceTheme|next-themes|ThemeProvider/);
      expect(src).not.toMatch(/className="[^"]*\bdark\b/);
    }
  });
});
