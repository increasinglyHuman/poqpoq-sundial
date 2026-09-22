import "@babylonjs/core";
import { Engine, WebGPUEngine, Scene, FreeCamera, DirectionalLight, HemisphericLight, MeshBuilder, StandardMaterial, Vector3, Color3 } from "@babylonjs/core";
import { SundialBabylon } from "@poqpoq/sundial/babylon";
const r = (window.__result = { imported: true });
try {
  const canvas = document.getElementById("c");
  const gpu = new URLSearchParams(location.search).get("engine") === "webgpu";
  let engine;
  if (gpu) { engine = new WebGPUEngine(canvas, { enableAllFeatures: true, setMaximumLimits: true }); await engine.initAsync(); }
  else engine = new Engine(canvas, true);
  r.backend = gpu ? "webgpu" : "webgl2";
  r.supported = SundialBabylon.isSupported(engine);
  const scene = new Scene(engine);
  const cam = new FreeCamera("c", new Vector3(0, 14, -18), scene); cam.setTarget(Vector3.Zero());
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.3), scene); sun.intensity = 1.2;
  new HemisphericLight("sky", new Vector3(0, 1, 0), scene).intensity = 0.3;
  const mat = new StandardMaterial("m", scene); mat.diffuseColor = new Color3(0.8, 0.8, 0.8);
  const ground = MeshBuilder.CreateGround("g", { width: 40, height: 40, subdivisions: 4 }, scene); ground.material = mat; ground.receiveShadows = true;
  const box = MeshBuilder.CreateBox("b", { size: 3 }, scene); box.position.y = 3; box.material = mat;
  if (r.supported) {
    const sd = new SundialBabylon(scene, sun, { sceneMin: [-20, -1, -20], sceneMax: [20, 10, 20], levels: 5 });
    sd.addCaster(ground); sd.addCaster(box); sd.addReceivers([mat]); sd.start();
    r.core = () => sd.core.stats;
  }
  engine.runRenderLoop(() => scene.render());
  await scene.whenReadyAsync();
} catch (e) { r.error = String(e); }
window.__ready = true;
