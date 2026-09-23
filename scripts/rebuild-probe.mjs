// Rebuild cost on comm-sized content: ~1,100 unique geometries, ~2.4 M vertices.
// Times setCasters() for: start-up build, unchanged rebuilds, one mesh added, one removed, content
// dropping out and coming back, a shape re-created, and a mesh whose vertices are edited in place
// (same array + updateVerticesData, as World's Dozer does). Each row also reports the registration
// memo's hits and misses, and the internal rebuilds the adapter made on its own.
// DIGEST=1 first prints a digest of the demo world's clustered geometry (indices and cluster
// records, in registration order), so two builds can be compared for identical cluster output.
// usage: PORT=5199 node rebuild-probe.mjs      (N=<meshes>, default 1100)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const root = join(process.env.LOCALAPPDATA, "ms-playwright");
const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = [join(root, dir, "chrome-win64", "chrome.exe"), join(root, dir, "chrome-win", "chrome.exe")].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: false, args: ["--enable-unsafe-webgpu", "--force_high_performance_gpu"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`http://localhost:${process.env.PORT ?? 5199}/?mode=sundial`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
await page.waitForTimeout(2000);
if (process.env.DIGEST) {
  const digest = await page.evaluate(() => {
    const core = window.sundial.sundial.core;
    let h = 0x811c9dc5;
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    const mix = (x) => { h = Math.imul(h ^ x, 0x01000193); };
    let clusters = 0;
    for (const g of core.geometries) {
      for (const i of g.indices) mix(i);
      for (const c of g.clusters) {
        clusters++;
        for (const x of [...c.aabbMin, ...c.aabbMax, c.alphaCutoff]) { f[0] = x; mix(u[0]); }
        mix(c.firstIndex); mix(c.triCount); mix(c.alphaLayer >>> 0);
      }
    }
    return { geometries: core.geometries.length, clusters, digest: (h >>> 0).toString(16) };
  });
  console.log("cluster digest", JSON.stringify(digest));
}
const out = await page.evaluate(async (n) => {
  const { sundial: sd, scene } = window.sundial;
  const Mesh = scene.meshes.find((m) => m.getTotalVertices() > 0).constructor;
  const G = 47; // 47x47 grid: 2,209 vertices, 4,232 triangles
  const make = (k, updatable = false) => {
    const m = new Mesh(`probe${k}`, scene);
    const pos = new Float32Array(G * G * 3);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const o = (y * G + x) * 3;
        pos[o] = x * 0.1;
        pos[o + 1] = Math.sin(x * 0.3 + k) * 0.5 + Math.random() * 0.01;
        pos[o + 2] = y * 0.1;
      }
    const idx = new Uint32Array((G - 1) * (G - 1) * 6);
    let i = 0;
    for (let y = 0; y < G - 1; y++)
      for (let x = 0; x < G - 1; x++) {
        const a = y * G + x;
        idx.set([a, a + G, a + 1, a + 1, a + G, a + G + 1], i);
        i += 6;
      }
    m.setVerticesData("position", pos, updatable);
    m.setIndices(idx);
    m.position.set((k % 40) * 12 - 240, 1, Math.floor(k / 40) * 12 - 240);
    m.computeWorldMatrix(true);
    return m;
  };
  const meshes = [];
  for (let k = 0; k < n; k++) meshes.push(make(k, k === 3));
  // Phase timers around the core.
  const core = sd.core;
  const t = { build: 0, clear: 0 };
  const wrap = (name, key) => {
    const f = core[name].bind(core);
    core[name] = (...a) => { const t0 = performance.now(); const r = f(...a); t[key] += performance.now() - t0; return r; };
  };
  wrap("build", "build");
  wrap("clearContent", "clear");
  const run = async (label, list) => {
    t.build = t.clear = 0;
    const m0 = { ...sd.registrationStats };
    const i0 = core.contentSummary.internalBuilds;
    const t0 = performance.now();
    sd.setCasters(list.map((mesh) => ({ mesh })));
    const total = performance.now() - t0;
    const m1 = { ...sd.registrationStats };
    await new Promise((r) => setTimeout(r, 300));
    const c = core.contentSummary;
    return {
      label, totalMs: +total.toFixed(1), registerMs: +(total - t.build - t.clear).toFixed(1), buildMs: +t.build.toFixed(1), clearMs: +t.clear.toFixed(1),
      memoHits: m1.memoHits - m0.memoHits, memoMisses: m1.memoMisses - m0.memoMisses,
      reused: c.lastBuild.reusedGeometry, invalidated: c.lastBuild.invalidated, cached: c.cachedGeometries, geometries: c.geometries,
      internal: c.internalBuilds - i0,
    };
  };
  const rows = [];
  rows.push(await run("start-up build", meshes));
  rows.push(await run("unchanged", meshes));
  rows.push(await run("unchanged", meshes));
  const extra = make(n);
  rows.push(await run("+1 mesh (appended)", [...meshes, extra]));
  rows.push(await run("-1 mesh (removed)", meshes.slice(1).concat(extra)));
  rows.push(await run("unchanged", meshes.slice(1).concat(extra)));
  // Content that drops out for one rebuild and comes back (hidden while loading).
  rows.push(await run("-100 meshes", meshes.slice(100)));
  rows.push(await run("100 back", meshes));
  // A mesh deleted and re-created with the same shape (World re-creates prims).
  const k = 7;
  const again = new Mesh("probe-again", scene);
  again.setVerticesData("position", meshes[k].getVerticesData("position"));
  again.setIndices(meshes[k].getIndices());
  again.position.copyFrom(meshes[k].position);
  again.computeWorldMatrix(true);
  const swapped = meshes.slice();
  swapped[k] = again;
  rows.push(await run("same shape re-created", swapped));
  // One mesh's vertices edited in place: same array, then updateVerticesData (Dozer's pattern).
  const edited = meshes[3];
  const pos = edited.getVerticesData("position");
  for (let i = 1; i < pos.length; i += 3) pos[i] += 0.25;
  edited.updateVerticesData("position", pos);
  rows.push(await run("in-place vertex edit", swapped));
  rows.push(await run("unchanged", swapped));
  return rows;
}, Number(process.env.N ?? 1100));
console.table(out);
await browser.close();
