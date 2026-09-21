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

## Rulings learned the hard way (measured on Intel Xe-LPG)

1. **Receivers must not write.** A storage write in a material shader, even
   one that never executes, disables early-Z for the whole draw: +13 ms in the
   forest. Page requests come from the mark pass over camera depth instead.
2. **Skip the receiver for alpha-test-discarded texels.** Tint lowers
   `discard` to demote-to-helper, so discarded leaf-card texels still run the
   whole shader. Guarding the receiver on the material's own alpha test took
   the village view from 30.5 to single-digit ms.
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
