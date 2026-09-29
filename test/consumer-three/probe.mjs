// Loads the three.js consumer page on WebGL and WebGPU in real Chrome and
// asserts the ported Babylon-consumer checks plus the three-specific ones
// (see test/consumer-three/src/main.js). Starts and stops its own Vite dev
// server on port 5281 (or $CONSUMER_PORT). Modeled on test/consumer/probe.mjs.
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import { createServer } from "vite";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(process.env.LOCALAPPDATA, "ms-playwright");
const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = [join(root, dir, "chrome-win64", "chrome.exe"), join(root, dir, "chrome-win", "chrome.exe")].find(existsSync);

const server = await createServer({ root: import.meta.dirname, configFile: join(import.meta.dirname, "vite.config.js") });
await server.listen();
const b = await chromium.launch({ executablePath: exe, headless: false, args: ["--force_high_performance_gpu", "--enable-unsafe-webgpu"] });

let failed = false;

/** engine + flags -> the pass/fail expression for that variant's result. */
function evaluate(variant, res) {
  if (variant === "webgl") {
    return res.imported && !res.error && res.supported === false;
  }
  if (variant !== "webgpu") {
    // aa=1 / tonemap=0 / nofeat=1 / reversed=1: a targeted smoke check, not
    // the full battery — Sundial must still be supported, page real content,
    // hit no GPU errors, and (for nofeat/aa/tonemap) that must all hold with
    // no allocation failures. reversed=1 exercises a renderer option the
    // currently-checked-out core does not yet know about (see below) so it
    // only gets a no-crash/paging smoke check, not a correctness assertion.
    const s = res.smoke;
    return res.imported && !res.error && res.supported === true && res.gpuErrors.length === 0 &&
      !!s && s.requestedPages > 0 && s.allocationFailures === 0;
  }
  // plain ?engine=webgpu: the full battery. Each check is an expression over
  // `res` and `core`; the failing ones are listed in the output.
  const core = res.core;
  const checks = [
    'res.imported',
    '!res.error',
    'res.supported === true',
    'res.gpuErrors.length === 0',
    '!!core',
    'core.requestedPages > 0',
    'core.allocationFailures === 0',
    // ground 32 + box 12 + the prim's 6 visible triangles (its hidden half must not cast) + leaf 2
    'res.firstBuild.triangles === 52',
    'res.firstBuild.geometries === 4',
    'res.firstBuild.alphaClusters === 0',
    // the leaf's mask is read and the adapter rebuilds on its own
    'res.rebuild.alphaClusters === 1',
    // a no-op setCasters() hits the geometry cache for everything registered
    'res.rebuildCache.cachedGeometries === res.rebuildCache.geometries',
    'res.rebuildCache.triangles === 52',
    // darkness 1 hides every shadow, so the frame gets brighter
    'res.lumaDark1 > res.lumaDark0 + 0.04',
    // setEnabled(false) brightens the frame; back on is pixel-identical to before
    'res.lumaEnabledOff > res.lumaEnabledBefore + 0.04',
    'Math.abs(res.lumaEnabledBack - res.lumaEnabledBefore) < 0.02',
    // a cloned receiving material still receives
    'res.clone.ok',
    'res.clone.receives',
    // boxes that differ only by fractions of a unit are two geometries, not one
    'res.distinct.added === 2',
    // rebuilds re-render only what changed
    'res.rebuildSame.reusedGeometry === true',
    'res.rebuildSame.invalidated === 0',
    'res.rebuildSame.luma === res.lumaBase',
    'res.rebuildAdd.invalidated === 1',
    'res.rebuildAdd.luma < res.lumaBase - 0.03',
    'res.rebuildRemove.invalidated === 1',
    'Math.abs(res.rebuildRemove.luma - res.lumaBase) < 0.02',
    // updateCaster(mesh) moves a static caster's shadow without a rebuild,
    // read at spot A and spot B separately (see main.js): starts shadowing A
    // (not B), ends up shadowing B (not A), and moving back restores that.
    'res.moveApi.accepted',
    'res.moveApi.calls.box === 1',
    'res.moveApi.calls.all === 0',
    '!res.moveApi.rebuilt',
    'res.moveApi.postsA0 < res.moveApi.postsB0 - 0.04',
    'res.moveApi.postsB1 < res.moveApi.postsA1 - 0.04',
    'res.moveApi.refusedUnregistered',
    'Math.abs(res.moveApi.postsA2 - res.moveApi.postsA0) < 0.03',
    'Math.abs(res.moveApi.postsB2 - res.moveApi.postsB0) < 0.03',
    // the min/max early-out changes no pixel, off or back on
    'res.minMax.diffOff === 0',
    'res.minMax.diffBack === 0',
    // requests are per frame
    'res.requestedSky < res.requestedGround',
    'res.requestedBack >= res.requestedGround - 2',
    // a receiver past the depth range is lit, not shadowed
    'Math.abs(res.farReceiver.lit - res.farReceiver.shadowed) < 0.5',
    // receiveShadow=false is unaffected by darkness
    'res.receiveShadowFalse.unaffected',
    // a second (three-native) shadow on another light still works alongside Sundial
    // (the native shadow alone is small in this frame: a few thousandths of luma)
    'res.otherLight.otherOnly < res.otherLight.noShadow - 0.002',
    // and Sundial's own shadow of the same caster adds on top of it
    'res.otherLight.both < res.otherLight.otherOnly - 0.02',
    'res.otherLight.both <= res.otherLight.otherOnly + 0.02',
    // dispose() restores the light and a second instance takes over and shades
    'res.dispose.noShadowNode',
    'res.dispose.castShadowOff',
    // the same frame as the first instance shaded before dispose(), and it responds to darkness
    'res.second.requested > 0',
    'Math.abs(res.second.luma0 - res.second.lumaFirst) < 0.002',
    'res.second.luma1 > res.second.luma0 + 0.003',
    // a moving dynamic caster's shadow follows it: parent, own position, InstancedMesh
    'res.dynamicFollow.atA === "A"',
    'res.dynamicFollow.viaParent === "B"',
    'res.dynamicFollow.viaPosition === "A"',
    'res.dynamicFollow.instA === "A"',
    'res.dynamicFollow.instB === "B"',
    // a dynamic SkinnedMesh casts its posed shadow
    'res.skinned.moved',
    // alphaMap reads the GREEN channel
    'res.alphaMapLeaf.grew',
    // updateCaster refuses a caster whose instance count changed underneath it
    'res.updateCasterRefusesCountChange',
    // documented, not ported: no per-mesh registration memo, no CSM min() combine
    'res.memo.skipped',
    'res.csmMinCombo.skipped',
  ];
  res.failed = checks.filter((c) => { try { return !new Function("res", "core", `return (${c});`)(res, core); } catch { return true; } });
  return res.failed.length === 0;
}

