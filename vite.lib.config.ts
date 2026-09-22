import { defineConfig } from "vite";

/**
 * Library build for @poqpoq/sundial, matching World's other sibling packages
 * (@poqpoq/dozer, kudzu, paths): ES modules plus tsc declarations. Babylon is
 * a peer. Every @babylonjs/core subpath stays external, because the adapter
 * imports by subpath and World dedupes Babylon to one runtime copy.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: { index: "src/index.ts", babylon: "src/babylon/index.ts" },
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^@babylonjs\/core(\/.*)?$/],
    },
    sourcemap: true,
    target: "es2022",
  },
});
