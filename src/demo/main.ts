import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core"; // the demo pulls in every engine extension; the adapter does not need to
import { SundialBabylon } from "../babylon/SundialBabylon";
import { buildWorld, SIM } from "./world";

type Mode = "sundial" | "csm" | "off";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

const state = {
  mode: (q.get("mode") as Mode) ?? "sundial",
  tier: q.get("tier") === "high" ? "high" : "medium",
  azimuth: num("az", 215),
  elevation: num("el", 38),
  sunSpeed: num("speed", 0), // degrees of azimuth per second
  animate: q.get("animate") !== "0",
};

// Receiver experiments for profiling, e.g. ?rx=onetap. Each rewrites the
// receiver WGSL before Babylon compiles it.
const RECEIVER_VARIANTS: Record<string, [RegExp | string, string][]> = {
  // One texel, no PCF: the floor cost of finding the page.
  onetap: [["if (all(local >= vec2i(0))", "return select(0.0, 1.0, z <= textureLoad(psPool, vec2i(0), 0)); if (all(local >= vec2i(0))"]],
  // One bilinear tap (2x2 texels) instead of 3x3 (4x4 texels).
  bilinear: [[/var j = 0; j < 4;/g, "var j = 1; j < 3;"], [/var i = 0; i < 4;/g, "var i = 1; i < 3;"]],
  // Skip the page-table read (wrong shadows; cost probe only).
  nolookup: [["let phys1 = psLookup(level, page);", "let phys1 = 1u;"]],
};
const rx = q.get("rx");
if (rx && RECEIVER_VARIANTS[rx]) {
  (globalThis as { __psReceiver?: (s: string) => string }).__psReceiver = (src) =>
    RECEIVER_VARIANTS[rx].reduce((s, [from, to]) => s.replace(from, to), src);
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  if (!navigator.gpu) {
    document.getElementById("hud")!.textContent = "WebGPU is not available in this browser.";
    return;
  }
  const engine = new WebGPUEngine(canvas, { antialias: true, enableAllFeatures: true, setMaximumLimits: true });
  await engine.initAsync();
  engine.enableGPUTimingMeasurements = true;
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.62, 0.76, 0.92, 1);
  scene.ambientColor = new Color3(0.3, 0.3, 0.3);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0022;
  scene.fogColor = new Color3(0.66, 0.78, 0.92);

  const camPos = (q.get("cam") ?? "-58,14,-40,-18,2,8").split(",").map(Number);
  const camera = new UniversalCamera("cam", new Vector3(camPos[0], camPos[1], camPos[2]), scene);
  camera.setTarget(new Vector3(camPos[3], camPos[4], camPos[5]));
  camera.fov = 0.9;
  camera.minZ = 0.1;
  camera.maxZ = 800;
  camera.speed = 0.6;
  camera.keysUp.push(87);
  camera.keysDown.push(83);
  camera.keysLeft.push(65);
  camera.keysRight.push(68);
  camera.attachControl(canvas, true);

  const sun = new DirectionalLight("sun", new Vector3(0, -1, 0), scene);
  sun.intensity = 1.35;
  sun.diffuse = new Color3(1, 0.96, 0.88);
  sun.specular = new Color3(0.5, 0.48, 0.44);
  const sky = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
  sky.intensity = 0.5;
  sky.diffuse = new Color3(0.72, 0.8, 1);
  sky.groundColor = new Color3(0.32, 0.3, 0.26);
  const setSun = () => {
    const az = (state.azimuth * Math.PI) / 180;
    const el = (state.elevation * Math.PI) / 180;
    sun.direction = new Vector3(-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az));
    sun.position = sun.direction.scale(-200);
  };
  setSun();

  const treeCount = num("trees", 1400);
  const world = buildWorld(scene, treeCount);

  // ---- Sundial ----------------------------------------------------------------
  const sundial = new SundialBabylon(scene, sun, {
    sceneMin: [-SIM / 2, -8, -SIM / 2],
    sceneMax: [SIM / 2, 40, SIM / 2],
    levels: 7,
    pagesPerSide: 16,
    pageSize: 128,
    poolSize: 4096,
    finestPageWorldSize: 1,
    renderBudget: num("budget", 96),
  });
  sundial.setAlphaMask(0, world.leafMask, 0.5);
  sundial.addCaster(world.terrain);
  sundial.addCaster(world.trunks);
  sundial.addCaster(world.leaves, { alphaLayer: 0, alphaCutoff: 0.5 });
  for (const p of world.prims) sundial.addCaster(p);
  for (const m of world.movers) {
    m.update(0);
    sundial.addCaster(m.mesh, { dynamic: true });
  }
  sundial.addReceivers(world.materials);
  sundial.core.tuning.debugMode = q.get("debug") === "1" ? 1 : 0;
  sundial.core.tuning.lodBias = num("lodBias", 0);
  sundial.core.markStride = num("stride", 2);
  sundial.start();

  // ---- CSM, configured like ShadowDirector's tiers ------------------------------
  let csm: CascadedShadowGenerator | null = null;
  const casters: Mesh[] = [world.terrain, world.trunks, world.leaves, ...world.prims, ...world.movers.map((m) => m.mesh)];
  const makeCsm = () => {
    const high = state.tier === "high";
    const g = new CascadedShadowGenerator(high ? 4096 : 2048, sun);
    g.numCascades = high ? 4 : 3;
    g.shadowMaxZ = high ? 300 : 200;
    g.stabilizeCascades = true;
    g.lambda = 0.8;
    g.bias = 0.005;
    g.normalBias = 0.03;
    g.usePercentageCloserFiltering = true;
    g.filteringQuality = CascadedShadowGenerator.QUALITY_MEDIUM;
    for (const c of casters) g.addShadowCaster(c, false);
    return g;
  };

  const setMode = (mode: Mode) => {
    state.mode = mode;
    if (csm && mode !== "csm") {
      csm.dispose();
      csm = null;
    }
    if (mode === "csm" && !csm) csm = makeCsm();
    sundial.setEnabled(mode === "sundial");
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === mode);
    });
  };

  // ---- UI -----------------------------------------------------------------------
  const bind = (id: string, apply: (v: number) => void) => {
    const el = document.getElementById(id) as HTMLInputElement;
    el.addEventListener("input", () => apply(Number(el.value)));
    return el;
  };
  bind("el", (v) => { state.elevation = v; }).value = String(state.elevation);
  bind("az", (v) => { state.azimuth = v; }).value = String(state.azimuth);
  bind("speed", (v) => { state.sunSpeed = v; }).value = String(state.sunSpeed);
  bind("band", (v) => { sundial.core.tuning.bandDegrees = v; }).value = String(sundial.core.tuning.bandDegrees);
  bind("lod", (v) => { sundial.core.tuning.lodBias = v; }).value = String(sundial.core.tuning.lodBias);
  (document.getElementById("debug") as HTMLInputElement).checked = sundial.core.tuning.debugMode === 1;
  document.getElementById("debug")!.addEventListener("change", (e) => {
    sundial.core.tuning.debugMode = (e.target as HTMLInputElement).checked ? 1 : 0;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode)),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-tier]").forEach((b) =>
    b.addEventListener("click", () => {
      state.tier = b.dataset.tier!;
      if (csm) {
        csm.dispose();
        csm = makeCsm();
      }
    }),
  );
  setMode(state.mode);

  const walkSpeed = num("walk", 0);
  let walkT = 0;
  const walkStart = camera.position.clone();
  const walkDir = camera.getTarget().subtract(camera.position);
  walkDir.y = 0;
  walkDir.normalize();
  const hud = document.getElementById("stats")!;
  let frameMs = 16;
  let t = 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    frameMs = frameMs * 0.95 + engine.getDeltaTime() * 0.05;
    if (state.animate) t += dt;
    for (const m of world.movers) m.update(t);
    if (walkSpeed > 0) {
      // Walk back and forth along a 120 m line through the forest.
      walkT += dt * walkSpeed;
      const phase = (walkT % 240) < 120 ? walkT % 120 : 120 - (walkT % 120);
      const along = walkDir.scale(phase - 60);
      camera.position.copyFrom(walkStart.add(along));
      camera.setTarget(camera.position.add(walkDir.scale(10)).add(new Vector3(0, -2, 0)));
    }
    state.azimuth = (state.azimuth + state.sunSpeed * dt + 360) % 360;
    setSun();
  });
  // Sundial's own observer was added in start(); movers and sun are updated first
  // because this observer is inserted at the front.
  const obs = scene.onBeforeRenderObservable;
  obs.makeObserverTopPriority(obs.observers[obs.observers.length - 1]);

  const summary = sundial.core.contentSummary;
  setInterval(() => {
    const s = sundial.core.stats;
    const csmNs = (csm?.getShadowMap()?.renderTarget as unknown as { gpuTimeInFrame?: { counter: { lastSecAverage: number } } })
      ?.gpuTimeInFrame?.counter.lastSecAverage;
    const lines = [
      `mode          ${state.mode}${state.mode === "csm" ? ` (${state.tier})` : ""}`,
      `frame         ${frameMs.toFixed(2)} ms  (${(1000 / frameMs).toFixed(0)} fps)`,
      `sun           az ${state.azimuth.toFixed(2)}°  el ${state.elevation.toFixed(1)}°`,
      ``,
    ];
    if (state.mode === "sundial") {
      lines.push(
        `mark GPU      ${s.gpuMarkMs?.toFixed(3) ?? "n/a"} ms (incl. depth wait)`,
        `paging GPU    ${s.gpuComputeMs?.toFixed(3) ?? "n/a"} ms`,
        `raster GPU    ${s.gpuRasterMs?.toFixed(3) ?? "n/a"} ms`,
        `pages         ${s.requestedPages} wanted · ${s.residentPages} resident / ${sundial.core.pageCount}`,
        `this frame    ${s.renderedPages} drawn · ${s.deferredPages} deferred · ${s.allocationFailures} alloc fails`,
        `pairs         ${s.opaquePairs} opaque · ${s.alphaPairs} alpha`,
        `level refresh ${s.levelRefreshes} (last L${s.lastRefreshedLevel})`,
        `clip distances ${sundial.core.useClipDistances ? "yes" : "no (discard)"}`,
      );
    } else if (state.mode === "csm") {
      lines.push(`shadow GPU    ${csmNs !== undefined ? (csmNs / 1e6).toFixed(3) + " ms" : "n/a"}`);
    }
    lines.push(
      ``,
      `content       ${summary.triangles.toLocaleString()} tris · ${summary.instances} instances`,
      `              ${summary.clusters} clusters · ${summary.clusterInstances.toLocaleString()} cluster instances`,
    );
    hud.textContent = lines.join("\n");
  }, 250);

  // Benchmark: sample every frame for `ms`, report medians and p95.
  const samples: { frame: number[]; mark: number[]; paging: number[]; raster: number[]; rendered: number[]; csm: number[] } = { frame: [], mark: [], paging: [], raster: [], rendered: [], csm: [] };
  let sampling = false;
  let lastStatsFrame = -1;
  scene.onAfterRenderObservable.add(() => {
    if (!sampling) return;
    samples.frame.push(engine.getDeltaTime());
    const s = sundial.core.stats;
    if (state.mode === "sundial" && s.frame !== lastStatsFrame && s.gpuComputeMs !== null) {
      lastStatsFrame = s.frame;
      samples.mark.push(s.gpuMarkMs ?? 0);
      samples.paging.push(s.gpuComputeMs);
      samples.raster.push(s.gpuRasterMs ?? 0);
      samples.rendered.push(s.renderedPages);
    }
    const ns = (csm?.getShadowMap()?.renderTarget as unknown as { gpuTimeInFrame?: { counter: { current: number } } })
      ?.gpuTimeInFrame?.counter.current;
    if (state.mode === "csm" && ns) samples.csm.push(ns / 1e6);
  });
  const stat = (a: number[]) => {
    if (!a.length) return null;
    const b = [...a].sort((x, y) => x - y);
    return { median: b[Math.floor(b.length / 2)], p95: b[Math.floor(b.length * 0.95)], n: b.length };
  };
  const bench = async (ms: number) => {
    for (const k of Object.keys(samples) as (keyof typeof samples)[]) samples[k] = [];
    sampling = true;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    sampling = false;
    // Throughput, not per-frame deltas: with vsync off, deltas are bimodal.
    const frameMs = (performance.now() - t0) / Math.max(1, samples.frame.length);
    const st = sundial.core.stats;
    const snapshot = {
      size: `${engine.getRenderWidth()}x${engine.getRenderHeight()}`,
      dpr: devicePixelRatio,
      requested: st.requestedPages,
      resident: st.residentPages,
      activeMeshes: scene.getActiveMeshes().length,
      effects: Object.keys((engine as unknown as { _compiledEffects: object })._compiledEffects ?? {}).length,
      samples: samples.frame.length,
    };
    return { snapshot, frame: { median: frameMs, p95: frameMs, n: samples.frame.length }, mark: stat(samples.mark), paging: stat(samples.paging), raster: stat(samples.raster), rendered: stat(samples.rendered), rasterMax: samples.raster.length ? Math.max(...samples.raster) : null, csmShadow: stat(samples.csm) };
  };

  (window as unknown as Record<string, unknown>).sundial = {
    bench, sundial, scene, engine, state, setMode, stats: () => sundial.core.stats };
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
  (window as unknown as Record<string, unknown>).__ready = true;
}

main().catch((e) => {
  console.error(e);
  document.getElementById("hud")!.textContent = String(e?.stack ?? e);
});
