import * as THREE from "three/webgpu";
import { SundialThree } from "@poqpoq/sundial/three";

// Consumer test for the three.js adapter, structured like test/consumer's
// Babylon page: one script, driven by ?engine=/&flag=1 query params, that
// builds a scene, runs a battery of checks and leaves window.__result for
// probe.mjs to read. Rendering is fully manual (no setAnimationLoop): every
// step calls renderer.render() once and awaits the GPU work it submitted, so
// frame timing never drifts and luma reads are deterministic.

const params = new URLSearchParams(location.search);
const engineParam = params.get("engine") || "webgpu";
const forceWebGL = engineParam === "webgl";
const aa = params.get("aa") === "1";
const tonemapOff = params.get("tonemap") === "0";
const bare = params.get("nofeat") === "1";
const reversed = params.get("reversed") === "1";

const r = (window.__result = { imported: true, variant: engineParam + (aa ? "&aa=1" : "") + (tonemapOff ? "&tonemap=0" : "") + (bare ? "&nofeat=1" : "") + (reversed ? "&reversed=1" : "") });

const SCENE_MIN = [-20, -1, -20];
const SCENE_MAX = [20, 10, 20];

const canvas = document.getElementById("c");
canvas.width = 640;
canvas.height = 480;

try {
  // ---- renderer -------------------------------------------------------------
  let renderer;
  if (bare) {
    // ?nofeat=1: a device with no optional features, unlike three's own default
    // (which requests every adapter-supported feature). The Babylon page builds
    // this by passing {} instead of {enableAllFeatures:true}; three's renderer
    // always asks for everything unless we hand it our own bare device.
    const adapter = await navigator.gpu.requestAdapter();
    const device = adapter ? await adapter.requestDevice({ requiredFeatures: [], requiredLimits: {} }) : null;
    renderer = new THREE.WebGPURenderer(device ? { canvas, device } : { canvas, forceWebGL: true });
  } else {
    renderer = new THREE.WebGPURenderer({ canvas, antialias: aa, forceWebGL, reversedDepthBuffer: reversed });
  }
  await renderer.init();
  r.backend = forceWebGL || (bare && !SundialThree.isSupported(renderer)) ? "webgl" : "webgpu";
  r.supported = SundialThree.isSupported(renderer);

  const gpuErrors = (r.gpuErrors = []);
  if (renderer.backend?.device) {
    renderer.backend.device.addEventListener("uncapturederror", (e) => gpuErrors.push(String(e.error?.message ?? e)));
  }

  if (!r.supported) {
    // webgl (and a hard failure to get a bare device): the import must not
    // throw and isSupported() must say no. Nothing else to check.
    r.done = true;
  } else {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x27354a);
    const camera = new THREE.PerspectiveCamera(50, 640 / 480, 0.5, 300);

    // A near-top-down framing on a chosen ground patch: with the wide
    // establishing shot Babylon's Camera used, a caster's shadow only ever
    // covers a sliver of the frame and every luma delta gets diluted by the
    // sky and by ground far from any caster (measured a few percent even for
    // "darkness 1 hides every shadow"). Looking straight down instead fills
    // the frame with the ground patch that actually matters.
    function aimTopDown(cx, cz, half) {
      const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
      const h = half / Math.tan(halfFov);
      camera.position.set(cx, h, cz);
      // Looking straight down with the default up=(0,1,0) is the classic
      // lookAt roll singularity (forward and up nearly anti-parallel): the
      // resulting "screen right" direction is ill-defined and can end up
      // mirrored frame to frame, which is exactly what made a caster's
      // shadow show up on the wrong side of a split reading. Pick an up
      // vector that is NOT close to
      // parallel with "straight down" so the orientation is deterministic:
      // forward=(0,-1,0), up=(0,0,-1) gives screen-right = world +X.
      camera.up.set(0, 0, -1);
      camera.lookAt(cx, 0, cz);
      camera.updateMatrixWorld();
    }
    aimTopDown(0, -2, 16);

    // Grazing sun (~25 deg elevation): shadows are long enough to read
    // clearly in a top-down shot instead of pooling under their casters.
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(26, 14, -16);
    sun.target.position.set(0, 0, 0);
    scene.add(sun, sun.target);
    // Low intensity: a shadow only darkens the DIRECT light from `sun` (and
    // the native shadow test's `other`), never this ambient fill, so a
    // strong fill would wash out every luma-based shadow check below.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.12));

    const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 4, 4).rotateX(-Math.PI / 2), mat);
    ground.receiveShadow = true;
    scene.add(ground);

    const box = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), mat);
    box.position.set(0, 1.5, 0);
    scene.add(box);

    // A prim-like box: three faces draw (materialIndex 0-2, all the SAME
    // material so they merge into one casting run), three are hidden via a
    // null material slot (BoxGeometry pre-groups its 6 faces by index).
    // Only its 6 visible triangles may cast — mirrors the Babylon
    // MultiMaterial-null-slot check.
    const prim = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), [mat, mat, mat, null, null, null]);
    prim.position.set(6, 1, 0);
    scene.add(prim);

    // Alpha-tested leaf: a CanvasTexture whose top-left quadrant alone is
    // opaque, read as `map` (alpha channel). Casts opaque until its mask is
    // read (autoAlpha), then casts through the alpha pipeline.
    const leafTex = quadrantTexture("alpha");
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x33cc55, map: leafTex, alphaTest: 0.5 });
    const leaf = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), leafMat);
    leaf.position.set(-6, 2, 0);
    leaf.rotation.x = Math.PI / 2; // flat, facing up
    scene.add(leaf);

    // ---- Sundial ----------------------------------------------------------
    const sundial = new SundialThree(renderer, scene, camera, sun, { sceneMin: SCENE_MIN, sceneMax: SCENE_MAX, levels: 5 });
    r.core = () => sundial.core.stats;

    // Render target for deterministic readback: an explicit off-screen
    // target (UnsignedByteType, 0-255) sidesteps any canvas-presentation
    // timing question and gives page marking a plain depthTexture to read
    // (the aa=1 / tonemap=0 checks render to the canvas on purpose instead,
    // since those variants are specifically about the canvas depth path).
    const RTW = 640, RTH = 480;
    const target = new THREE.RenderTarget(RTW, RTH);

    async function renderFrame(toCanvas = false) {
      renderer.setRenderTarget(toCanvas ? null : target);
      renderer.render(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    async function renderFrames(n) { for (let i = 0; i < n; i++) await renderFrame(); }
    async function meanLuma() {
      const px = await renderer.readRenderTargetPixelsAsync(target, 0, 0, RTW, RTH);
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      return sum / (px.length / 4) / 3 / 255;
    }

    setCasters();
    sundial.start();

    function setCasters(extra = []) {
      sundial.setCasters([ground, box, { mesh: prim }, leaf, ...extra]);
    }
    /** Hides box/prim/leaf so an isolated check's frame isn't diluted by them. */
    function hideExtras() { box.visible = prim.visible = leaf.visible = false; }
    function showExtras() { box.visible = prim.visible = leaf.visible = true; }

    if (aa || tonemapOff || bare || reversed) {
      // ---- targeted variant smoke checks ----------------------------------
      // These variants are about one specific renderer configuration, not the
      // full battery below (which runs once, unconditionally, on plain
      // ?engine=webgpu). Each still proves Sundial actually pages content and
      // raises no GPU errors under that configuration.
      if (tonemapOff) {
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      }
      const toCanvas = aa || tonemapOff || reversed; // exercise the real canvas depth path, not the off-screen target
      for (let i = 0; i < 30; i++) {
        renderer.setRenderTarget(toCanvas ? null : target);
        renderer.render(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      r.smoke = {
        requestedPages: sundial.core.stats.requestedPages,
        residentPages: sundial.core.stats.residentPages,
        allocationFailures: sundial.core.stats.allocationFailures,
        frame: sundial.core.stats.frame,
      };
      r.done = true;
    } else {
      // ================= full battery (plain ?engine=webgpu) =================
      r.firstBuild = sundial.core.contentSummary;

      // Wait for the leaf's alpha mask to be read and the automatic internal
      // rebuild that follows (ALPHA_SETTLE_MS inside the adapter), rendering
      // frames throughout so update() gets to run.
      const alphaDeadline = performance.now() + 4000;
      while (sundial.core.contentSummary.alphaClusters === 0 && performance.now() < alphaDeadline) {
        await renderFrame();
        await new Promise((res) => setTimeout(res, 30));
      }
      r.rebuild = sundial.core.contentSummary;

      // A no-op setCasters() call should hit the geometry cache for every
      // registered geometry (the shared core's content-hash cache, distinct
      // from Babylon's per-mesh registration memo, which this adapter has none
      // of — see the "memo" note below).
      setCasters();
      r.rebuildCache = sundial.core.contentSummary;

      // Tight crop on just the box and its shadow: at the wide default
      // framing the box's shadow is a sliver of the frame and a full
      // darkness/enabled toggle barely moves the global mean.
      aimTopDown(-2.8, 1.7, 5); // centered between the box and where its grazing shadow lands (sun casts toward -X,+Z)
      await renderFrames(20);
      r.lumaDark0 = await meanLuma();
      sundial.setDarkness(1);
      await renderFrames(5);
      r.lumaDark1 = await meanLuma();
      sundial.setDarkness(0);
      await renderFrames(10);

      // setEnabled(false) brightens the frame (no shadow at all); back on
      // restores the exact same picture (deterministic scene, no drift).
      const lumaEnabledBefore = await meanLuma();
      sundial.setEnabled(false);
      await renderFrames(5);
      r.lumaEnabledOff = await meanLuma();
      sundial.setEnabled(true);
      await renderFrames(10);
      r.lumaEnabledBack = await meanLuma();
      r.lumaEnabledBefore = lumaEnabledBefore;
      aimTopDown(0, -2, 16);

      // A material.clone() of a receiving material must still receive: the
      // shadow node lives on the light, so any material built after it (or
      // cloned from one) picks it up automatically. Verified by luma: a new
      // plane using the clone, under the box's shadow, must be as dark as an
      // identical plane using the original material would be.
      {
        hideExtras();
        const clone = mat.clone();
        const cloneGround = new THREE.Mesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), clone);
        cloneGround.position.set(-3, 0.02, 9);
        cloneGround.receiveShadow = true;
        scene.add(cloneGround);
        // A caster right above it so the clone's patch is unambiguously shadowed.
        const cloneCaster = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), mat);
        cloneCaster.position.set(0, 3, 6);
        scene.add(cloneCaster);
        setCasters([cloneCaster]);
        aimTopDown(-5.5, 9.5, 9); // centered between the caster and where its grazing shadow lands (sun casts toward -X,+Z)
        await renderFrames(20);
        const lumaShadowed = await meanLuma();
        cloneCaster.visible = false;
        setCasters([]); // drop the extra caster; re-render so its shadow clears
        await renderFrames(20);
        const lumaUnshadowed = await meanLuma();
        cloneCaster.visible = true;
        setCasters([cloneCaster]);
        r.clone = { ok: true, lumaShadowed, lumaUnshadowed, receives: lumaShadowed < lumaUnshadowed - 0.05 };
        scene.remove(cloneCaster, cloneGround);
        aimTopDown(0, -2, 16);
        showExtras();
        setCasters();
        await renderFrames(10);
      }

      // Two boxes differing by fractions of a unit are two distinct geometries.
      {
        const before = sundial.core.contentSummary.geometries;
        const small = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat);
        small.position.set(-6, 0.3, -6);
        const unit = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        unit.position.set(-8, 0.5, -6);
        scene.add(small, unit);
        setCasters([small, unit]);
        await renderFrames(5);
        r.distinct = { added: sundial.core.contentSummary.geometries - before };
        scene.remove(small, unit);
        setCasters();
        await renderFrames(10);
      }

      // Rebuilds re-render only what changed. Cropped tight on where the
      // added box actually lands, for the same reason as the darkness check.
      aimTopDown(1, -3, 6);
      await renderFrames(20);
      r.lumaBase = await meanLuma();
      setCasters();
      await renderFrames(20);
      r.rebuildSame = { ...sundial.core.contentSummary.lastBuild, luma: await meanLuma() };
      const extraBox = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), mat);
      extraBox.position.set(3, 2.5, -4);
      scene.add(extraBox);
      setCasters([extraBox]);
      await renderFrames(20);
      r.rebuildAdd = { ...sundial.core.contentSummary.lastBuild, luma: await meanLuma() };
      scene.remove(extraBox);
      setCasters();
      await renderFrames(20);
      r.rebuildRemove = { ...sundial.core.contentSummary.lastBuild, luma: await meanLuma() };
      aimTopDown(0, -2, 16);

      // Registration "memo": the three adapter has none (register() always
      // re-reads geometry from scratch; there is no per-mesh skip-if-unchanged
      // cache the way SundialBabylon's verifyRegistrationMemo/registrationStats
      // work). Nothing to port; noted instead of silently dropped.
      r.memo = { skipped: true, reason: "SundialThree.register() has no per-mesh memo (no verifyRegistrationMemo/registrationStats equivalent); always re-reads geometry." };

      // updateCaster(mesh): move a registered STATIC caster without a rebuild.
      // Read per-spot (see the dynamic-caster check below for why): a shared
      // wide shot has to stay clear of the grazing shadow's ~7.4-unit tail
      // off whichever spot is "far" (toward -X), which dilutes the near
      // spot's delta below the noise floor.
      {
        hideExtras();
        const SPOT_A = [-9, -4], SPOT_B = [9, -4];
        const spotFrame = ([x, z]) => aimTopDown(x - 3.7, z + 2.3, 6);
        const posts = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), mat);
        posts.position.set(SPOT_A[0], 2, SPOT_A[1]);
        posts.layers.set(1); // hidden from the camera's default layer 0
        scene.add(posts);
        setCasters([posts]);
        await renderFrames(15);
        spotFrame(SPOT_A); await renderFrames(10);
        const postsA0 = await meanLuma();
        spotFrame(SPOT_B); await renderFrames(10);
        const postsB0 = await meanLuma();

        const calls = { box: 0, all: 0 };
        const box0 = sundial.core.invalidateRange.bind(sundial.core);
        const all0 = sundial.core.invalidateAll.bind(sundial.core);
        sundial.core.invalidateRange = (...a) => { calls.box++; box0(...a); };
        sundial.core.invalidateAll = () => { calls.all++; all0(); };
        const buildsBefore = sundial.core.contentSummary.builds;

        posts.position.set(SPOT_B[0], 2, SPOT_B[1]);
        posts.updateWorldMatrix(true, false);
        const accepted = sundial.updateCaster(posts);
        const movedCalls = { ...calls };
        await renderFrames(15);
        spotFrame(SPOT_A); await renderFrames(10);
        const postsA1 = await meanLuma();
        spotFrame(SPOT_B); await renderFrames(10);
        const postsB1 = await meanLuma();
        const rebuilt = sundial.core.contentSummary.builds !== buildsBefore;
        sundial.core.invalidateRange = box0;
        sundial.core.invalidateAll = all0;

        const stranger = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        const refusedUnregistered = sundial.updateCaster(stranger) === false;

        // A count change is refused: bump the InstancedMesh-style count check
        // by re-using `posts` after an internal rebuild changed its group's
        // slot count is not applicable to a plain Mesh (always 1 slot), so the
        // refusal case is covered instead by an InstancedMesh below.

        posts.position.set(SPOT_A[0], 2, SPOT_A[1]);
        posts.updateWorldMatrix(true, false);
        sundial.updateCaster(posts);
        await renderFrames(15);
        spotFrame(SPOT_A); await renderFrames(10);
        const postsA2 = await meanLuma();
        spotFrame(SPOT_B); await renderFrames(10);
        const postsB2 = await meanLuma();
        r.moveApi = {
          accepted, calls: movedCalls, rebuilt, refusedUnregistered,
          // shadowed A, lit B; then lit A, shadowed B; then back to shadowed A, lit B
          postsA0, postsB0, postsA1, postsB1, postsA2, postsB2,
        };
        scene.remove(posts);
        aimTopDown(0, -2, 16);
        showExtras();
        setCasters();
        await renderFrames(10);
      }

      // The min/max early-out changes no pixel, off or back on (core-level,
      // shared by both adapters).
      {
        await renderFrames(10);
        const on = await snapshot();
        sundial.core.tuning.minMaxEarlyOut = false;
        await renderFrames(20);
        const off = await snapshot();
        sundial.core.tuning.minMaxEarlyOut = true;
        await renderFrames(30);
        r.minMax = { diffOff: diffSnapshots(on, off), diffBack: diffSnapshots(on, await snapshot()) };
      }

      // Requests are per frame: empty sky requests fewer pages than the
      // ground, and looking back brings the count back up.
      {
        // A low, oblique view of the ground, as the Babylon test uses: close
        // ground wants fine pages. (From the top-down framing, 38 m up, the
        // whole patch needs fewer pages than the always-resident coarsest level.)
        const pos = camera.position.clone();
        const oblique = () => { camera.position.set(0, 3, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(); };
        oblique();
        await renderFrames(20);
        r.requestedGround = sundial.core.stats.requestedPages;
        camera.position.set(0, 1, -2);
        camera.lookAt(0, 50, -2); // straight up: empty sky, no caster or receiver in view
        camera.updateMatrixWorld();
        await renderFrames(20);
        r.requestedSky = sundial.core.stats.requestedPages;
        oblique();
        await renderFrames(20);
        r.requestedBack = sundial.core.stats.requestedPages;
        camera.position.copy(pos);
        aimTopDown(0, -2, 16);
        await renderFrames(10);
      }

      // A receiver past the depth range reads lit, not shadowed: the range is
      // a padded sphere around sceneMin/sceneMax, so a plane far below and
      // outside the ground's footprint sits deeper than it, with no caster
      // over it.
      {
        const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), mat);
        sea.position.y = -50;
        sea.receiveShadow = true;
        scene.add(sea);
        const pos = camera.position.clone();
        camera.position.set(-45, -30, 45);
        camera.lookAt(-45.5, -50, 45.5);
        camera.updateMatrixWorld();
        await renderFrames(30);
        const shadowed = await meanLuma();
        sundial.setDarkness(1);
        await renderFrames(5);
        r.farReceiver = { shadowed, lit: await meanLuma() };
        sundial.setDarkness(0);
        camera.position.copy(pos);
        aimTopDown(0, -2, 16);
        scene.remove(sea);
        await renderFrames(20);
      }

      // A receiveShadow=false mesh is unaffected by darkness. three's own
      // node-lighting model gates applying light.shadow.shadowNode on
      // object.receiveShadow (AnalyticLightNode), independent of Sundial's
      // material-level receiveMaterial option, so this should just work.
      {
        // Everything else out of view, so the mean can only move because of
        // this one plane — otherwise "unaffected" could pass trivially just
        // because nothing shadow-relevant is in frame at all.
        ground.visible = box.visible = prim.visible = leaf.visible = false;
        const noReceive = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), mat.clone());
        noReceive.position.set(-8, 0.02, 4);
        noReceive.receiveShadow = false; // default, set explicitly for clarity
        scene.add(noReceive);
        const overhead = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), mat);
        overhead.position.set(-8, 2.5, 4);
        scene.add(overhead);
        setCasters([overhead]);
        const pos = camera.position.clone();
        aimTopDown(-12.5, 6.8, 7); // centered between the caster and where its grazing shadow lands (sun casts toward -X,+Z)
        await renderFrames(20);
        const before = await meanLuma();
        sundial.setDarkness(1);
        await renderFrames(5);
        const after = await meanLuma();
        sundial.setDarkness(0);
        await renderFrames(5);
        // Control: the SAME plane and framing, but receiving — proves darkness
        // actually moves this shot's mean when a receiver is willing to show it.
        noReceive.receiveShadow = true;
        await renderFrames(10);
        const controlBefore = await meanLuma();
        sundial.setDarkness(1);
        await renderFrames(5);
        const controlAfter = await meanLuma();
        sundial.setDarkness(0);
        noReceive.receiveShadow = false;
        r.receiveShadowFalse = {
          before, after, unaffected: Math.abs(after - before) < 0.01,
          controlBefore, controlAfter, controlMoved: controlAfter > controlBefore + 0.05,
        };
        camera.position.copy(pos);
        aimTopDown(0, -2, 16);
        ground.visible = box.visible = prim.visible = leaf.visible = true;
        scene.remove(noReceive, overhead);
        setCasters();
        await renderFrames(10);
      }

      // A second DirectionalLight with three's OWN shadow map still works
      // alongside Sundial: three's own shadow pipeline is untouched by
      // Sundial (which only ever installs a shadowNode on its own light), so
      // toggling ONLY `other.castShadow` (never its intensity, which would
      // also change the scene's overall brightness and confound the luma
      // comparison) must darken the frame under its caster regardless of
      // whether Sundial is enabled.
      {
        hideExtras(); // isolate: only the ground receives, only otherCaster casts
        const other = new THREE.DirectionalLight(0xffffff, 2);
        other.position.set(-8, 20, 10);
        other.target.position.set(0, 0, 0);
        other.castShadow = true;
        other.shadow.mapSize.set(1024, 1024);
        const cam2 = other.shadow.camera;
        cam2.left = -20; cam2.right = 20; cam2.top = 20; cam2.bottom = -20; cam2.near = 1; cam2.far = 60;
        scene.add(other, other.target);
        const otherCaster = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
        otherCaster.position.set(0, 1, 4);
        otherCaster.castShadow = true;
        scene.add(otherCaster);
        setCasters([otherCaster]);
        aimTopDown(0, 4, 6);
        await renderFrames(20);
        r.otherLight = { both: await meanLuma() };
        sundial.setEnabled(false);
        await renderFrames(10);
        r.otherLight.otherOnly = await meanLuma();
        other.castShadow = false; // same intensity, just no shadow: the "no shadow" baseline
        await renderFrames(10);
        r.otherLight.noShadow = await meanLuma();
        other.castShadow = true;
        sundial.setEnabled(true);
        await renderFrames(10);
        scene.remove(other, other.target, otherCaster);
        aimTopDown(0, -2, 16);
        showExtras();
        setCasters();
        await renderFrames(10);
      }

      // A moving dynamic caster's shadow follows it, moved three ways. Hidden
      // from the camera; only its shadow changes what's under it. Checked by
      // looking at spot A and spot B SEPARATELY (each its own tight top-down
      // crop) rather than splitting one wide shot in half: a shared wide shot
      // has to be wide enough to avoid clipping the ~7.4-unit grazing-shadow
      // tail off whichever spot is "far" (toward -X), which dilutes the
      // halves-delta of the "near" spot below the noise floor. Cropping on
      // each spot individually keeps both signals strong regardless of which
      // one currently holds the caster.
      {
        hideExtras();
        const SPOT_A = [-9, -8], SPOT_B = [9, -8];
        // Centered between each spot and where its shadow actually lands
        // (sun casts toward -X,+Z; see the calibration diagnostic above).
        const spotFrame = ([x, z]) => aimTopDown(x - 3.7, z + 2.3, 6);
        const base = () => sundial.setCasters([ground]);
        base();
        spotFrame(SPOT_A);
        await renderFrames(10);
        const cleanA = await meanLuma();
        spotFrame(SPOT_B);
        await renderFrames(10);
        const cleanB = await meanLuma();
        const at = async () => {
          spotFrame(SPOT_A);
          await renderFrames(15);
          const a = await meanLuma();
          spotFrame(SPOT_B);
          await renderFrames(15);
          const b = await meanLuma();
          const darkA = a < cleanA - 0.04, darkB = b < cleanB - 0.04;
          return darkA && !darkB ? "A" : darkB && !darkA ? "B" : "?";
        };

        const rig = new THREE.Object3D();
        scene.add(rig);
        const dyn = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), mat);
        dyn.visible = false;
        rig.add(dyn);
        dyn.position.set(SPOT_A[0], 2, SPOT_A[1]);
        sundial.setCasters([ground, { mesh: dyn, options: { dynamic: true } }]);
        await renderFrames(10);
        const atA = await at();
        rig.position.x = SPOT_B[0] - SPOT_A[0];
        await renderFrames(10);
        const viaParent = await at();
        dyn.position.x = SPOT_A[0] - rig.position.x; // world x back to SPOT_A through the parent's offset
        await renderFrames(10);
        const viaPosition = await at();
        base();
        scene.remove(rig);
        await renderFrames(5);

        const im = new THREE.InstancedMesh(new THREE.BoxGeometry(4, 4, 4), mat, 1);
        im.visible = false;
        const m4 = new THREE.Matrix4().makeTranslation(SPOT_A[0], 2, SPOT_A[1]);
        im.setMatrixAt(0, m4);
        im.instanceMatrix.needsUpdate = true;
        scene.add(im);
        sundial.setCasters([ground, { mesh: im, options: { dynamic: true } }]);
        await renderFrames(10);
        const instA = await at();
        m4.makeTranslation(SPOT_B[0], 2, SPOT_B[1]);
        im.setMatrixAt(0, m4);
        im.instanceMatrix.needsUpdate = true;
        await renderFrames(10);
        const instB = await at();
        base();
        scene.remove(im);
        await renderFrames(5);

        r.dynamicFollow = { atA, viaParent, viaPosition, instA, instB };
        aimTopDown(0, -2, 16);
        showExtras();
        setCasters();
        await renderFrames(10);
      }

      // A dynamic SkinnedMesh casts its posed shadow: two bones, a tall thin
      // box weighted along its height, the child bone (top half) rotated.
      {
        hideExtras();
        const { mesh: skinned, childBone } = makeSkinnedBox();
        skinned.position.set(9, 0, -6); // safely inside sceneMin/Max, not at the ground's edge
        skinned.visible = false; // only its shadow matters
        scene.add(skinned);
        sundial.setCasters([ground, { mesh: skinned, options: { dynamic: true } }]);
        aimTopDown(0, -2, 16);
        await renderFrames(20);
        // A rigid vertical-to-horizontal swing redistributes the shadow
        // (a tall rod's long grazing shadow vs. a low wing's shorter, wider
        // one) more than it changes its TOTAL area, so a whole-frame mean
        // barely moves even though the picture clearly did. Diffing the two
        // frames directly catches that redistribution regardless of shape.
        const restShot = await snapshot();
        childBone.rotation.z = Math.PI / 2.05; // swing the top half hard sideways, nearly flat
        await renderFrames(20);
        const posedShot = await snapshot();
        let changed = 0;
        for (let i = 0; i < restShot.length; i += 4) if (Math.abs(posedShot[i] - restShot[i]) > 6) changed++;
        r.skinned = { changed, moved: changed > 500 };
        childBone.rotation.z = 0;
        scene.remove(skinned);
        showExtras();
        setCasters();
        await renderFrames(10);
      }

      // alphaMap variant: three reads coverage from the GREEN channel when a
      // material has no `map` but does have an `alphaMap`.
      {
        const before = sundial.core.contentSummary.alphaClusters;
        const greenTex = quadrantTexture("green");
        const gMat = new THREE.MeshStandardMaterial({ color: 0x33cc55, alphaMap: greenTex, alphaTest: 0.5 });
        const gLeaf = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), gMat);
        gLeaf.position.set(-10, 2, 4);
        gLeaf.rotation.x = Math.PI / 2;
        scene.add(gLeaf);
        sundial.setCasters([ground, box, { mesh: prim }, leaf, gLeaf]);
        const deadline = performance.now() + 4000;
        while (sundial.core.contentSummary.alphaClusters <= before && performance.now() < deadline) {
          await renderFrame();
          await new Promise((res) => setTimeout(res, 30));
        }
        r.alphaMapLeaf = { before, after: sundial.core.contentSummary.alphaClusters, grew: sundial.core.contentSummary.alphaClusters > before };
        scene.remove(gLeaf);
        sundial.setCasters([ground, box, { mesh: prim }, leaf]);
        await renderFrames(10);
      }

      // updateCaster refusal on a count change: an InstancedMesh registered
      // statically, then its count grown without re-registering.
      {
        const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, 2);
        im.count = 1;
        im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-14, 0.5, 14));
        im.instanceMatrix.needsUpdate = true;
        im.layers.set(1);
        scene.add(im);
        sundial.setCasters([ground, box, { mesh: prim }, leaf, im]);
        await renderFrames(10);
        im.count = 2; // grew past the registered slot without re-registering
        im.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-10, 0.5, 14));
        im.instanceMatrix.needsUpdate = true;
        r.updateCasterRefusesCountChange = sundial.updateCaster(im) === false;
        scene.remove(im);
        sundial.setCasters([ground, box, { mesh: prim }, leaf]);
        await renderFrames(10);
      }

      // CSM min() combo: not implemented in the three adapter (no combine
      // option, no second-shadow min blending) — nothing to port.
      r.csmMinCombo = { skipped: true, reason: "SundialThree has no CSM-combine (min()) option to test; see the two-DirectionalLights check for the equivalent 'a second shadow still works alongside' coverage." };

      // dispose(): restores the light (no shadowNode left behind) and a new
      // instance on the same scene works. Run LAST and in its own scope: it
      // tears down `sundial`, so nothing above may depend on it afterward.
      {
        // The frame the first instance shades at this view: the second must match it.
        await renderFrames(10);
        const lumaFirst = await meanLuma();
        sundial.dispose();
        const shadow = sun.shadow;
        r.dispose = { noShadowNode: !shadow.shadowNode, castShadowOff: sun.castShadow === false };
        mat.needsUpdate = true;
        leafMat.needsUpdate = true;
        await renderFrames(10);
        const sundial2 = new SundialThree(renderer, scene, camera, sun, { sceneMin: SCENE_MIN, sceneMax: SCENE_MAX, levels: 5 });
        sundial2.setCasters([ground, box, { mesh: prim }, leaf]);
        sundial2.start();
        // Every material bound to a compiled pipeline that read the OLD
        // instance's shadowNode ought to recompile against the new one, but
        // even forcing that (needsUpdate) does not appear to be enough here —
        // see the report for the diagnosis (three's AnalyticLightNode caches
        // shadowColorNode per light across materials, keyed independently of
        // Material.needsUpdate) and the resulting "used in submit while
        // destroyed" GPU errors.
        mat.needsUpdate = true;
        leafMat.needsUpdate = true;
        await renderFrames(20);
        r.second = { requested: sundial2.core.stats.requestedPages, lumaFirst };
        r.second.luma0 = await meanLuma();
        sundial2.setDarkness(1);
        await renderFrames(5);
        r.second.luma1 = await meanLuma();
        sundial2.setDarkness(0);
        await renderFrames(10);
      }

      r.core = () => sundial.core.stats;
      r.done = true;
    }

    // ---- shared helpers (closures over `renderer`, `target`) ----------------
    async function snapshot() {
      return renderer.readRenderTargetPixelsAsync(target, 0, 0, RTW, RTH);
    }
    function diffSnapshots(a, b) {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    }
  }
} catch (e) {
  r.error = String(e && e.stack ? e.stack : e);
  r.done = true;
}
window.__ready = true;

