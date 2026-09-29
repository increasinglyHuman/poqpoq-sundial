// Load a page in real Chromium with WebGPU and print the result of an expression.
// usage: node scripts/eval.mjs "/page.html?q" "<js expression>" [settleMs]
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [url, expr, settle = "3000"] = process.argv.slice(2);
const root = join(process.env.LOCALAPPDATA, "ms-playwright");
const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = [join(root, dir, "chrome-win64", "chrome.exe"), join(root, dir, "chrome-win", "chrome.exe")].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: false, args: [...(process.env.GPU === "nvidia" ? ["--force_high_performance_gpu"] : []), "--enable-unsafe-webgpu", "--window-size=1600,900"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${process.env.PORT ?? 5261}${url}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 }).catch(() => logs.push("[timeout] never ready"));
await page.waitForTimeout(Number(settle));
console.log(JSON.stringify(await page.evaluate(expr).catch((e) => "EVAL ERROR " + e.message), null, 1));
console.log(logs.join("\n"));
await browser.close();
