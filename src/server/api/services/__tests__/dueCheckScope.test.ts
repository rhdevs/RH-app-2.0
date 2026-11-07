import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source scans that keep the due check inside PR 12's scope: no schedule, no
 * outside delivery, no session in the shared function's signature, and a bell
 * that fires it through the daily gate.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const dueDir = "src/server/api/services/dueCheck";
const dueFiles = readdirSync(join(root, dueDir)).map((f) => `${dueDir}/${f}`);
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the due check's scope", () => {
  it("adds no cron route, vercel.json or job record", () => {
    expect(existsSync(join(root, "vercel.json"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/cron"))).toBe(false);
    expect(read("prisma/schema.prisma")).not.toMatch(/model\s+JobRun\b/);
  });

  it("has no session, delivery or outside call in the shared function", () => {
    for (const file of dueFiles) {
      const code = stripComments(read(file));
      expect(code, file).not.toMatch(
        /next-auth|~\/server\/auth|\bsession\b|telegram|resend|~\/lib\/email|fetch\(/i,
      );
    }
  });

  it("takes a user id and a client, not a session", () => {
    const code = stripComments(read(`${dueDir}/runner.ts`));
    expect(code).toMatch(
      /export async function runDueCheck\(\s*db: PrismaClient,\s*userID: string,/,
    );
  });

  it("is reached from the bell through the daily gate, and refreshes the unread count", () => {
    const bell = read("src/app/_components/NotificationBell.tsx");
    expect(bell).toContain("watchDueCheck");
    expect(bell).toContain("runDueCheck");
    expect(bell).toContain("unreadCount.invalidate");
  });

  it("is reached from the bell and nowhere else on the client", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(rel);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          if (read(rel).includes("notifications.runDueCheck")) hits.push(rel);
        }
      }
    };
    walk("src/app");
    expect(hits).toEqual(["src/app/_components/NotificationBell.tsx"]);
  });
});
