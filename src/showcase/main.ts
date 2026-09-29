import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { SundialThree } from "../three";
import { buildWorld, heightAt, SIM } from "./world";
import { buildVillage } from "./village";
import { GradientSky } from "./sky";

// The public showcase (demo/index.html): a procedural 256 m world (a forest
// of alpha-tested leaf cards, a cobbled village, a windmill, a cart) with a
// sky, a day cycle and an A/B switch between Sundial, three.js's own
// CSMShadowNode and no shadows.
//
// URL parameters (for links and screenshots): ?mode=sundial|csm|off,
// ?view=forest|village|detail|overview, ?t=0..1 (time of day), ?play=1,
// ?levels=1, ?still=1 (freeze the movers), ?cam=x,z,up,tx,tz,tup (a free view), ?ui=0 (hide the overlay), ?dpr=<pixel ratio>, ?nowebgpu=1
// (show the no-WebGPU fallback).

type Mode = "sundial" | "csm" | "off";
type ViewName = "forest" | "village" | "detail" | "overview";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && !Number.isNaN(Number(q.get(k))) ? Number(q.get(k)) : d);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const errors: string[] = [];
(window as unknown as Record<string, unknown>).__errors = errors;

// Minimal-example link: the built site puts this page at the root, next to examples/.
if (import.meta.env.DEV) document.querySelector<HTMLAnchorElement>(".example-link")!.href = "/examples/three-basic/";
if (q.get("ui") === "0") document.querySelectorAll<HTMLElement>(".card, .credit").forEach((el) => (el.style.display = "none"));

/** A point `up` metres above the terrain at (x, z). */
const G = (x: number, z: number, up: number) => new THREE.Vector3(x, heightAt(x, z) + up, z);

// ---- views -------------------------------------------------------------------
const VIEWS: Record<ViewName, { pos: THREE.Vector3; target: THREE.Vector3 }> = {
  forest: { pos: G(-88, -4.5, 2.0), target: G(-66, 4.5, 1.2) },
  village: { pos: G(-30, -1, 4.2), target: G(-6, 3, 1.5) },
  detail: { pos: G(-14.6, 2.2, 1.6), target: G(-20, 7, 1.4) },
  overview: { pos: new THREE.Vector3(-44, 24, 40), target: new THREE.Vector3(4, 2, -8) },
};

