import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

// Mirrors the "~/*" and "@/*" aliases in tsconfig.json.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^~\//, replacement: `${src}/` },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  // Next.js sets tsconfig "jsx": "preserve"; component tests render directly.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // `npm test` must skip every *.int.test.ts. Prisma reads .env into a worker
    // that loads the real client, which would open the database gate for a later
    // int file on that worker. Prisma never overrides a variable that is already
    // defined, so define one the gate refuses (not local, not the dev database).
    // An empty string is not enough: src/env.js rejects it when a skipped int file
    // imports the db module. `npm run test:db` sets the variable, so it passes through.
    env: process.env.DATABASE_URL
      ? {}
      : { DATABASE_URL: "mongodb://gate-closed.invalid/gate_closed" },
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
