import { defineConfig } from "vite";
// Mirrors World: dedupe Babylon so the file-linked package shares one runtime copy.
export default defineConfig({
  // CONSUMER_PORT lets several worktrees run the consumer test at once.
  server: { port: Number(process.env.CONSUMER_PORT ?? 5189), strictPort: true },
  resolve: { dedupe: ["@babylonjs/core"] },
  optimizeDeps: { include: ["@babylonjs/core"] },
});
