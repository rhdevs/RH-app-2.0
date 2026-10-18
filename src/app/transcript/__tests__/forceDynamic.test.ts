import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DATABASE-FREE. Every transcript page and layout must stay dynamic: that is
 * what keeps a resident's transcript out of any shared cache. Next answers a
 * `force-dynamic` page with `Cache-Control: private, no-cache, no-store`; a page
 * that became static (say, after someone removed the export) would be built
 * once and could be served to everyone. Nothing else sets that header, so this
 * test is the guard.
 */
const ROOTS = [
  "src/app/transcript",
  "src/app/admin/transcripts",
  "src/app/cca/[ccaID]/transcript",
];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ? [] : routeFiles(path);
    }
    return /^(page|layout)\.tsx$/.test(name) ? [path] : [];
  });
}

const files = ROOTS.flatMap(routeFiles).sort();

describe("every transcript page is force-dynamic", () => {
  it("finds the pages", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.some((f) => f.endsWith(join("transcript", "page.tsx")))).toBe(
      true,
    );
  });

  it.each(files)('%s exports dynamic = "force-dynamic"', (file) => {
    expect(readFileSync(file, "utf8")).toMatch(
      /^export const dynamic = "force-dynamic";$/m,
    );
  });
});
