# poqpoq-sundial — paged sun shadows for WebGPU

A working virtual (paged) shadow map for one directional light, built for
poqpoq World on Babylon.js 9 and WebGPU. Engine-agnostic core, thin Babylon
adapter, procedural poqpoq-sized test world, and a live A/B against Babylon's
`CascadedShadowGenerator` configured like World's `ShadowDirector` tiers.

```
npm install
npm run dev            # http://localhost:5188
node scripts/bench.mjs # interleaved A/B on whatever GPU Chrome picks
```

URL knobs: `mode=sundial|csm|off`, `tier=medium|high`, `el`, `az`, `speed`
(sun °/s), `debug=1` (tint by level), `lodBias`, `budget`, `stride`,
`cam=x,y,z,tx,ty,tz`, `animate=0`, `trees=N`, `rx=onetap|bilinear|nolookup`
(receiver cost probes).

## How it works

A clipmap of 7 levels, 16×16 pages each, 128² texels per page; level 0 is
16 m across (7.8 mm texels), each level doubles. Pages live in one 4096²
`depth32float` pool (1,024 pages, 64 MiB). Addressing is toroidal, so a
walking camera only exposes a strip of new pages.

Every frame, on the GPU, from one ~1 KB params upload:

| Pass | What |
|---|---|
| mark | compute over last frame's camera depth: each visible surface requests the page at the level whose texels match its pixel footprint |
| manage | retag scrolled slots, dirty pages under moving casters, collect free / old / recent physical pages, allocate (LRU), build the render list |
| cull | every cluster instance × every page being rendered → (cluster, page) pairs |
| raster | **one** clear draw + **one** opaque draw + **one** alpha-tested draw, all indirect; vertex pulling places each triangle in its page's atlas rectangle, clip distances trim it to the page |

Static pages are never redrawn. The sun is handled per level: each level
keeps the light basis it was rendered with and re-renders only when the sun
has drifted past its band (`bandDegrees × 2^level`), one level per frame at
most, so a moving sun costs a trickle of fine-level refreshes instead of a
full redraw.

Receivers are injected into Standard and PBR materials at
`CUSTOM_LIGHT{k}_COLOR` (plus a per-light regex for StandardMaterial's
specular). They read the page table from a storage buffer and the pool with
`textureLoad`: **no samplers are added**, and they are strictly read-only.

## Results

Procedural 256 m sim: 1,400 alpha-tested trees, 133k-triangle terrain, a
prim village, 1600×900 with 4× MSAA. Milliseconds per frame (throughput),
medians of interleaved rounds with warm-up and flush pages. Lower is better.

| | RTX 5060 village | RTX 5060 forest | Xe-LPG village | Xe-LPG forest |
|---|---|---|---|---|
| shadows off | 0.73 | 0.54 | 3.55 | 3.04 |
| CSM MEDIUM (3×2048²) | 3.38 | 2.85 | 9.41 | 7.89 |
| CSM HIGH (4×4096²) | 10.99 | 5.99 | 15.48 | 12.93 |
| **Sundial** | **2.63** | **1.88** | **6.80** | **6.06** |
| **Sundial + leaf prepass** | **1.93** | **1.57** | **5.49** | **5.14** |

The prepass rows come from a separate run; the other rows are from one run
per GPU.

Static shadow-map production is ~0.05 ms (page management 0.03 ms, raster
0.02 ms); page marking is 0.03 ms on the RTX and 0.3–0.4 ms on the Xe-LPG.
With a moving sun, moving casters and a camera walking at 5 m/s all at
once, the Xe-LPG frame stays at ~7.05 ms while CSM MEDIUM rises to ~10.75 ms.

**Leaf prepass** = `needDepthPrePass` on the one thin-instanced leaf mesh:
one extra draw call, pixel-identical output, and no leaf overdraw left for
the receiver to pay for. On StandardMaterial with
`transparencyMode = MATERIAL_ALPHATEST` this needs
`DepthPrePassAlphaTestFix` (below).

## A Babylon bug, and its fix

`src/babylon/DepthPrePassAlphaTestFix.ts`. In Babylon 9.17.1,
StandardMaterial (GLSL and WGSL) with `transparencyMode = MATERIAL_ALPHATEST`
defines `ALPHATEST_AFTERALLALPHACOMPUTATIONS`, which moves the alpha test to
the end of the shader. The `needDepthPrePass` variant returns before the
test, so the prepass writes the depth of whole leaf quads and punches holes in
the scene. The plugin alpha-tests at `CUSTOM_FRAGMENT_UPDATE_ALPHA` in the
prepass variant only. PBR, and StandardMaterial on the legacy
`diffuseTexture.hasAlpha` path, are unaffected.

## Rulings learned the hard way (measured on Intel Xe-LPG)

1. **Receivers must not write.** A storage write in a material shader, even
   one that never executes, disables early-Z for the whole draw: +13 ms in the
   forest. Page requests come from the mark pass over camera depth instead.
2. **Alpha-test before the expensive work.** StandardMaterial with
   `transparencyMode = MATERIAL_ALPHATEST` discards at the *end* of the
   shader, after all lighting, so every transparent leaf texel paid for the
   full receiver first. Guarding the receiver on the alpha test took the
   village view from 24 to 6.8 ms. (An earlier explanation, Tint's
   demote-to-helper, was wrong: on the legacy early-discard path, gating
   measured no gain at all, on either GPU.)
3. **PCF without arrays.** 3×3 bilinear PCF over a 4×4 footprint collapses to
   separable weights (1−f, 1, 1, f); a dynamically indexed 4×4 array spilled on
   Intel and cost ~45 ms.
4. **Bench with flush pages.** A cold browser, or a heavy page just before,
   leaves the iGPU in a slow transient (same page measured 23.8 vs 6.8 ms).
   `bench.mjs` warms every mode and loads a cheap page before every run.

## Seams into Babylon (quarantined in `src/babylon/SundialBabylon.ts`)

- `engine._device` — the core runs on Babylon's own `GPUDevice`, from its own
  command encoder, submitted before Babylon's frame. Babylon only samples the
  result, so the shadow pass is outside any snapshot bundle by construction.
- `engine._depthTexture` plus a `createTexture` patch that adds
  `TEXTURE_BINDING` to Babylon's main depth buffer, so marking can read it.
  The one real patch; an upstream option would retire it.
- `wrapWebGPUTexture` (public) for the pool; `WebGPUDataBuffer` for storage
  buffer bindings.

## Not done yet

- Skinned casters (the core pulls rigid geometry; avatars would go through
  the adapter as a dynamic layer).
- Double-buffered level refresh, so a sun-band refresh never falls back a level.
- Level cross-fade; page-border-aware PCF for the rare cross-page footprint.
- A three.js adapter (`ShadowBaseNode` subclass), per the research plan.
- Pulling World's real content (terrain splat plugin composition, OAR prims).