/** A 64x64 CanvasTexture whose top-left quadrant alone carries coverage. */
function quadrantTexture(mode) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (mode === "alpha") {
    // RGBA: green everywhere, alpha only in the top-left quadrant (map + alphaTest).
    ctx.fillStyle = "rgba(50,200,80,0)";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "rgba(50,200,80,255)";
    ctx.fillRect(0, 0, 32, 32);
  } else {
    // alphaMap reads the GREEN channel: opaque-black background, green only
    // in the top-left quadrant; alpha itself is left at full everywhere.
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "rgb(0,255,0)";
    ctx.fillRect(0, 0, 32, 32);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Two bones, a tall box weighted along its height, ready to pose. */
function makeSkinnedBox() {
  const geometry = new THREE.BoxGeometry(5, 6, 5, 1, 8, 1);
  geometry.translate(0, 3, 0); // base at y=0, tip at y=6
  const position = geometry.attributes.position;
  const skinIndex = [];
  const skinWeight = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const w = Math.min(1, Math.max(0, v.y / 6));
    skinIndex.push(0, 1, 0, 0);
    skinWeight.push(1 - w, w, 0, 0);
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));

  const rootBone = new THREE.Bone();
  const childBone = new THREE.Bone();
  childBone.position.set(0, 3, 0); // pivot at the box's midheight
  rootBone.add(childBone);

  const material = new THREE.MeshStandardMaterial({ color: 0x999999 });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(rootBone);
  const skeleton = new THREE.Skeleton([rootBone, childBone]);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  return { mesh, rootBone, childBone };
}
