import { defineConfig, type Plugin } from "vite";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The GitHub Pages site: the three.js showcase (demo/index.html) at the root
// and the minimal example at examples/three-basic/. Both import the adapter
// from source (src/three). Build with `npm run build:pages`; the output goes
// to pages-dist/. PAGES_BASE overrides the base path (default: the repo's
// Pages path, /poqpoq-sundial/).
const outDir = "pages-dist";

/** Moves the showcase from pages-dist/demo/ to the site root, and publishes its preview image unhashed. */
function showcaseAtRoot(): Plugin {
  return {
    name: "sundial-showcase-at-root",
    apply: "build",
    closeBundle() {
      const out = resolve(__dirname, outDir);
      const from = resolve(out, "demo/index.html");
      if (!existsSync(from)) return;
      renameSync(from, resolve(out, "index.html"));
      rmSync(resolve(out, "demo"), { recursive: true, force: true });
      // og:image needs a stable URL.
      copyFileSync(resolve(__dirname, "demo/sundial-three.jpg"), resolve(out, "sundial-three.jpg"));
      // No Jekyll processing on GitHub Pages.
      writeFileSync(resolve(out, ".nojekyll"), "");
      // Sanity check: asset URLs must be absolute (under the base) to survive the move.
      const html = readFileSync(resolve(out, "index.html"), "utf8");
      if (/(src|href)="\.\.?\//.test(html.replace(/href="\.\/examples\/three-basic\/"/, ""))) {
        throw new Error("showcase index.html has relative asset URLs; it cannot be moved to the root");
      }
    },
  };
}

export default defineConfig({
  base: process.env.PAGES_BASE ?? "/poqpoq-sundial/",
  publicDir: false,
  build: {
    target: "es2022",
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200, // three.js WebGPU is most of the bundle
    rollupOptions: {
      input: {
        showcase: resolve(__dirname, "demo/index.html"),
        "three-basic": resolve(__dirname, "examples/three-basic/index.html"),
      },
    },
  },
  preview: { port: 5291, strictPort: true },
  plugins: [showcaseAtRoot()],
});
