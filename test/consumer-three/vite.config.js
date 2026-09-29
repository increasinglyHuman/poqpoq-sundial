import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Consumes the three.js adapter the way a real app would once the package
// exports "./three": for now the package build (vite.lib.config.ts,
// package.json exports) has no "./three" entry, so this page imports the
// adapter and core straight from source. Switch these two aliases to
// dependencies on the built package ("@poqpoq/sundial/three", "@poqpoq/sundial")
// once that export lands; nothing else in this test should need to change.
// "three" itself resolves normally from src/three/index.ts's own location,
// which walks up to the repo root node_modules (three 0.186.1) — no alias
// or dedupe needed for it since there is only one node_modules in play.
export default defineConfig({
  // CONSUMER_PORT lets several worktrees run a consumer test at once.
  server: { port: Number(process.env.CONSUMER_PORT ?? 5281), strictPort: true },
  resolve: {
    alias: {
      "@poqpoq/sundial/three": fileURLToPath(new URL("../../src/three/index.ts", import.meta.url)),
      "@poqpoq/sundial": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
});
