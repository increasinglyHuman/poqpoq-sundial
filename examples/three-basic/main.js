// Sundial with three.js: the smallest complete setup.
// In your own project:  npm install @poqpoq/sundial three
// and import from "@poqpoq/sundial/three". This file imports the adapter from
// the repository's source so it runs under the repo's dev server.
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SundialThree } from "../../src/three/index.ts"; // users: "@poqpoq/sundial/three"

// 1. A WebGPURenderer. Sundial needs its WebGPU backend, so wait for init().
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c4e0);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
camera.position.set(9, 6, 11);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

// 2. Light: a hemisphere fill and the sun (a DirectionalLight).
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x4a4535, 1.2));
const sun = new THREE.DirectionalLight(0xfff1dd, 3);
sun.position.set(-20, 30, 12);
scene.add(sun);

// 3. Content, marked the usual three.js way (castShadow / receiveShadow).
const add = (mesh) => {
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
};
add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x7f9a58 })));
const stone = new THREE.MeshStandardMaterial({ color: 0xd8cbb0 });
for (const [x, z, h] of [[-3, -2, 2], [2.5, -3, 3.5], [-1, 3, 1.2]]) {
  add(new THREE.Mesh(new THREE.BoxGeometry(1.6, h, 1.6), stone)).position.set(x, h / 2, z);
}

// An alpha-tested leaf card: Sundial reads the cut-out from the material's map
// (alphaTest > 0), so the shadow has the leaves' holes in it.
const leafCanvas = document.createElement("canvas");
leafCanvas.width = leafCanvas.height = 128;
const g = leafCanvas.getContext("2d");
g.fillStyle = "#4f8a35";
for (let i = 0; i < 40; i++) {
  g.beginPath();
  g.ellipse(Math.random() * 128, Math.random() * 128, 10, 4, Math.random() * Math.PI, 0, Math.PI * 2);
  g.fill();
}
const leafMap = new THREE.CanvasTexture(leafCanvas);
leafMap.colorSpace = THREE.SRGBColorSpace;
const leaves = new THREE.MeshStandardMaterial({ map: leafMap, alphaTest: 0.5, side: THREE.DoubleSide });
add(new THREE.Mesh(new THREE.PlaneGeometry(4, 4), leaves)).position.set(1, 3.2, 1.5);

// Something that moves.
const mover = add(new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 96, 12), new THREE.MeshStandardMaterial({ color: 0xc8553d })));

// 4. Shadows: Sundial on WebGPU, three's own shadow map anywhere else.
if (SundialThree.isSupported(renderer)) {
  const sundial = new SundialThree(renderer, scene, camera, sun, {
    sceneMin: [-30, -1, -30], // the box the sun's shadows cover, in world units
    sceneMax: [30, 10, 30],
  });
  for (const entry of SundialThree.castersIn(scene)) {
    // castersIn() returns every visible mesh with castShadow, as static
    // casters. Static casters are drawn once and kept; mark the ones that move.
    const mesh = entry.mesh ?? entry;
    sundial.addCaster(mesh, { dynamic: mesh === mover });
  }
  sundial.start(); // receivers need nothing: receiveShadow works as usual
} else {
  // WebGL2 fallback: three's regular shadow map.
  renderer.shadowMap.enabled = true;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15 });
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop((ms) => {
  const t = ms / 1000;
  mover.position.set(Math.cos(t * 0.6) * 5.5, 1.6, Math.sin(t * 0.6) * 5.5);
  mover.rotation.set(t, t * 0.7, 0);
  renderer.render(scene, camera);
  window.__ready = true;
});
