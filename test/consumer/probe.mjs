// Loads the consumer page on WebGL2 and WebGPU in real Chrome and asserts:
// the import never throws, isSupported() matches the backend, and on WebGPU
// pages are requested and resident with no allocation failures or errors.
// Starts and stops its own Vite dev server on port 5189.
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import { createServer } from "vite";
import { readdirSync, existsSync } from "node:fs"; import { join } from "node:path";
const root = join(process.env.LOCALAPPDATA, "ms-playwright");
const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = [join(root, dir, "chrome-win64", "chrome.exe"), join(root, dir, "chrome-win", "chrome.exe")].find(existsSync);
const server = await createServer({ root: import.meta.dirname, configFile: join(import.meta.dirname, "vite.config.js") });
await server.listen();
const b = await chromium.launch({ executablePath: exe, headless: false, args: ["--force_high_performance_gpu", "--enable-unsafe-webgpu"] });
let failed = false;
for (const engine of ["webgl2", "webgpu"]) {
  const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errs.push(m.text().slice(0, 160)); });
  await p.goto(`http://localhost:5189/?engine=${engine}`);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await p.waitForFunction(() => window.__result.done || !window.__result.supported || window.__result.error, null, { timeout: 30000 });
  await p.waitForTimeout(500);
  const res = await p.evaluate(() => { const r = window.__result; return { ...r, core: r.core ? (({ requestedPages, residentPages, allocationFailures, alphaPairs, opaquePairs }) => ({ requestedPages, residentPages, allocationFailures, alphaPairs, opaquePairs }))(r.core()) : undefined }; });
    const ok = res.imported && !res.error && errs.length === 0 &&
    (engine === "webgl2" ? res.supported === false : res.supported === true && res.core.requestedPages > 0 && res.core.allocationFailures === 0 &&
      // ground 32 + box 12 + the prim's 6 visible triangles (its hidden half must not cast) + leaf 2
      res.firstBuild.triangles === 52 && res.firstBuild.geometries === 4 &&
      res.rebuild?.cachedGeometries === 4 && res.rebuild.triangles === 52 && res.gpuErrors.length === 0 &&
      // readCoverage keeps texture-memory order: only the top-left quadrant is opaque
      res.orientation.topLeft === 255 && res.orientation.topRight === 0 && res.orientation.bottomLeft === 0 &&
      // the leaf's mask was read and it now casts through the alpha pipeline
      res.firstBuild.alphaClusters === 0 && res.rebuild.alphaClusters === 1 &&
      // darkness 1 hides every shadow: the whole frame gets measurably brighter
      res.lumaDark1 > res.lumaDark0 + 1 &&
      // a material made after start() picked up the receiver on its own
      res.late.plugin && res.late.enabled);
  failed ||= !ok;
  console.log(ok ? "PASS" : "FAIL", engine, JSON.stringify(res), errs.length ? "ERRORS: " + errs.join(" | ") : "");
  await p.close();
}
await b.close();
await server.close();
process.exit(failed ? 1 : 0);