// ---- time of day ---------------------------------------------------------------
// t in [0, 1] runs 06:00 -> 20:00: the sun rises in the east-north-east,
// peaks at ELEVATION_MAX and sets in the west-north-west.
const ELEVATION_MAX = 52;
const T_MIN = 0.03;
const T_MAX = 0.97;
const sunAt = (t: number) => ({
  azimuth: 70 + 220 * t,
  elevation: Math.max(3, ELEVATION_MAX * Math.sin(Math.PI * t)),
});
const clockOf = (t: number) => {
  const minutes = Math.round((6 + 14 * t) * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

const state = {
  mode: (["sundial", "csm", "off"].includes(q.get("mode") ?? "") ? q.get("mode") : "sundial") as Mode,
  t: Math.min(T_MAX, Math.max(T_MIN, num("t", 0.76))),
  playing: q.get("play") === "1",
  levels: q.get("levels") === "1",
};

function showFallback(reason: string) {
  document.body.classList.add("no-webgpu");
  $("fallback").hidden = false;
  $("view").style.display = "none";
  console.info(`Sundial showcase: ${reason}`);
  (window as unknown as Record<string, unknown>).__ready = true;
}

async function main() {
  if (q.get("nowebgpu") === "1") return showFallback("fallback forced by ?nowebgpu=1");
  if (!navigator.gpu) return showFallback("navigator.gpu is not available");

  const canvas = $<HTMLCanvasElement>("view");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  let pixelRatio = num("dpr", Math.min(devicePixelRatio, 1.5));
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
  await renderer.init();
  if (!SundialThree.isSupported(renderer)) {
    // No WebGPU adapter: three fell back to WebGL2, where Sundial does not run.
    renderer.dispose();
    return showFallback("no WebGPU adapter (three.js fell back to WebGL2)");
  }
  const device = (renderer.backend as unknown as { device: GPUDevice }).device;
  device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num("exposure", 0.72);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xbcd0e6, 0.0019);

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1200);
  let startView = VIEWS[(q.get("view") as ViewName) ?? "forest"] ?? VIEWS.forest;
  // ?cam=x,z,up,tx,tz,tup: a free view, in world numbers, heights above the terrain.
  const cam = q.get("cam")?.split(",").map(Number);
  if (cam?.length === 6) startView = { pos: G(cam[0], cam[1], cam[2]), target: G(cam[3], cam[4], cam[5]) };
  camera.position.copy(startView.pos);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(startView.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.2;
  controls.maxDistance = 320;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  // ---- sky and light ---------------------------------------------------------
  const sky = new GradientSky();
  sky.scale.setScalar(1000);
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4535, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2e0, 3);
  scene.add(sun, sun.target);

  const warm = new THREE.Color(1.0, 0.62, 0.36);
  const white = new THREE.Color(1.0, 0.95, 0.88);
  const zenithLow = new THREE.Color(0.2, 0.28, 0.5);
  const zenithHigh = new THREE.Color(0.14, 0.32, 0.7);
  const horizonLow = new THREE.Color(0.95, 0.68, 0.48);
  const horizonHigh = new THREE.Color(0.56, 0.68, 0.86);
  const toSun = new THREE.Vector3();
  const smooth = (a: number, b: number, x: number) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  const applySun = () => {
    const { azimuth, elevation } = sunAt(state.t);
    const az = THREE.MathUtils.degToRad(azimuth);
    const el = THREE.MathUtils.degToRad(elevation);
    toSun.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    sun.position.copy(toSun).multiplyScalar(200);
    sun.target.position.set(0, 0, 0);
    sky.sunDirection.value.copy(toSun);
    const day = smooth(4, 30, elevation);
    sun.color.copy(warm).lerp(white, day);
    sun.intensity = 3.2 * smooth(0, 8, elevation);
    hemi.intensity = 0.8 + 0.8 * smooth(0, 35, elevation);
    sky.zenith.value.copy(zenithLow).lerp(zenithHigh, day);
    sky.horizon.value.copy(horizonLow).lerp(horizonHigh, day);
    sky.glow.value.copy(sun.color);
    (scene.fog as THREE.FogExp2).color.copy(sky.horizon.value);
    village.glass.emissiveIntensity = 1.6 * dusk();
    village.lamps.emissiveIntensity = 0.3 + 3 * dusk();
  };

  // ---- the world ---------------------------------------------------------------
  const world = buildWorld(1400);
  const village = buildVillage();
  scene.add(world.group, village.group);
  for (const m of [world.terrain, world.trunks, world.leaves, ...village.statics, village.cobbles, ...village.dynamics]) m.castShadow = true;
  const dusk = () => 1 - smooth(1, 12, sunAt(state.t).elevation);
  applySun();

  // ---- Sundial ------------------------------------------------------------------
  const sundial = new SundialThree(renderer, scene, camera, sun, {
    sceneMin: [-SIM / 2, -12, -SIM / 2],
    sceneMax: [SIM / 2, 40, SIM / 2],
    levels: 7,
    pagesPerSide: 16,
    pageSize: 128,
    poolSize: 4096,
    finestPageWorldSize: 1,
  });
  // The leaf cards' mask is the canvas their texture was drawn from.
  sundial.setAlphaMask(0, world.leafMask, 0.5);
  sundial.addCaster(world.terrain);
  sundial.addCaster(world.trunks);
  sundial.addCaster(world.leaves, { alphaLayer: 0, alphaCutoff: 0.5 });
  for (const m of village.statics) sundial.addCaster(m);
  sundial.addCaster(village.cobbles);
  for (const m of village.dynamics) sundial.addCaster(m, { dynamic: true });

  // ---- avatars: the hook for walking characters -------------------------------------
  // Rigged characters (a GLB's SkinnedMeshes, say) go here. Registered as
  // dynamic casters, a SkinnedMesh casts its current pose, skinned on the GPU
  // each frame. Nothing is spawned by default.
  const avatars: THREE.Object3D[] = [];
  const spawnAvatar = (root: THREE.Object3D, update?: (t: number) => void) => {
    scene.add(root);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.receiveShadow = true;
      sundial.addCaster(mesh, { dynamic: true });
    });
    avatars.push(root);
    if (update) avatarUpdates.push(update);
    return root;
  };
  const avatarUpdates: ((t: number) => void)[] = [];

  sundial.core.tuning.debugMode = state.levels ? 1 : 0;
  sundial.start();
  // SundialThree installs its node as sun.shadow.shadowNode in start(); the
  // A/B switch swaps that reference with CSMShadowNode's.
  const shadow = sun.shadow as unknown as { shadowNode: unknown };
  const sundialNode = shadow.shadowNode;

  // ---- three.js CSM, for the A/B ------------------------------------------------
  // The lab's medium tier, as benchmarked in the README: three cascades of
  // 2048² over 200 m, split with lambda = 0.8 (the practical split scheme).
  let csm: CSMShadowNode | null = null;
  const lambdaSplit = (amount: number, near: number, far: number, target: number[]) => {
    for (let i = 1; i <= amount; i++) {
      const uni = i === amount ? 1 : (near + (far - near) * (i / amount)) / far;
      const log = i === amount ? 1 : (near * (far / near) ** (i / amount)) / far;
      target.push(THREE.MathUtils.lerp(uni, log, 0.8));
    }
  };
  const makeCsm = () => {
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    return new CSMShadowNode(sun, { cascades: 3, maxFar: 200, mode: "custom", customSplitsCallback: lambdaSplit });
  };

  const levelsToggle = $("levels").parentElement!;
  const setMode = (mode: Mode) => {
    state.mode = mode;
    if (csm && mode !== "csm") {
      csm.dispose();
      csm = null;
    }
    if (mode === "csm" && !csm) csm = makeCsm();
    sundial.setEnabled(mode === "sundial");
    sun.castShadow = mode !== "off";
    shadow.shadowNode = mode === "csm" ? csm : sundialNode;
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    levelsToggle.classList.toggle("disabled", mode !== "sundial");
    $("pagesStat").classList.toggle("hidden", mode !== "sundial");
  };

  // ---- camera moves ---------------------------------------------------------------
  let flight: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; start: number; dur: number; lift: number } | null = null;
  const markView = (name: string | null) => {
    document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  };
  const goTo = (name: ViewName, instant = false) => {
    const v = VIEWS[name];
    markView(name);
    if (instant) {
      flight = null;
      camera.position.copy(v.pos);
      controls.target.copy(v.target);
      controls.update();
      return;
    }
    const dist = camera.position.distanceTo(v.pos);
    flight = {
      p0: camera.position.clone(),
      t0: controls.target.clone(),
      p1: v.pos.clone(),
      t1: v.target.clone(),
      start: performance.now(),
      dur: THREE.MathUtils.clamp(900 + dist * 9, 1100, 2600),
      lift: Math.min(40, dist * 0.18),
    };
  };
  controls.addEventListener("start", () => {
    flight = null;
    markView(null);
  });
  const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
  const stepFlight = (now: number) => {
    if (!flight) return;
    const k = Math.min(1, (now - flight.start) / flight.dur);
    const e = ease(k);
    camera.position.lerpVectors(flight.p0, flight.p1, e);
    camera.position.y += Math.sin(Math.PI * e) * flight.lift;
    controls.target.lerpVectors(flight.t0, flight.t1, e);
    if (k >= 1) flight = null;
  };
  markView(q.get("view") ?? "forest");

  // ---- UI ------------------------------------------------------------------------
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as Mode)));
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", () => goTo(b.dataset.view as ViewName)));
  const levels = $<HTMLInputElement>("levels");
  levels.checked = state.levels;
  levels.addEventListener("change", () => {
    state.levels = levels.checked;
    sundial.core.tuning.debugMode = state.levels ? 1 : 0;
  });
  const slider = $<HTMLInputElement>("time");
  slider.min = String(T_MIN);
  slider.max = String(T_MAX);
  const clock = $("clock");
  const showTime = () => {
    slider.value = String(state.t);
    clock.textContent = clockOf(state.t);
  };
  slider.addEventListener("input", () => {
    state.t = Number(slider.value);
    clock.textContent = clockOf(state.t);
    applySun();
  });
  const play = $("play");
  const setPlaying = (on: boolean) => {
    state.playing = on;
    play.setAttribute("aria-pressed", String(on));
  };
  play.addEventListener("click", () => setPlaying(!state.playing));
  setPlaying(state.playing);
  showTime();
  setMode(state.mode);

  const info = (device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo;
  const VENDORS: Record<string, string> = { nvidia: "NVIDIA", amd: "AMD", intel: "Intel", apple: "Apple", qualcomm: "Qualcomm", arm: "Arm" };
  // "xe-lpg" -> "Xe-LPG", "blackwell" -> "Blackwell"
  const arch = (a: string) => a.split("-").map((p, i) => (i > 0 && p.length <= 3 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))).join("-");
  $("gpu").textContent = info
    ? info.description || [VENDORS[info.vendor] ?? info.vendor, info.architecture && arch(info.architecture)].filter(Boolean).join(" ") || "WebGPU"
    : "WebGPU";

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
    csm?.updateFrustums();
  });

  // ---- frame loop ----------------------------------------------------------------
  const fpsEl = $("fps");
  const msEl = $("ms");
  const pagesEl = $("pages");
  let frameMs = 16.7;
  let last = performance.now();
  let clockT = 0;
  // Adaptive resolution: if the first seconds run slow at a pixel ratio above
  // 1, drop to 1 once (integrated GPUs on high-DPI laptop screens).
  const adapt = { from: last + 2500, frames: 0, done: q.has("dpr") || pixelRatio <= 1 };
  setInterval(() => {
    fpsEl.textContent = (1000 / frameMs).toFixed(0);
    msEl.textContent = frameMs.toFixed(1);
    pagesEl.textContent = sundial.core.stats.residentPages.toLocaleString();
  }, 250);

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frameMs += (dt * 1000 - frameMs) * 0.05;
    if (!adapt.done && now > adapt.from) {
      if (++adapt.frames === 90) {
        adapt.done = true;
        const ms = (now - adapt.from) / adapt.frames;
        if (ms > 22) {
          pixelRatio = 1;
          renderer.setPixelRatio(1);
          renderer.setSize(innerWidth, innerHeight, false);
        }
      }
    }

    if (q.get("still") !== "1") clockT += dt;
    for (const m of village.movers) m.update(clockT);
    for (const u of avatarUpdates) u(clockT);
    if (state.playing) {
      state.t += dt / 45; // a day in 45 s
      if (state.t > T_MAX) state.t = T_MIN;
      showTime();
      applySun();
    }
    stepFlight(now);
    controls.update();
    // Keep the camera above the ground.
    const floor = heightAt(camera.position.x, camera.position.z) + 0.5;
    if (camera.position.y < floor) camera.position.y = floor;
    renderer.render(scene, camera);
    (window as unknown as Record<string, unknown>).__ready = true;
  });

  (window as unknown as Record<string, unknown>).showcase = {
    renderer, scene, camera, controls, sundial, state, setMode, goTo, avatars, spawnAvatar,
    triangles: village.triangles,
    houses: village.houses,
    setTime: (t: number) => { state.t = t; showTime(); applySun(); },
    get pixelRatio() { return pixelRatio; },
    get frameMs() { return frameMs; },
    adapter: info ? { vendor: info.vendor, architecture: info.architecture, description: info.description } : null,
  };
}

main().catch((e) => {
  console.error(e);
  errors.push(String(e?.message ?? e));
  $("gpu").textContent = `Error: ${e?.message ?? e}`;
  $("gpu").classList.add("error");
});
