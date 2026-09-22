// Interleaved A/B benchmark in a real Chromium with vsync off. Integrated GPUs
// change clock state between runs, so every mode runs ROUNDS times in rotation
// per view and each figure reported is the median across rounds.
// Pass times are sampled on stats-readback frames, which over-represent page
// refresh frames under motion: read them as upper bounds.
// usage: [VIEWS=a,b] [MODES=x,y] [ROUNDS=3] [PORT=5188] node scripts/bench.mjs [extraQuery] [sampleMs]
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const extra = process.argv[2] ?? "";
const port = process.env.PORT ?? 5188;
const sampleMs = Number(process.argv[3] ?? 3000);
const rounds = Number(process.env.ROUNDS ?? 3);
const root = join(process.env.LOCALAPPDATA, "ms-playwright");
const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = [join(root, dir, "chrome-win64", "chrome.exe"), join(root, dir, "chrome-win", "chrome.exe")].find(existsSync);

const allViews = {
  village: "cam=10,26,70,-18,0,5",
  overview: "cam=-40,32,-60,-18,0,10",
  forest: "cam=60,6,-60,90,4,-30",
};
const views = Object.entries(allViews).filter(([n]) => !process.env.VIEWS || process.env.VIEWS.split(",").includes(n));
const modes = (process.env.MODES ?? "off,csm&tier=medium,csm&tier=high,sundial").split(",");

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: [...(process.env.GPU === "nvidia" ? ["--force_high_performance_gpu"] : []), "--enable-unsafe-webgpu", "--disable-gpu-vsync", "--disable-frame-rate-limit", "--window-size=1600,900", "--window-position=0,0"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/uncaptured/.test(m.text())) errors.push(m.text().slice(0, 200)); });
const med = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const fmt = (x) => (x == null ? "    —" : x.toFixed(2).padStart(6));
let adapter = "";
// A cold browser and the page before a run both leave the iGPU in a slow
// transient state (measured: 23.8 vs 6.8 ms for the same page). Warm every
// mode once, and load a cheap flush page before every measured run.
const load = async (query, settle) => {
  await page.goto(`http://localhost:${port}/?${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(settle);
};
for (const mode of modes) await load(`mode=${mode}&${extra}&${views[0][1]}&animate=0`, 1500);
console.log(`view      mode              frame ms   mark   paging  raster  r.p95  r.max   (medians of ${rounds} interleaved rounds, ${sampleMs} ms each)`);
for (const [name, view] of views) {
  const acc = Object.fromEntries(modes.map((m) => [m, { frame: [], mark: [], paging: [], raster: [], rasterP95: [], rasterMax: [], rendered: [] }]));
  for (let r = 0; r < rounds; r++) {
    for (const mode of modes) {
      await load(`mode=off&trees=10&${view}`, 1500);
      await load(`mode=${mode}&${extra}&${view}&animate=0`, 2000);
      const res = await page.evaluate((ms) => window.sundial.bench(ms), sampleMs);
      adapter ||= await page.evaluate(() => { const a = window.sundial.engine._adapterInfo; return a ? `${a.vendor} ${a.architecture}` : "?"; });
      if (process.env.SNAP) console.log(`  ${name} ${mode} r${r}: ${res.frame.median.toFixed(2)} ms  ${JSON.stringify(res.snapshot)}`);
      const a = acc[mode];
      a.frame.push(res.frame?.median);
      a.mark.push(res.mark?.median);
      a.paging.push(res.paging?.median);
      a.raster.push(res.raster?.median);
      a.rasterP95.push(res.raster?.p95);
      a.rasterMax.push(res.rasterMax);
      a.rendered.push(res.rendered?.median);
    }
  }
  for (const mode of modes) {
    const a = acc[mode];
    console.log(`${name.padEnd(9)} ${mode.padEnd(16)} ${fmt(med(a.frame))}   ${fmt(med(a.mark))} ${fmt(med(a.paging))} ${fmt(med(a.raster))} ${fmt(med(a.rasterP95))} ${fmt(med(a.rasterMax))}   runs: ${a.frame.map((x) => x?.toFixed(1)).join(" ")}`);
  }
}
console.log("adapter:", adapter, errors.length ? `\nerrors: ${[...new Set(errors)].join("\n")}` : "");
await browser.close();
