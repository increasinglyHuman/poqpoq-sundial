import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { pass } from "three/tsl";
import { SundialThree } from "../three";

// Minimal three.js scene for the adapter: ground, a row of boxes, a spinning
// dynamic caster, and an InstancedMesh of posts. ?sundial=0 starts with
// shadows off.

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("view") as HTMLCanvasElement;
const stats = document.getElementById("stats")!;

const renderer = new THREE.WebGPURenderer({ canvas, antialias: params.get("aa") === "1", reversedDepthBuffer: params.get("reversed") === "1" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb8d0);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 600);
const cam = (params.get("cam") ?? "18,16,26,0,1,0").split(",").map(Number);
camera.position.set(cam[0], cam[1], cam[2]);
const controls = new OrbitControls(camera, canvas);
controls.target.set(cam[3], cam[4], cam[5]);
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
if (params.get("spinner") !== "0") scene.add(spinner);

const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.2, 3, 12), new THREE.MeshStandardMaterial({ color: 0x6b5a4a }), 40);
const m = new THREE.Matrix4();
for (let i = 0; i < 40; i++) {
  const a = (i / 40) * Math.PI * 2;
  posts.setMatrixAt(i, m.makeTranslation(Math.cos(a) * 16, 1.5, Math.sin(a) * 16));
}
posts.castShadow = posts.receiveShadow = true;
scene.add(posts);

// An alpha-tested card: concentric rings, so its shadow must show the rings, not a square.
const maskCanvas = document.createElement("canvas");
maskCanvas.width = maskCanvas.height = 256;
const mctx = maskCanvas.getContext("2d")!;
for (let r = 120; r > 0; r -= 20) {
  mctx.fillStyle = "rgb(90,160,70)";
  mctx.globalCompositeOperation = (r / 20) % 2 ? "source-over" : "destination-out";
  mctx.beginPath();
  mctx.arc(128, 128, r, 0, Math.PI * 2);
  mctx.fill();
}
const card = new THREE.Mesh(
  new THREE.PlaneGeometry(6, 6),
  new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(maskCanvas), alphaTest: 0.5, side: THREE.DoubleSide }),
);
card.position.set(-8, 5, 8);
card.rotation.x = -0.9;
card.castShadow = card.receiveShadow = true;
scene.add(card);

// A skinned column (two bones) bound away from the origin, so bindMatrix is not
// identity; the upper bone bends over time. Its shadow must bend with it.
const colGeo = new THREE.BoxGeometry(1, 6, 1, 1, 12, 1).translate(0, 3, 0);
const skinIndex: number[] = [];
const skinWeight: number[] = [];
const cp = colGeo.getAttribute("position");
for (let i = 0; i < cp.count; i++) {
  const w = THREE.MathUtils.clamp((cp.getY(i) - 2) / 2, 0, 1);
  skinIndex.push(0, 1, 0, 0);
  skinWeight.push(1 - w, w, 0, 0);
}
colGeo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
colGeo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
const root = new THREE.Bone();
const upper = new THREE.Bone();
upper.position.y = 3;
root.add(upper);
const column = new THREE.SkinnedMesh(colGeo, new THREE.MeshStandardMaterial({ color: 0xc97a7a }));
column.position.set(10, 0, 8);
column.rotation.y = 0.6;
column.add(root);
column.updateMatrixWorld(true);
column.bind(new THREE.Skeleton([root, upper]));
column.castShadow = column.receiveShadow = true;
scene.add(column);

if (!SundialThree.isSupported(renderer)) {
  stats.textContent = "WebGPU not available: Sundial needs WebGPURenderer on WebGPU.";
  throw new Error("no WebGPU");
}
const sundial = new SundialThree(renderer, scene, camera, sun, { sceneMin: [-60, -1, -60], sceneMax: [60, 20, 60] });
sundial.setCasters([...boxes, { mesh: spinner, options: { dynamic: true } }, posts, card, { mesh: column, options: { dynamic: true } }]);
if (params.get("mode") === "three") {
  // Reference: three's own shadow map for the sun, no Sundial.
  renderer.shadowMap.enabled = true;
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 150 });
  sun.shadow.camera.updateProjectionMatrix();
} else sundial.start();
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

// ?post=1: render through three's post-processing (a scene pass into its own
// target, then a vignette-free passthrough), so marking must find that target's depth.
const post = params.get("post") === "1" ? new THREE.RenderPipeline(renderer, pass(scene, camera)) : null;

let frames = 0;
let last = performance.now();
renderer.setAnimationLoop((time) => {
  spinner.rotation.set(time * 0.0007, time * 0.0011, 0);
  spinner.position.x = 4 + Math.sin(time * 0.0005) * 6;
  upper.rotation.z = params.get("bend") ? Number(params.get("bend")) : Math.sin(time * 0.0012) * 1.1;
  controls.update();
  if (post) post.render();
  else renderer.render(scene, camera);
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
