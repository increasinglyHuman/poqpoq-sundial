import "@babylonjs/core";
import { Engine, WebGPUEngine, Scene, FreeCamera, DirectionalLight, HemisphericLight, MeshBuilder, StandardMaterial, MultiMaterial, SubMesh, RawTexture, Material, Constants, Vector3, Color3 } from "@babylonjs/core";
import { SundialBabylon, readCoverage } from "@poqpoq/sundial/babylon";
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
    // Alpha pattern in texture-memory order: opaque only where row < 16 and
    // column < 32 of 64. Asymmetric in both axes, so a flip or transpose shows.
    const raw = new Uint8Array(64 * 64 * 4).fill(255);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw[(y * 64 + x) * 4 + 3] = y < 16 && x < 32 ? 255 : 0;
    const tex = RawTexture.CreateRGBATexture(raw, 64, 64, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    tex.hasAlpha = true;
    // Read at half size through the render-target path; expect the same quadrants.
    const cov = await readCoverage(tex, 32);
    const at = (x, y) => cov[(y * 32 + x) * 4 + 3];
    r.orientation = { topLeft: at(4, 2), topRight: at(28, 2), bottomLeft: at(4, 28), edgeRow7: at(4, 7), row9: at(4, 9) };
    // An alpha-tested caster using that texture: casts opaque until its mask is read.
    const leafMat = new StandardMaterial("leaf", scene); leafMat.diffuseTexture = tex; leafMat.transparencyMode = Material.MATERIAL_ALPHATEST;
    leafMat.diffuseColor = new Color3(0.2, 0.8, 0.2);
    leafMat.useAlphaFromDiffuseTexture = true; // so the leaf renders cut out too (World's MASK rule)
    const leaf = MeshBuilder.CreatePlane("leaf", { size: 4 }, scene); leaf.position.set(-6, 2, 0); leaf.rotation.x = Math.PI / 2; leaf.material = leafMat; // flat, facing up: its shadow shows on the ground
    sd.addCaster(ground); sd.addCaster(box); sd.addCaster(prim); sd.addCaster(leaf); sd.addReceivers([mat]); sd.start();
    r.core = () => sd.core.stats;
    r.firstBuild = sd.core.contentSummary;
    const gpuErrors = (r.gpuErrors = []);
    engine._device.addEventListener("uncapturederror", (e) => gpuErrors.push(String(e.error?.message ?? e)));
    // Rebuild while frames are in flight: every geometry should come from the cache.
    setTimeout(() => { sd.setCasters([ground, box, { mesh: prim }, leaf]); r.rebuild = sd.core.contentSummary; }, 1200);
  }
  engine.runRenderLoop(() => scene.render());
  await scene.whenReadyAsync();
} catch (e) { r.error = String(e); }
window.__ready = true;
