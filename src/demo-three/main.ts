import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SundialThree } from "../three";

// Minimal three.js scene for the adapter: ground, a row of boxes, a spinning
// dynamic caster, and an InstancedMesh of posts. ?sundial=0 starts with
// shadows off.

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("view") as HTMLCanvasElement;
const stats = document.getElementById("stats")!;

const renderer = new THREE.WebGPURenderer({ canvas, antialias: params.get("aa") === "1" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb8d0);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 600);
camera.position.set(18, 16, 26);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);
controls.update();

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a4a38, 0.8));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
sun.position.set(-30, 50, 20);
scene.add(sun, sun.target);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120, 16, 16).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a9a6a }));
ground.receiveShadow = true;
scene.add(ground);

const boxMat = new THREE.MeshStandardMaterial({ color: 0xc9a27a });
const boxes: THREE.Mesh[] = [];
for (let i = 0; i < 6; i++) {
  const h = 1 + i;
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, h, 2), boxMat);
  box.position.set(-10 + i * 4, h / 2, -2);
  box.castShadow = box.receiveShadow = true;
  scene.add(box);
  boxes.push(box);
}

const spinner = new THREE.Mesh(new THREE.TorusKnotGeometry(1.6, 0.5, 128, 16), new THREE.MeshStandardMaterial({ color: 0x7aa2c9 }));
spinner.position.set(4, 4, 6);
spinner.castShadow = spinner.receiveShadow = true;
scene.add(spinner);

const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.2, 3, 12), new THREE.MeshStandardMaterial({ color: 0x6b5a4a }), 40);
const m = new THREE.Matrix4();
for (let i = 0; i < 40; i++) {
  const a = (i / 40) * Math.PI * 2;
  posts.setMatrixAt(i, m.makeTranslation(Math.cos(a) * 16, 1.5, Math.sin(a) * 16));
}
posts.castShadow = posts.receiveShadow = true;
scene.add(posts);

if (!SundialThree.isSupported(renderer)) {
  stats.textContent = "WebGPU not available: Sundial needs WebGPURenderer on WebGPU.";
  throw new Error("no WebGPU");
}
const sundial = new SundialThree(renderer, scene, camera, sun, { sceneMin: [-60, -1, -60], sceneMax: [60, 20, 60] });
sundial.setCasters([...boxes, { mesh: spinner, options: { dynamic: true } }, posts]);
sundial.start();
if (params.get("sundial") === "0") sundial.setEnabled(false);
if (params.get("debug") === "1") sundial.core.tuning.debugMode = 1;

const toggle = document.getElementById("toggle")!;
toggle.className = sundial.enabled ? "on" : "";
toggle.onclick = () => {
  sundial.setEnabled(!sundial.enabled);
  toggle.className = sundial.enabled ? "on" : "";
};
const debug = document.getElementById("debug")!;
debug.onclick = () => {
  sundial.core.tuning.debugMode = sundial.core.tuning.debugMode ? 0 : 1;
  debug.className = sundial.core.tuning.debugMode ? "on" : "";
};

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

const w = window as unknown as Record<string, unknown>;
w.sundial = sundial;
w.renderer = renderer;
w.scene = scene;
w.camera = camera;
const errors: string[] = [];
w.__errors = errors;
(renderer.backend as unknown as { device: GPUDevice }).device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));

let frames = 0;
let last = performance.now();
renderer.setAnimationLoop((time) => {
  spinner.rotation.set(time * 0.0007, time * 0.0011, 0);
  spinner.position.x = 4 + Math.sin(time * 0.0005) * 6;
  controls.update();
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - last > 500) {
    const s = sundial.core.stats;
    stats.textContent = `${((now - last) / frames).toFixed(2)} ms/frame\n` + (s ? `pages ${s.residentPages ?? "?"} resident, ${s.requestedPages ?? "?"} requested` : "");
    frames = 0;
    last = now;
    w.__ready = true;
  }
});
