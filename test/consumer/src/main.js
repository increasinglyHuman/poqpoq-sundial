import "@babylonjs/core";
import { Engine, WebGPUEngine, Scene, FreeCamera, DirectionalLight, HemisphericLight, MeshBuilder, StandardMaterial, MultiMaterial, SubMesh, Vector3, Color3 } from "@babylonjs/core";
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
    // A prim-like box: faces 0-2 draw, faces 3-5 are hidden (null MultiMaterial
    // slot). Only its 6 visible triangles may cast.
    const prim = MeshBuilder.CreateBox("p", { size: 2 }, scene); prim.position.set(6, 1, 0);
    const multi = new MultiMaterial("mm", scene); multi.subMaterials.push(mat, null); prim.material = multi;
    prim.subMeshes = [];
    new SubMesh(0, 0, prim.getTotalVertices(), 0, 18, prim);
    new SubMesh(1, 0, prim.getTotalVertices(), 18, 18, prim);
    sd.addCaster(ground); sd.addCaster(box); sd.addCaster(prim); sd.addReceivers([mat]); sd.start();
    r.core = () => sd.core.stats;
    r.firstBuild = sd.core.contentSummary;
    const gpuErrors = (r.gpuErrors = []);
    engine._device.addEventListener("uncapturederror", (e) => gpuErrors.push(String(e.error?.message ?? e)));
    // Rebuild while frames are in flight: every geometry should come from the cache.
    setTimeout(() => { sd.setCasters([ground, box, { mesh: prim }]); r.rebuild = sd.core.contentSummary; }, 500);
  }
  engine.runRenderLoop(() => scene.render());
  await scene.whenReadyAsync();
} catch (e) { r.error = String(e); }
window.__ready = true;
