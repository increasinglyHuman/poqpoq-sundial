import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5188, strictPort: true },
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["@babylonjs/core"] },
});
