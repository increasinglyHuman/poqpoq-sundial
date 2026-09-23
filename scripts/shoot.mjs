// Drive the lab in a real Chromium with WebGPU: collect console errors,
// wait for the page to settle, print Sundial's stats, and screenshot.
// usage: node scripts/shoot.mjs "<query>|/page.html?query" out.png [settleMs]
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const query = process.argv[2] ?? "";
const out = process.argv[3] ?? "shot.png";
const settle = Number(process.argv[4] ?? 4000);
const root = join(process.env.LOCALAPPDATA, "ms-playwright");
const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = [join(root, dir, "chrome-win64", "chrome.exe"), join(root, dir, "chrome-win", "chrome.exe")].find(existsSync);

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: [...(process.env.GPU === "nvidia" ? ["--force_high_performance_gpu"] : []), "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-gpu-sandbox", "--window-size=1600,900", "--window-position=0,0"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(query.startsWith("/") ? `http://localhost:${process.env.PORT ?? 5188}${query}` : `http://localhost:${process.env.PORT ?? 5188}/?${query}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 }).catch(() => logs.push("[timeout] never ready"));
await page.waitForTimeout(settle);
const info = await page.evaluate(() => ({
  hud: document.getElementById("stats")?.textContent,
  adapter: window.sundial?.engine?._adapterInfo ? `${window.sundial.engine._adapterInfo.vendor} ${window.sundial.engine._adapterInfo.architecture} ${window.sundial.engine._adapterInfo.description}` : "?",
}));
await page.screenshot({ path: out });
console.log("adapter:", info.adapter);
console.log(info.hud);
console.log(logs.slice(0, 40).join("\n"));
await browser.close();
