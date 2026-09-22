import "@babylonjs/core";
// Loaded up front: the shadow generator imports these lazily, which this harness's Vite cannot serve.
import "@babylonjs/core/ShadersWGSL/shadowMap.fragment.js";
import "@babylonjs/core/ShadersWGSL/shadowMap.vertex.js";
import { Engine, WebGPUEngine, Scene, FreeCamera, DirectionalLight, HemisphericLight, MeshBuilder, StandardMaterial, MultiMaterial, SubMesh, RawTexture, Material, Constants, Matrix, ImageProcessingPostProcess, PBRMaterial, MaterialPluginBase, ShadowGenerator, Vector3, Color3 } from "@babylonjs/core";
import { SundialBabylon, readCoverage } from "@poqpoq/sundial/babylon";
const r = (window.__result = { imported: true });
try {
  const canvas = document.getElementById("c");
  const gpu = new URLSearchParams(location.search).get("engine") === "webgpu";
  let engine;
  // ?nofeat=1: a device with no optional features (no clip-distances), like an engine created with defaults.
  const bare = new URLSearchParams(location.search).get("nofeat") === "1";
  if (gpu) { engine = new WebGPUEngine(canvas, bare ? {} : { enableAllFeatures: true, setMaximumLimits: true }); await engine.initAsync(); }
  else engine = new Engine(canvas, true);
  r.backend = gpu ? "webgpu" : "webgl2";
  r.supported = SundialBabylon.isSupported(engine);
  const scene = new Scene(engine);
  const cam = new FreeCamera("c", new Vector3(0, 14, -18), scene); cam.setTarget(Vector3.Zero());
  // ?pp=1: the camera renders through a post-process, as World's world camera does (image processing
  // into an HDR target), so its depth is the post-process target's, not Babylon's main depth buffer.
  if (new URLSearchParams(location.search).get("pp") === "1") new ImageProcessingPostProcess("ip", 1.0, cam);
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.3), scene); sun.intensity = 1.2;
  new HemisphericLight("sky", new Vector3(0, 1, 0), scene).intensity = 0.3;
  const mat = new StandardMaterial("m", scene); mat.diffuseColor = new Color3(0.8, 0.8, 0.8);
  const ground = MeshBuilder.CreateGround("g", { width: 40, height: 40, subdivisions: 4 }, scene); ground.material = mat; ground.receiveShadows = true;
  let pbrGround = null;
  // ?pbr=1: the ground is PBR, with a stand-in for Babylon's atmosphere plugin (priority 600) that
  // REPLACES the sun's colour at CUSTOM_LIGHT0_COLOR, as the real one does under a physical sky.
  if (new URLSearchParams(location.search).get("pbr") === "1") {
    const pbr = new PBRMaterial("pbrGround", scene); pbr.albedoColor = new Color3(0.8, 0.8, 0.8); pbr.metallic = 0; pbr.roughness = 1;
    class SunReplacer extends MaterialPluginBase {
      constructor(m) { super(m, "SunReplacer", 600, { SUNREPLACER: true }); this._enable(true); }
      getClassName() { return "SunReplacer"; }
      isCompatible() { return true; }
      getCustomCode(type) { return type === "fragment" ? { CUSTOM_LIGHT0_COLOR: "diffuse0 = light0.vLightDiffuse;" } : null; }
    }
    new SunReplacer(pbr);
    ground.material = pbr;
    pbrGround = pbr;
  }
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
    sd.addCaster(ground); sd.addCaster(box); sd.addCaster(prim); sd.addCaster(leaf); sd.addReceivers([mat, ...(pbrGround ? [pbrGround] : [])]); sd.start();
    r.core = () => sd.core.stats;
    r.firstBuild = sd.core.contentSummary;
    const gpuErrors = (r.gpuErrors = []);
    engine._device.addEventListener("uncapturederror", (e) => gpuErrors.push(String(e.error?.message ?? e)));
    // Rebuild while frames are in flight: every geometry should come from the cache.
    const frames = (n) => new Promise((done) => { let k = 0; const o = scene.onAfterRenderObservable.add(() => { if (++k >= n) { o.remove(); done(); } }); });
    const meanLuma = async () => {
      const w = engine.getRenderWidth(), h = engine.getRenderHeight();
      const px = await engine.readPixels(0, 0, w, h);
      let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      return sum / (px.length / 4) / 3;
    };
    (async () => {
      await new Promise((done) => setTimeout(done, 1200)); // the leaf's mask is in by now
      // Rebuild while frames are in flight: every geometry should come from the cache.
      sd.setCasters([ground, box, { mesh: prim }, leaf]); r.rebuild = sd.core.contentSummary;
      // New bounds re-fit and re-render every level; the checks below run on the result.
      sd.setSceneBounds([-30, -1, -30], [30, 12, 30]);
      await frames(30);
      // Darkness 1 leaves no visible shadow, so the frame gets brighter.
      r.lumaDark0 = await meanLuma();
      sd.setDarkness(1); await frames(5);
      r.lumaDark1 = await meanLuma();
      sd.setDarkness(0);
      // ?csm=1: the box ALSO casts through a Babylon ShadowGenerator on the same light, as World's
      // avatars do under Sundial. Both at darkness 0.5: combined with min() the overlap is exactly as
      // dark as either alone, so the frame matches Sundial alone; multiplied, it would be 0.25 there.
      if (new URLSearchParams(location.search).get("csm") === "1") {
        sd.setDarkness(0.5); await frames(5);
        r.csm = { sundialOnly: await meanLuma() };
        const sg = new ShadowGenerator(2048, sun);
        sun.position = sun.direction.scale(-40);
        sg.usePercentageCloserFiltering = true;
        sg.setDarkness(0.5);
        sg.addShadowCaster(box);
        scene.shadowsEnabled = true;
        await scene.whenReadyAsync(); await frames(20);
        r.csm.both = await meanLuma();
        // Proof the Babylon shadow is live: alone (Sundial off) it darkens the frame.
        sd.setEnabled(false); await frames(10);
        r.csm.babylonOnly = await meanLuma();
        sg.setDarkness(1); await frames(5);
        r.csm.noShadow = await meanLuma();
        sd.setEnabled(true); await frames(10);
        sg.dispose(); await frames(5);
        sd.setDarkness(0);
      }
      // A material created after start() receives without being registered.
      const late = new StandardMaterial("late", scene);
      const lateGround = MeshBuilder.CreateGround("lg", { width: 6, height: 6 }, scene); lateGround.position.set(0, 0.01, 8);
      lateGround.material = late; lateGround.receiveShadows = true;
      await frames(10);
      r.late = { plugin: !!late.pluginManager?.getPlugin("Sundial"), enabled: !!lateGround.subMeshes[0].materialDefines?.PSENABLED };
      // Cloning a receiver (World's face split, media apply) must not throw, and the clone receives
      // like any new material (field 2026-09-22: "BABYLON.SundialPlugin not found" on clone).
      try {
        const copy = late.clone("late-copy");
        const copyGround = MeshBuilder.CreateGround("cg", { width: 6, height: 6 }, scene); copyGround.position.set(8, 0.01, 8);
        copyGround.material = copy; copyGround.receiveShadows = true;
        const json = late.serialize();
        await frames(10);
        r.clone = { ok: true, plugin: copy.pluginManager?.getPlugin("Sundial")?.host === sd, enabled: !!copyGround.subMeshes[0].materialDefines?.PSENABLED, serialized: !JSON.stringify(json).includes("SundialPlugin") };
      } catch (e) {
        r.clone = { ok: false, error: String(e).slice(0, 160) };
      }
      // A thin host whose live buffer is a VIEW (World's distance culling zero-scales far members):
      // registered with its real transforms via instanceMatrices, the hidden member still casts.
      {
        const pillars = MeshBuilder.CreateBox("pillars", { width: 1, height: 6, depth: 1 }, scene);
        const canon = new Float32Array(32);
        Matrix.Translation(-12, 3, 6).copyToArray(canon, 0);
        Matrix.Translation(12, 3, 6).copyToArray(canon, 16);
        const live = canon.slice();
        Matrix.Scaling(0, 0, 0).multiply(Matrix.Translation(12, 3, 6)).copyToArray(live, 16); // "culled"
        pillars.thinInstanceSetBuffer("matrix", live, 16, true);
        pillars.receiveShadows = true;
        const base = [ground, box, { mesh: prim }, leaf];
        sd.setCasters([...base, pillars]); await frames(30);
        r.instanceLive = await meanLuma();
        sd.setCasters([...base, { mesh: pillars, options: { instanceMatrices: canon } }]); await frames(30);
        r.instanceCanon = await meanLuma();
        sd.setCasters(base); pillars.dispose(); await frames(10);
        // Rebuilds re-render only what changed (the rebuild-hitch fix). Unchanged content repacks
        // nothing and re-renders nothing; one added box re-renders its own footprint and its shadow
        // appears; removing it re-renders that footprint again and the frame is exactly as before.
        await frames(20);
        r.lumaBase = await meanLuma();
        sd.setCasters(base); await frames(20);
        r.rebuildSame = { ...sd.core.contentSummary.lastBuild, luma: await meanLuma() };
        const extra = MeshBuilder.CreateBox("extra", { size: 2 }, scene); extra.position.set(4, 3, -4); extra.material = mat;
        sd.setCasters([...base, extra]); await frames(20);
        r.rebuildAdd = { ...sd.core.contentSummary.lastBuild, luma: await meanLuma() };
        sd.setCasters(base); extra.dispose(); await frames(20);
        r.rebuildRemove = { ...sd.core.contentSummary.lastBuild, luma: await meanLuma() };
      }
      // Requests are per frame (review F1, PR #9): look at empty sky and the pages the ground asked
      // for must stop being requested. If the request buffer were never cleared they would stay.
      r.requestedGround = sd.core.stats.requestedPages;
      const target = cam.getTarget().clone();
      cam.setTarget(cam.position.add(new Vector3(0, 1, 0.01)));
      await frames(20);
      r.requestedSky = sd.core.stats.requestedPages;
      cam.setTarget(target);
      await frames(20);
      r.requestedBack = sd.core.stats.requestedPages;
      // A host rebuilds its backend (World re-applies on camera swaps and vetoes): dispose, then a
      // new instance on the same scene must take over the materials' existing receivers.
      sd.dispose();
      await frames(3);
      const sd2 = new SundialBabylon(scene, sun, { sceneMin: [-20, -1, -20], sceneMax: [20, 10, 20], levels: 5 });
      sd2.addCaster(ground); sd2.addCaster(box); sd2.addReceivers([mat, late, ...(pbrGround ? [pbrGround] : [])]); sd2.start();
      await frames(30);
      r.second = {
        rebound: mat.pluginManager.getPlugin("Sundial").host === sd2 && late.pluginManager.getPlugin("Sundial").host === sd2,
        enabled: !!ground.subMeshes[0].materialDefines?.PSENABLED,
        requested: sd2.core.stats.requestedPages,
      };
      // …and actually shades: darkness 1 must brighten the frame again.
      r.second.luma0 = await meanLuma();
      sd2.setDarkness(1); await frames(5);
      r.second.luma1 = await meanLuma();
      sd2.setDarkness(0);
      // Two shapes that differ only by fractions of a unit are two geometries. MeshBuilder keeps its
      // positions as number[], and hashing those through Uint32Array truncated every coordinate, so a
      // 1 m box and a 0.6 m box (all coordinates within ±0.5) shared one key and one shadow.
      {
        const small = MeshBuilder.CreateBox("small", { size: 0.6 }, scene); small.position.set(-6, 0.3, -6);
        const unit = MeshBuilder.CreateBox("unit", { size: 1 }, scene); unit.position.set(-8, 0.5, -6);
        const before = sd2.core.contentSummary.geometries;
        sd2.setCasters([ground, box, small, unit]);
        await frames(5);
        r.distinct = { numberArrays: Array.isArray(small.getVerticesData("position")), added: sd2.core.contentSummary.geometries - before };
      }
      r.core = () => sd2.core.stats;
      r.done = true;
    })().catch((e) => { r.error = String(e); r.done = true; });
  }
  engine.runRenderLoop(() => scene.render());
  await scene.whenReadyAsync();
} catch (e) { r.error = String(e); }
window.__ready = true;
