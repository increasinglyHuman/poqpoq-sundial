import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { SundialThree } from "../three";
import { buildWorld, heightAt, SIM } from "./world";
import { buildCharacters } from "./skinned";

// three.js port of src/demo/main.ts: the same benchmark lab (world, modes,
// HUD, URL parameters, bench()), driving SundialThree instead of
// SundialBabylon, with three's own CSMShadowNode standing in for Babylon's
// CascadedShadowGenerator.
//
// Handedness: Babylon is left-handed, three is right-handed. World content
// (world.ts, skinned.ts) is built with Babylon's own numbers, unmirrored, and
// parented under `worldGroup` (scale.z = -1) — three auto-corrects triangle
// winding for the negative determinant this produces. The camera and sun
// below negate the Z of every Babylon-space position/target the same way, so
// the same `cam=`/`el=`/`az=` values used against the Babylon lab look at the
// same content from the same relative angle. See world.ts's header comment.

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

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  if (!navigator.gpu) {
    document.getElementById("hud")!.textContent = "WebGPU is not available in this browser.";
    return;
  }
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  await renderer.init();
  renderer.setClearColor(new THREE.Color(0.62, 0.76, 0.92), 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(0.66, 0.78, 0.92).getHex(), 0.0022);

  const camPos = (q.get("cam") ?? "-58,14,-40,-18,2,8").split(",").map(Number);
  const camera = new THREE.PerspectiveCamera((0.9 * 180) / Math.PI, innerWidth / innerHeight, 0.1, 800);
  // Mirror Z the same way world content is mirrored (see world.ts).
  camera.position.set(camPos[0], camPos[1], -camPos[2]);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(camPos[3], camPos[4], -camPos[5]);
  controls.update();

  const sky = new THREE.HemisphereLight(new THREE.Color(0.72, 0.8, 1), new THREE.Color(0.32, 0.3, 0.26), 0.5);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(new THREE.Color(1, 0.96, 0.88), 1.35);
  scene.add(sun, sun.target);
  const setSun = () => {
    const az = (state.azimuth * Math.PI) / 180;
    const el = (state.elevation * Math.PI) / 180;
    const dx = -Math.cos(el) * Math.sin(az);
    const dy = -Math.sin(el);
    const dz = -Math.cos(el) * Math.cos(az);
    // position = -direction * 200, then Z-mirrored (see header comment).
    sun.position.set(-dx * 200, -dy * 200, dz * 200);
    sun.target.position.set(0, 0, 0);
  };
  setSun();

  const treeCount = num("trees", 1400);
  const world = buildWorld(treeCount);
  world.group.scale.set(1, 1, -1); // the Babylon -> three handedness mirror
  scene.add(world.group);
  for (const m of [world.terrain, world.trunks, world.leaves, ...world.prims, ...world.movers.map((mv) => mv.mesh)]) {
    m.castShadow = true;
  }

  // ?skinned=N: N procedural skinned characters walking a loop (skinned casters).
  // ?skinT=<seconds> freezes their pose at that time, for repeatable shots.
  const skinned = buildCharacters(num("skinned", 0), heightAt);
  for (const c of skinned.characters) {
    c.mesh.castShadow = true;
    world.group.add(c.mesh);
  }
  const skinT = q.has("skinT") ? num("skinT", 0) : null;
  for (const c of skinned.characters) c.update(skinT ?? 0);

  if (!SundialThree.isSupported(renderer)) {
    document.getElementById("hud")!.textContent = "Sundial needs WebGPURenderer on its WebGPU backend.";
    return;
  }

  // ---- Sundial ------------------------------------------------------------
  const sundial = new SundialThree(renderer, scene, camera, sun, {
    sceneMin: [-SIM / 2, -8, -SIM / 2],
    sceneMax: [SIM / 2, 40, SIM / 2],
    levels: 7,
    pagesPerSide: 16,
    pageSize: 128,
    poolSize: 4096,
    finestPageWorldSize: 1,
    renderBudget: num("budget", 96),
    staticCache: q.get("cache") !== "0",
    dynamicBudget: num("dynBudget", 64),
    clipDistances: q.get("clip") !== "0",
  });
  sundial.core.profiling = q.get("profile") !== "0";
  sundial.setAlphaMask(0, world.leafMask, 0.5);
  sundial.addCaster(world.terrain);
  sundial.addCaster(world.trunks);
  sundial.addCaster(world.leaves, { alphaLayer: 0, alphaCutoff: 0.5 });
  for (const p of world.prims) sundial.addCaster(p);
  // ?movers=N: N more avatars walking loops through the forest, for the
  // static cache's A/B (each one crosses pages full of alpha-tested trees).
  const extraMovers = Math.max(0, Math.floor(num("movers", 0)));
  if (extraMovers > 0) {
    const walkerMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.3, 0.2) });
    world.materials.push(walkerMat);
    let seed = 99;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < extraMovers; i++) {
      const walker = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.8 - 2 * 0.32, 4, 8), walkerMat);
      walker.receiveShadow = true;
      walker.castShadow = true;
      world.group.add(walker);
      const cx = 40 + rnd() * 70;
      const cz = -80 + rnd() * 70;
      const rad = 6 + rnd() * 10;
      const speed = (0.3 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1);
      const phase = rnd() * Math.PI * 2;
      world.movers.push({
        mesh: walker,
        update(t) {
          const a = phase + (t * speed * 4) / rad;
          const x = cx + Math.cos(a) * rad;
          const z = cz + Math.sin(a) * rad;
          walker.position.set(x, heightAt(x, z) + 0.9, z);
        },
      });
    }
  }
  // ?t=seconds starts the movers' clock there; ?stopAt=seconds freezes it there.
  const startT = num("t", 0);
  const stopAt = num("stopAt", Infinity);
  for (const m of world.movers) {
    m.update(startT);
    sundial.addCaster(m.mesh, { dynamic: true });
  }
  for (const c of skinned.characters) sundial.addCaster(c.mesh, { dynamic: true });
  sundial.core.tuning.debugMode = q.get("debug") === "1" ? 1 : 0;
  sundial.core.tuning.lodBias = num("lodBias", 0);
  sundial.core.tuning.minMaxEarlyOut = q.get("minmax") !== "0";
  sundial.core.markStride = num("stride", 2);
  sundial.core.markRotate = q.get("rotate") === "1";
  sundial.start();
  // Captured right after start(): SundialThree attaches its own shadow node
  // to `sun.shadow.shadowNode` here. Mode switching below swaps that
  // reference between this and CSM's node; there is no public getter for it.
  const sundialShadowNode = (sun.shadow as unknown as { shadowNode: unknown }).shadowNode;

  // ---- CSM, configured like ShadowDirector's tiers -------------------------
  // Cascade count, shadow map size and far distance are matched to the
  // Babylon lab's tiers exactly (3x2048 / 200m for medium, 4x4096 / 300m for
  // high). CSMShadowNode has no `stabilizeCascades`, `bias` scaled the same
  // way per cascade, or filtering-quality knob the way CascadedShadowGenerator
  // does, so the split scheme (a custom callback reproducing Babylon's
  // lambda = 0.8 practical split) and light.shadow.bias/normalBias are the
  // closest three's API allows; PCF quality is whatever three's own shadow()
  // TSL node uses for a DirectionalLight and is not separately tunable here.
  let csm: CSMShadowNode | null = null;
  const lambdaSplit = (amount: number, near: number, far: number, target: number[]) => {
    const uni: number[] = [];
    const log: number[] = [];
    for (let i = 1; i < amount; i++) {
      uni.push((near + (far - near) * (i / amount)) / far);
      log.push((near * (far / near) ** (i / amount)) / far);
    }
    uni.push(1);
    log.push(1);
    const lambda = 0.8;
    for (let i = 0; i < amount; i++) target.push(THREE.MathUtils.lerp(uni[i], log[i], lambda));
  };
  const makeCsm = () => {
    const high = state.tier === "high";
    sun.shadow.mapSize.set(high ? 4096 : 2048, high ? 4096 : 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    const node = new CSMShadowNode(sun, {
      cascades: high ? 4 : 3,
      maxFar: high ? 300 : 200,
      mode: "custom",
      customSplitsCallback: lambdaSplit,
    });
    return node;
  };

  const setMode = (mode: Mode) => {
    state.mode = mode;
    if (csm && mode !== "csm") {
      csm.dispose();
      csm = null;
    }
    if (mode === "csm" && !csm) csm = makeCsm();
    sundial.setEnabled(mode === "sundial");
    sun.castShadow = mode !== "off";
    (sun.shadow as unknown as { shadowNode: unknown }).shadowNode = mode === "csm" ? csm : sundialShadowNode;
    renderer.shadowMap.enabled = true;
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === mode);
    });
  };

  // ---- UI -------------------------------------------------------------------
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
        (sun.shadow as unknown as { shadowNode: unknown }).shadowNode = csm;
      }
    }),
  );
  setMode(state.mode);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
    csm?.updateFrustums();
  });

  const hud = document.getElementById("stats")!;
  let frameMs = 16;
  let t = startT;
  let lastTime = performance.now();
  const errors: string[] = [];
  (window as unknown as Record<string, unknown>).__errors = errors;
  (renderer.backend as unknown as { device: GPUDevice }).device.addEventListener("uncapturederror", (e) =>
    errors.push((e as GPUUncapturedErrorEvent).error.message),
  );

  const summary = sundial.core.contentSummary;
  const samples: { frame: number[]; mark: number[]; paging: number[]; raster: number[]; rendered: number[]; dynamic: number[]; csm: number[] } =
    { frame: [], mark: [], paging: [], raster: [], rendered: [], dynamic: [], csm: [] };
  let sampling = false;
  let lastStatsFrame = -1;

  const statLine = () => {
    const s = sundial.core.stats;
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
        `static cache  ${sundial.core.staticCache ? `${s.dynamicPages} dynamic · ${s.dynamicDeferred} deferred · ${s.compositedPages} composited` : "off"}`,
        `pairs         ${s.opaquePairs} opaque · ${s.alphaPairs} alpha · ${s.dynamicPairs} dynamic`,
        `level refresh ${s.levelRefreshes} (last L${s.lastRefreshedLevel})`,
        `clip distances ${sundial.core.useClipDistances ? "yes" : "no (discard)"}`,
      );
    } else if (state.mode === "csm") {
      lines.push(`shadow GPU    n/a (three's CSM exposes no per-pass timing)`);
    }
    lines.push(
      ``,
      `content       ${summary.triangles.toLocaleString()} tris · ${summary.instances} instances`,
      `              ${summary.clusters} clusters · ${summary.clusterInstances.toLocaleString()} cluster instances`,
    );
    hud.textContent = lines.join("\n");
  };
  setInterval(statLine, 250);

  const stat = (a: number[]) => {
    if (!a.length) return null;
    const b = [...a].sort((x, y) => x - y);
    return { median: b[Math.floor(b.length / 2)], p95: b[Math.floor(b.length * 0.95)], n: b.length };
  };
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const bench = async (ms: number) => {
    for (const k of Object.keys(samples) as (keyof typeof samples)[]) samples[k] = [];
    sampling = true;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    sampling = false;
    // Throughput, not per-frame deltas: with vsync off, deltas are bimodal.
    const measuredFrameMs = (performance.now() - t0) / Math.max(1, samples.frame.length);
    const st = sundial.core.stats;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const snapshot = {
      size: `${Math.round(size.x)}x${Math.round(size.y)}`,
      dpr: devicePixelRatio,
      requested: st.requestedPages,
      resident: st.residentPages,
      activeMeshes: renderer.info.render.drawCalls ?? 0,
      effects: renderer.info.memory.programs ?? 0,
      samples: samples.frame.length,
    };
    return {
      snapshot,
      frame: { median: measuredFrameMs, p95: measuredFrameMs, n: samples.frame.length },
      mark: stat(samples.mark),
      paging: stat(samples.paging),
      raster: stat(samples.raster),
      rendered: stat(samples.rendered),
      dynamic: stat(samples.dynamic),
      renderedMean: mean(samples.rendered),
      dynamicMean: mean(samples.dynamic),
      rasterMean: mean(samples.raster),
      rasterMax: samples.raster.length ? Math.max(...samples.raster) : null,
      csmShadow: stat(samples.csm), // three's CSM exposes no GPU pass timing (see the report)
    };
  };

  const engine = {
    get _adapterInfo() {
      return (renderer.backend as unknown as { device?: GPUDevice & { adapterInfo?: unknown } }).device?.adapterInfo ?? null;
    },
  };
  (window as unknown as Record<string, unknown>).sundial = {
    bench,
    sundial,
    scene,
    renderer,
    state,
    setMode,
    stats: () => sundial.core.stats,
    engine,
  };

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    frameMs = frameMs * 0.95 + (dt * 1000) * 0.05;
    if (state.animate) t = Math.min(stopAt, t + dt);
    for (const m of world.movers) m.update(t);
    for (const c of skinned.characters) c.update(skinT ?? t);
    state.azimuth = (state.azimuth + state.sunSpeed * dt + 360) % 360;
    setSun();
    controls.update();
    renderer.render(scene, camera);

    if (sampling) {
      samples.frame.push(dt * 1000);
      const s = sundial.core.stats;
      if (state.mode === "sundial" && s.frame !== lastStatsFrame && s.gpuComputeMs !== null) {
        lastStatsFrame = s.frame;
        samples.mark.push(s.gpuMarkMs ?? 0);
        samples.paging.push(s.gpuComputeMs);
        samples.raster.push(s.gpuRasterMs ?? 0);
        samples.rendered.push(s.renderedPages);
        samples.dynamic.push(s.dynamicPages);
      }
    }
    (window as unknown as Record<string, unknown>).__ready = true;
  });
}

main().catch((e) => {
  console.error(e);
  document.getElementById("hud")!.textContent = String(e?.stack ?? e);
});
