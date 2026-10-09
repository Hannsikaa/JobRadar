import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json so tests import modules
    // exactly the way application code does.
    alias: { "@": srcDir },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Next.js route files are compiled by Next, not by Vitest. Tests exercise
    // the modules a route delegates to, plus the handler itself where useful.
    exclude: ["node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts"],
    },
  },
});