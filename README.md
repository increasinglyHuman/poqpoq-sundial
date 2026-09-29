<p align="center"><img src="docs/images/sundial-hero.jpg" alt="poqpoq Sundial" width="420"></p>

<p align="center"><a href="https://www.npmjs.com/package/@poqpoq/sundial"><img src="https://img.shields.io/npm/v/@poqpoq/sundial" alt="npm"></a> <a href="https://github.com/increasinglyHuman/poqpoq-sundial/actions/workflows/ci.yml"><img src="https://github.com/increasinglyHuman/poqpoq-sundial/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <img src="https://img.shields.io/npm/l/@poqpoq/sundial" alt="MIT"></p>

# poqpoq Sundial — paged sun shadows for WebGPU

**For Babylon.js 9 and three.js** (r186 `WebGPURenderer`), from one package:

```ts
import { SundialBabylon } from "@poqpoq/sundial/babylon"; // Babylon.js
import { SundialThree } from "@poqpoq/sundial/three";     // three.js
```

Sundial is a virtual (paged) shadow map for one directional light, written in
TypeScript and WGSL for WebGPU. An engine-agnostic core that talks only to a
`GPUDevice` does the work; each adapter is a thin layer over it, so both
engines get the same shadows. It is the default shadow system of
[poqpoq World](https://poqpoq.com/world/) on WebGPU.

**Sharper shadows near the camera, and on integrated GPUs, a lower cost than
cascaded shadow maps.** Measured on an Intel Xe-LPG iGPU, a frame with Sundial
is 25–32% faster than Babylon's `CascadedShadowGenerator` at 3×2048², and in
three.js up to 11% faster than `CSMShadowNode` at 3×2048² (33–41% faster than
at 4×4096²). Its finest texels are 7.8 mm.

**[Live three.js demo](https://increasinglyhuman.github.io/poqpoq-sundial/)**
(needs a WebGPU browser) · get started: [Babylon.js](#using-it) ·
[three.js](#threejs) · [results](#results)

## About

### Why it exists

Cascaded shadow maps (CSM) redraw every cascade whenever the camera or the sun
moves, at a fixed resolution per cascade. On a discrete GPU that is affordable.
On the integrated GPUs many players have, the redraw and the filtering are fill
work. On poqpoq World's forest sims, vegetation shadows cost 46 ms of a 91 ms
frame on an Intel iGPU, and the watchdog had to switch shadows off for
integrated-GPU players.

Sundial is built from the other direction:

- **Draw once, keep it.** Shadow depth lives in 128×128 pages in a single
  pool. A page is rendered when the camera first needs it and is then kept.
  Static pages are never redrawn; moving casters dirty only the pages they
  cross.
- **Ask for what the screen needs.** Every frame, a compute pass reads the
  camera's depth and requests, for each visible surface, the page at the level
  whose texel size matches that surface's pixel footprint. Resolution follows
  the viewer.
- **Keep the GPU busy, not the CPU.** Marking, page management, culling and
  rasterization all run on the GPU from one ~1 KB upload per frame, with three
  indirect draws in total.
- **Cheap receivers.** Materials read the pool with `textureLoad`: no
  samplers, no writes, and they skip filtering entirely where a page's
  min/max depth shows the whole footprint fully lit or fully shadowed.

The idea comes from Unreal Engine 5's Virtual Shadow Maps and the adaptive
shadow map research before it. Sundial is a from-scratch take on it for the
web: no mesh shaders, no bindless, and no engine changes.

### Status

Version **0.3**, which adds the three.js adapter (`@poqpoq/sundial/three`).
The Babylon adapter has been running in production in poqpoq World since
September 2026, on the default path for every WebGPU visitor; WebGL2 visitors
keep CSM. The API may still change within 0.x (see
[Limits](#limits-and-known-issues)).

## Results

The lab scene is a procedural 256 m sim: 1,400 alpha-tested trees, 133k-triangle
terrain and a prim village, at 1600×900 with 4× MSAA. Each figure is the median
of 5 interleaved rounds of 3 s each (`scripts/bench.mjs`, warm-up and flush
pages, vsync off), taken 2026-09-23. The rounds agree within 0.1 ms except for
CSM HIGH on NVIDIA.

Frame time in ms (lower is better):

| | Xe-LPG village | Xe-LPG overview | Xe-LPG forest | RTX 5060 village | RTX 5060 overview | RTX 5060 forest |
|---|---|---|---|---|---|---|
| shadows off | 3.82 | 3.92 | 4.82 | 0.77 | 0.89 | 0.55 |
| CSM MEDIUM (3×2048²) | 10.50 | 9.78 | 8.80 | 3.38 | 3.01 | 2.86 |
| CSM HIGH (4×4096²) | 17.74 | 17.01 | 14.85 | 8.82 | 9.25 | 6.39 |
| **Sundial** | **7.12** | **7.30** | **6.12** | **2.13** | **2.43** | **1.53** |

What shadows cost, over the shadows-off frame:

| | Xe-LPG | RTX 5060 |
|---|---|---|
| CSM MEDIUM | 3.98–6.68 ms | 2.12–2.61 ms |
| **Sundial** | **1.30–3.38 ms** | **0.98–1.54 ms** |

In the field, on a busy poqpoq World community sim, the frame rate went from
29 fps with CSM to 41 fps with Sundial.

Most of Sundial's remaining cost is in the receivers (material shaders that
sample the shadow). Producing static shadow depth is ~0.05 ms, and page marking
is 0.03 ms on the RTX and 0.3–0.4 ms on the Xe-LPG.

**Moving casters (0.2, static cache).** Shadow raster GPU time on the RTX 5060,
median of 5 interleaved rounds, with the static cache on and off
(`?cache=0`). A moving caster now redraws only itself over its pages' cached
static depth, instead of every tree and prim under it:

| | cache on | cache off |
|---|---|---|
| village, 40 movers | 0.03 ms | 0.23 ms |
| forest, 40 movers | 0.05 ms | 0.37 ms |
| village, 8 skinned walkers | 0.07 ms | 0.25 ms |
| static scene | 0.01–0.02 ms | 0.00 ms |

**three.js (0.3).** The same scene in the three.js lab (`three.html`: three
r186 `WebGPURenderer`, 4× MSAA, 1600×900), against three's own
`CSMShadowNode` at the same cascade counts and map sizes. Median of 3
interleaved rounds of 3 s, taken 2026-09-28; the Xe-LPG was in its fast state
(shadows off 3.84 ms, the same as the Babylon lab that session).

Frame time in ms (lower is better):

| | Xe-LPG village | Xe-LPG overview | Xe-LPG forest | RTX 5060 village | RTX 5060 overview | RTX 5060 forest |
|---|---|---|---|---|---|---|
| shadows off | 3.84 | 3.96 | 3.53 | 1.08 | 1.34 | 1.00 |
| CSMShadowNode 3×2048² | 7.08 | 6.76 | 6.62 | 2.96 | 3.47 | 3.17 |
| CSMShadowNode 4×4096² | 10.77 | 9.92 | 9.98 | 8.46 | 6.57 | 7.07 |
| **Sundial** | **6.43** | **6.69** | **5.89** | **2.56** | **3.36** | **2.33** |

Sundial's own passes cost the same as under Babylon (marking 0.3–0.4 ms on
the Xe-LPG, paging and static raster ~0.04 ms). In the same session the
Babylon lab's Sundial frame was 7.11 / 7.41 / 6.24 ms on the Xe-LPG.

## Using it

```
npm install @poqpoq/sundial @babylonjs/core
```

`@poqpoq/sundial` is an ES module with type declarations: the engine-agnostic
core at `@poqpoq/sundial`, the Babylon.js adapter at `@poqpoq/sundial/babylon`
and the three.js adapter at `@poqpoq/sundial/three` (see [three.js](#threejs)).
Both engines are optional peers: install the one you use. For Babylon,
`@babylonjs/core` 9 (≥ 9.17.1); let your bundler dedupe it (Vite:
`resolve.dedupe: ["@babylonjs/core"]`) so the adapter and your app share one
Babylon runtime.

```ts
import { SundialBabylon } from "@poqpoq/sundial/babylon";

// Importing is safe on every backend. Only construct on WebGPU,
// and keep a CascadedShadowGenerator for WebGL2.
if (SundialBabylon.isSupported(engine)) {
  const sundial = new SundialBabylon(scene, sun, { sceneMin: [-128, -10, -128], sceneMax: [128, 60, 128] });
  sundial.addCaster(terrain);                                       // static
  sundial.addCaster(leaves);                                        // alpha-tested: the mask is read from its material
  sundial.addCaster(windmill, { dynamic: true });                   // re-read every frame
  sundial.addCaster(swarm, { dynamic: true, capacity: 64 });        // thin-instance count may vary up to 64
  sundial.addCaster(avatar, { dynamic: true });                     // has a skeleton: casts its skinned pose
  sundial.addReceivers(materials);                                  // meshes also need receiveShadows
  sundial.start();
}
```

- **Casters.** Static casters are uploaded once. Thin instances are supported.
  Alpha-tested materials cast through their own alpha-test texture at their
  `alphaCutOff`, like Babylon's `ShadowGenerator`; pass `alphaLayer` with
  `setAlphaMask` to supply a mask yourself. `setCasters(entries)` replaces the
  whole set; unchanged geometry is recognised and not rebuilt.
- **Dynamic casters.** `dynamic: true` casters are re-read every frame. With
  the static cache (the default, `staticCache: true`), a dynamic caster that
  moves only redraws itself: the pages it crossed get their cached static
  depth copied back and the dynamic casters drawn over it, instead of
  re-rendering every tree on them. Up to `dynamicBudget` pages (default 64,
  also `core.tuning.dynamicBudget`) are re-composed per frame; the rest fall
  back a level for a frame. The cache costs a second pool (64 MiB at the
  defaults); `staticCache: false` drops it, and a moving dynamic caster then
  re-renders the pages under its old and new bounds, as a static edit does.
- **Skinned casters.** A dynamic caster with a skeleton (and bone indices and
  weights) casts its current pose, skinned on the GPU in the caster vertex
  stage from `skeleton.getTransformMatrices(mesh)` each frame, whether or not
  the skeleton stores its matrices in a texture. Up to 8 influences (both of
  Babylon's sets) and 256 bones. The shadow's bounds come from per-bone
  radii, not from skinning vertices on the CPU. A static caster with a
  skeleton casts its bind pose, as before.
- **Moving a few static instances.** `updateCasterMatrices(mesh, matrices)`
  rewrites only the instances whose matrices changed and re-renders only the
  pages under their old and new footprints. It returns `false` if the instance
  count changed; call `setCasters` then.
- **Receivers.** `addReceivers` attaches a plugin to StandardMaterial and
  PBRMaterial (WGSL). Materials created after `start()` receive automatically;
  `receiveNewMaterials` filters that.
- **Look.** `setDarkness(d)` works like `ShadowGenerator.setDarkness`.
  `sundial.core.tuning` holds `lodBias`, `normalOffset`, `depthBias` and
  `debugMode` (1 tints each level).
- **Lifecycle.** `setEnabled(false)` turns receivers off without freeing
  anything. `setSceneBounds` handles a world that grows. `dispose()` frees
  every GPU resource.
- **Stats.** `sundial.core.stats` holds page counters (requested, resident,
  rendered, allocation failures, pairs; with the static cache also
  `dynamicPages`, `dynamicDeferred`, `compositedPages` and `dynamicPairs`,
  while `renderedPages` counts static renders), read back every `core.statsInterval`
  frames. GPU pass times need `core.profiling = true`, which costs a
  timestamp resolve every frame, so it is off by default.

A `ShadowGenerator` can share the light for casters Sundial doesn't cover
(morph targets, for instance). The receiver folds its
factor into Babylon's with `min()`, so overlapping shadows never darken twice.
Just don't give both the same casters.

**The core without Babylon.** `PagedShadowCore` takes a `GPUDevice`, geometry
(positions, indices, optional UVs and alpha layer, optional skin influences),
instance matrices (`setSkinPose` poses a skinned instance), and per
frame the eye, sun direction, and the camera's depth texture with its
inverse view-projection matrix (`reversed: true` for reversed-Z). It exports
its receiver WGSL (`COMMON_WGSL`, `RECEIVER_WGSL`) for your own materials. The
two adapters are the worked examples.

### three.js

```
npm install @poqpoq/sundial three
```

Try it first: the [live demo](https://increasinglyhuman.github.io/poqpoq-sundial/),
and a [minimal example](https://increasinglyhuman.github.io/poqpoq-sundial/examples/three-basic/)
([source](examples/three-basic/main.js)) to copy from.

three r186 (tested; the peer range also admits r187), `WebGPURenderer` on its
WebGPU backend. The receiver is
the sun's `light.shadow.shadowNode`, the hook three's own `CSMShadowNode`
uses, so every node material that receives shadows from that light (including
the classic `MeshStandardMaterial` family, which WebGPURenderer turns into node
materials) takes Sundial's shadow with no per-material setup. three renders no
shadow map of its own for that light; other lights keep theirs.

```ts
import * as THREE from "three/webgpu";
import { SundialThree } from "@poqpoq/sundial/three";

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
if (SundialThree.isSupported(renderer)) {                          // false on the WebGL2 fallback
  const sundial = new SundialThree(renderer, scene, camera, sun, { sceneMin: [-128, -10, -128], sceneMax: [128, 60, 128] });
  sundial.addCaster(terrain);                                       // static
  sundial.addCaster(leaves);                                        // InstancedMesh, alpha-tested: mask read from its material
  sundial.addCaster(windmill, { dynamic: true });                   // re-read every frame
  sundial.addCaster(avatar, { dynamic: true });                     // SkinnedMesh: casts its skinned pose
  // or: sundial.setCasters(SundialThree.castersIn(scene));         // every visible mesh with castShadow
  sundial.start();                                                  // meshes receive with receiveShadow, as usual
}
```

- **Casters** are registered explicitly, as with Babylon: a caster keeps
  casting while registered, whether or not it is in the scene or visible.
  `castersIn(root)` collects the meshes marked `castShadow`. `InstancedMesh`
  casts every instance (dynamic ones follow `count` up to `capacity`).
  Geometry groups whose material is missing or invisible do not cast.
- **Alpha-tested casters.** A material with `alphaTest > 0` casts through its
  `alphaMap` (green channel, as three reads it) or else its `map` (alpha),
  with the texture's `offset`/`repeat`/`rotation` and `flipY` applied. The
  mask is read once, from the texture's image, on the CPU; compressed
  textures cast opaque.
- **Skinned casters.** A dynamic `SkinnedMesh` casts its pose, skinned on the
  GPU from `skeleton.boneMatrices` with the mesh's `bindMatrix`. 4 influences,
  256 bones. `updateCaster(mesh)` moves a static caster without a rebuild.
- **Renderer settings.** `antialias` (multisampled depth), `reversedDepthBuffer`
  and post-processing all work: marking reads the depth of whatever target
  the camera rendered into. `setEnabled(false)` is a uniform flip, with no
  shader recompile.
- **Sharing the light with three's own shadow map.** `blendShadowMap: true`
  also shades the sun with three's standard shadow map for that light, and the
  darker of the two wins, so a caster in both never darkens twice (the same
  `min()` the Babylon adapter uses with a `ShadowGenerator`). Use it for
  casters Sundial doesn't suit, such as many animated characters: put them on
  a layer of their own, point `sun.shadow.camera.layers` at it, size the
  shadow camera as usual, and leave them out of Sundial
  (`castersIn(scene, (m) => !m.layers.isEnabled(AVATARS))`).
- `setDarkness`, `setSceneBounds`, `core.tuning`, `core.stats` and `dispose()`
  work as in the Babylon adapter.

## How it works

A clipmap of 7 levels, 16×16 pages each, 128² texels per page; level 0 is
16 m across (7.8 mm texels), and each level doubles. Pages live in one 4096²
`depth32float` pool (1,024 pages, 64 MiB), which receivers read, plus a
second one of the same layout that caches each page's static-only depth (the
static cache; another 64 MiB). Addressing is toroidal, so a walking camera
only exposes a strip of new pages.

Every frame, on the GPU, from one ~1 KB params upload:

| Pass | What |
|---|---|
| mark | compute over last frame's camera depth: each visible surface requests the page at the level whose texels match its pixel footprint |
| manage | retag scrolled slots, mark pages under moving dynamic casters stale and dirty pages under static edits, collect free / old / recent physical pages, allocate (LRU), build the static render list, then the dynamic list (stale pages) |
| cull | dynamic cluster instances × every page drawn, then static cluster instances × the static list → (cluster, page) pairs; clusters are 64-triangle Morton-ordered runs with their own bounds |
| raster | into the static pool: **one** clear draw + **one** opaque draw + **one** alpha-tested draw; into the live pool: **one** composite draw (a quad per page copying its static depth) + the same two draws for dynamic casters; all indirect. Vertex pulling places each triangle in its page's atlas rectangle, clip distances trim it to the page |

**Static cache.** A page is rendered from scratch (static casters into the
static pool) only when static content changes under it: allocation, a scroll,
a sun-band refresh, a static edit. A dynamic caster that moves queues its old
and new bounds; every valid page they touch turns *stale*: its static depth is
still good, only the dynamic part is not. Stale pages form a second list,
coarsest level first, capped by `dynamicBudget`. Every page drawn in a frame,
from either list, is composited into the live pool (depth textures cannot be
copied by sub-rectangle, so a quad per page writes `frag_depth`) and then gets
the dynamic casters that overlap it drawn over it. A walker in the forest
thus costs a copy and a capsule per page instead of 1,400 alpha-tested trees.
The min/max atlas is rebuilt for every page drawn. A stale page is not valid
(receivers fall back a level) until it is re-composed, which is the same
frame while the budget holds. With `staticCache: false` there is one pool and
a moving dynamic caster dirties its pages like a static edit.

The sun is handled per level: each level keeps the light basis it was rendered
with and re-renders only when the sun has drifted past its band
(`bandDegrees × 2^level`), one level per frame at most. A moving sun costs a
trickle of fine-level refreshes instead of a full redraw.

Receivers are injected into Standard and PBR materials at
`CUSTOM_LIGHT{k}_COLOR` (plus a per-light regex for StandardMaterial's
specular). They read the page table from a storage buffer and the pool with
`textureLoad`: **no samplers are added**, and they are strictly read-only. A
per-page min/max depth atlas lets 60–79% of receiver fragments skip PCF with
byte-identical output.

### Rulings learned the hard way (measured on Intel Xe-LPG)

1. **Receivers must not write.** A storage write in a material shader, even
   one that never executes, disables early-Z for the whole draw: +13 ms in the
   forest. Page requests come from the mark pass over camera depth instead.
2. **Alpha-test before the expensive work.** StandardMaterial with
   `transparencyMode = MATERIAL_ALPHATEST` discards at the *end* of the
   shader, after all lighting, so every transparent leaf texel paid for the
   full receiver first. Guarding the receiver on the alpha test took the
   village view from 24 to 6.8 ms.
3. **PCF without arrays.** 3×3 bilinear PCF over a 4×4 footprint collapses to
   separable weights (1−f, 1, 1, f); a dynamically indexed 4×4 array spilled on
   Intel and cost ~45 ms.
4. **Bench with flush pages.** A cold browser, or a heavy page just before,
   leaves the iGPU in a slow transient (same page measured 23.8 vs 6.8 ms).
   `bench.mjs` warms every mode and loads a cheap page before every run.

### Seams into Babylon

All quarantined in `src/babylon/SundialBabylon.ts`. Some are private Babylon
API, which is why the peer range is pinned to Babylon 9.

- `engine._device`: the core runs on Babylon's own `GPUDevice`, from its own
  command encoder, submitted before Babylon's frame. Babylon only samples the
  result, so the shadow pass sits outside any snapshot bundle by construction.
- A `createTexture` patch on that device adds `TEXTURE_BINDING` to depth
  textures, so marking can read the camera's depth. The depth comes from the
  camera's output render target, else its first post-process input, else the
  engine's main depth buffer. An upstream option would retire the patch.
- `_thinInstanceDataStorage.matrixData`: the thin-instance buffer Babylon
  renders from. The public `thinInstanceGetWorldMatrices()` caches on first
  call and goes stale after buffer edits.
- `wrapWebGPUTexture` (public) for the pool; `WebGPUDataBuffer` for storage
  buffer bindings.

### Seams into three.js

All in `src/three/SundialThree.ts`. three's backend keeps each object's GPU
resources in a side table, and the adapter fills some rows itself, which is
why the peer range is narrow: r186 is tested, and r187 is admitted pending a
check when it ships.

- `renderer.backend.device`: the core runs on three's `GPUDevice`, from its own
  command encoders.
- Storage buffers: two `StorageBufferAttribute`s whose backend rows are filled
  with the core's `GPUBuffer`s before first use. three allocates only when the
  row is empty, and never writes them (their versions never change). The
  params buffer is declared with Sundial's own `PsParams` struct.
- Textures: the pool and min/max atlas are three `ExternalTexture`s (the pool
  a `DepthTexture` flagged the same way, so it declares as `texture_depth_2d`).
  The pool's row is also filled early: until a depth texture has a GPU
  texture, three assumes the renderer's MSAA sample count for it.
- `scene.onBeforeRender` / `onAfterRender` (chained, restored on `dispose`):
  paging before the camera renders, page marking after, reading the camera's
  depth from the canvas target, the target's `depthTexture`, or the depth
  three keeps for its internal framebuffer target (`renderer._textures`).

### Upstream Babylon fixes

Sundial's work turned up two Babylon bugs, fixed upstream and approved by the
Babylon team, awaiting merge:

- **StandardMaterial alpha test in the depth pre-pass** (BabylonJS/Babylon.js
  #18936). With `transparencyMode = MATERIAL_ALPHATEST`, `needDepthPrePass`
  wrote the depth of whole alpha-tested quads and punched holes in the scene.
  Until it ships, `DepthPrePassAlphaTestFix` (exported from the adapter) is a
  material plugin that fixes it locally. A depth pre-pass on leaf meshes is
  the cheapest receiver win there is: one draw, identical pixels, no leaf
  overdraw left for the receiver to pay for.
- **Atmosphere plugin scope** (#18934). The atmosphere add-on registered its
  PBR material plugin globally, so PBR materials in other engines and scenes
  got a plugin bound to the wrong atmosphere.

## Limits and known issues

- **WebGPU only.** On WebGL2, keep a `CascadedShadowGenerator` (Babylon) or
  three's own shadow maps; `isSupported` tells you which.
- **One directional light.** Point and spot lights are out of scope.
- **Receivers:** Babylon: StandardMaterial and PBRMaterial in WGSL; node
  materials and custom shaders need the exported WGSL wired in by hand.
  three: every node material lit by the sun.
- **three.js:** perspective cameras only for level selection (orthographic
  cameras work but choose levels as if at 1 m); morph targets are not applied
  to casters; the adapter has no registration memo yet, so `setCasters` re-hashes
  every caster's geometry (clustering itself stays cached).
- **Skinned casters:** linear blend skinning only. Morph targets are not
  applied (the shadow has the unmorphed shape), and neither is CPU skinning
  (`computeBonesUsingShaders = false`). At most 8 influences and 256 bones
  per mesh. Every cluster of a skinned mesh is culled against the whole
  mesh's pose box, so a large skinned mesh pairs each of its clusters with
  every page under the whole mesh; fine for avatars, costly for a big rig.
  An animating skinned caster re-composes the pages under it every frame,
  like any moving dynamic caster (a full re-render with `staticCache: false`).
- **Memory:** the pool is 64 MiB at the defaults (`poolSize`, `pageSize`),
  and the static cache doubles that to 128 MiB (`staticCache: false` saves it).
- **Private Babylon API** (see Seams): a Babylon upgrade can break the adapter.
  Babylon 9.17.1 is tested.

Planned: level cross-fade, and a screen-space shadow mask as an
engine-agnostic receiver.

## Development

```
npm install
npm run dev              # the lab: http://localhost:5188
node scripts/bench.mjs   # interleaved A/B; GPU=nvidia for the discrete GPU
npm run test:consumer    # builds the package, installs it into test/consumer,
                         # checks it in real Chrome on WebGL2 and WebGPU
```

Lab URL knobs: `mode=sundial|csm|off`, `tier=medium|high`, `el`, `az`,
`speed` (sun °/s), `debug=1` (tint by level), `lodBias`, `budget`, `stride`,
`cam=x,y,z,tx,ty,tz`, `animate=0`, `trees=N`, `rx=onetap|bilinear|nolookup`
(receiver cost probes), `profile=0` (no GPU timestamps; the lab profiles by
default).

## Credits

Designed and directed by Allen Partridge ([p0qp0q](https://poqpoq.com)) for
poqpoq World. Implemented with Claude (Anthropic) as the coding partner, with
code reviews by Codex (OpenAI). Thanks to the Babylon.js team for reviewing
the upstream fixes, and to the players whose field runs set the targets.

Built on ideas from Unreal Engine 5's Virtual Shadow Maps, Fernando et al.'s
*Adaptive Shadow Maps* (2001), and Lefohn et al.'s *Resolution-Matched Shadow
Maps* (2007).

## License

MIT © 2026 Allen Partridge (p0qp0q)
