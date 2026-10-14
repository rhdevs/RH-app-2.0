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
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
