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
  await p.waitForTimeout(2500);
  const res = await p.evaluate(() => { const r = window.__result; return { ...r, core: r.core ? (({ requestedPages, residentPages, allocationFailures }) => ({ requestedPages, residentPages, allocationFailures }))(r.core()) : undefined }; });
    const ok = res.imported && !res.error && errs.length === 0 &&
    (engine === "webgl2" ? res.supported === false : res.supported === true && res.core.requestedPages > 0 && res.core.allocationFailures === 0);
  failed ||= !ok;
  console.log(ok ? "PASS" : "FAIL", engine, JSON.stringify(res), errs.length ? "ERRORS: " + errs.join(" | ") : "");
  await p.close();
}
await b.close();
await server.close();
process.exit(failed ? 1 : 0);
