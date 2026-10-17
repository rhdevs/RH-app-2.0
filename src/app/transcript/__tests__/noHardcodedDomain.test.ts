import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The transcript pages must not name a domain: the address printed
 * on a transcript comes from the request (or NEXTAUTH_URL), so a preview deploy
 * and production each print their own. This reads the sources, so it keeps the
 * promise as the code changes.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.includes(".test.") ? [path] : [];
  });
}

const FILES = ["src/app/transcript", "src/lib/transcript"].flatMap(sourceFiles);

describe("no hard-coded domain", () => {
  it("scans the transcript and library sources", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it.each(FILES)("%s names no domain or URL", (file) => {
    const text = readFileSync(file, "utf8");

    expect(text).not.toMatch(/rhapp\.lol/i);
    // The only URLs allowed are XML namespaces and the placeholder in a comment.
    const urls = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)]
      .map((m) => m[0])
      .filter(
        (u) =>
          !u.startsWith("http://www.w3.org/") &&
          !/^https?:\/\/(localhost|hall\.example\.org|example\.org|rhapp\.example\.org)/.test(
            u,
          ),
      );
    expect(urls).toEqual([]);
  });
});
