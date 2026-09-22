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
for (const engine of ["webgl2", "webgpu", "webgpu&pp=1", "webgpu&nofeat=1", "webgpu&pbr=1", "webgpu&csm=1"]) {
  const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errs.push(m.text().slice(0, 160)); });
  await p.goto(`http://localhost:5189/?engine=${engine}`);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await p.waitForFunction(() => window.__result.done || !window.__result.supported || window.__result.error, null, { timeout: 30000 });
  await p.waitForTimeout(500);
  const res = await p.evaluate(() => { const r = window.__result; return { ...r, core: r.core ? (({ requestedPages, residentPages, allocationFailures, alphaPairs, opaquePairs }) => ({ requestedPages, residentPages, allocationFailures, alphaPairs, opaquePairs }))(r.core()) : undefined }; });
    const ok = res.imported && !res.error && errs.length === 0 &&
    (engine.startsWith("webgl2") ? res.supported === false : res.supported === true && res.core.requestedPages > 0 && res.core.allocationFailures === 0 &&
      // ground 32 + box 12 + the prim's 6 visible triangles (its hidden half must not cast) + leaf 2
      res.firstBuild.triangles === 52 && res.firstBuild.geometries === 4 &&
      res.rebuild?.cachedGeometries === 4 && res.rebuild.triangles === 52 && res.gpuErrors.length === 0 &&
      // readCoverage keeps texture-memory order: only the top-left quadrant is opaque
      res.orientation.topLeft === 255 && res.orientation.topRight === 0 && res.orientation.bottomLeft === 0 &&
      // the leaf's mask was read and it now casts through the alpha pipeline
      res.firstBuild.alphaClusters === 0 && res.rebuild.alphaClusters === 1 &&
      // darkness 1 hides every shadow, so the frame gets brighter. The render is deterministic: with
      // no shadow (the PBR case before the plugin-priority fix) the two frames are identical.
      res.lumaDark1 > res.lumaDark0 + 0.1 &&
      // a material made after start() picked up the receiver on its own
      res.late.plugin && res.late.enabled &&
      // a member hidden in the live buffer casts from instanceMatrices: its shadow darkens the frame
      res.instanceCanon < res.instanceLive - 0.1 &&
      // rebuilds re-render only what changed, and the picture stays right
      res.rebuildSame.reusedGeometry === true && res.rebuildSame.invalidated === 0 && res.rebuildSame.luma === res.lumaBase &&
      res.rebuildAdd.invalidated === 1 && res.rebuildAdd.luma < res.lumaBase - 0.05 &&
      res.rebuildRemove.invalidated === 1 && Math.abs(res.rebuildRemove.luma - res.lumaBase) < 0.02 &&
      // requests are per frame: empty sky requests fewer pages than the ground, and they come back
      res.requestedSky < res.requestedGround && res.requestedBack >= res.requestedGround - 2 &&
      // after dispose, a second instance took over the same materials and is paging
      res.second.rebound && res.second.enabled && res.second.requested > 0 && res.second.luma1 > res.second.luma0 + 0.1 &&
      // a second (Babylon) shadow on the same caster does not darken the overlap twice
      (!res.csm || (res.csm.babylonOnly < res.csm.noShadow - 0.1 &&
        Math.abs(res.csm.both - res.csm.sundialOnly) < 0.35 * (res.csm.noShadow - res.csm.sundialOnly))));
  failed ||= !ok;
  console.log(ok ? "PASS" : "FAIL", engine, JSON.stringify(res), errs.length ? "ERRORS: " + errs.join(" | ") : "");
  await p.close();
}
await b.close();
await server.close();
process.exit(failed ? 1 : 0);