for (const variant of ["webgl", "webgpu", "webgpu&aa=1", "webgpu&tonemap=0", "webgpu&nofeat=1", "webgpu&reversed=1"]) {
  const p = await b.newPage({ viewport: { width: 700, height: 560 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  await p.goto(`http://localhost:${process.env.CONSUMER_PORT ?? 5281}/?engine=${variant}`);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await p.waitForFunction(() => window.__result.done || !window.__result.supported || window.__result.error, null, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(500);
  const res = await p.evaluate(() => {
    const r = window.__result;
    return { ...r, core: r.core ? (({ requestedPages, residentPages, allocationFailures, alphaPairs, opaquePairs }) => ({ requestedPages, residentPages, allocationFailures, alphaPairs, opaquePairs }))(r.core()) : undefined };
  });
  let ok = false;
  let evalError = null;
  try { ok = res.done && errs.length === 0 && evaluate(variant, res); } catch (e) { evalError = String(e); }
  failed ||= !ok;
  if (res.failed?.length) console.log("  failed:", res.failed.join("  |  "));
  console.log(ok ? "PASS" : "FAIL", variant, JSON.stringify(res), errs.length ? "ERRORS: " + errs.join(" | ") : "", evalError ? "EVAL-ERROR: " + evalError : "");
  await p.close();
}
await b.close();
await server.close();
process.exit(failed ? 1 : 0);
