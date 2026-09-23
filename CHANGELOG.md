# Changelog

All notable changes to `@poqpoq/sundial`. The project follows
[semantic versioning](https://semver.org/); while it is 0.x, a minor version
may change the API.

## Unreleased

### Core

- **Static cache** (`staticCache`, default on): static casters render into a
  second pool that keeps each page's static-only depth. A moving dynamic
  caster no longer invalidates the pages it crosses: they are re-composed
  from that pool (a quad per page) and only the dynamic casters are redrawn,
  instead of every static caster on them. `dynamicBudget` (default 64) caps
  re-composed pages per frame. Costs a second pool texture (64 MiB at the
  defaults); `staticCache: false` keeps the single-pool behaviour.
- New stats: `dynamicPages`, `dynamicDeferred`, `compositedPages`,
  `dynamicPairs`; `contentSummary.dynamicClusterInstances`.
- Static invalidation regions are capped at 128 per frame with the cache (the
  dynamic regions take the other half); past that, boxes merge as before.
- **Skinned casters.** `addCaster(mesh, { dynamic: true })` on a mesh with a
  skeleton casts its current pose, skinned on the GPU in the caster vertex
  stage: up to 8 influences, 256 bones, both of Babylon's bone matrix
  storages. The shadow's bounds are derived each frame from per-bone
  radii, with no CPU skinning. Core: `GeometryInput.skin` and
  `PagedShadowCore.setSkinPose()`. With the static cache, an animating skinned
  caster re-composes the pages it crosses like any dynamic caster. Morph
  targets are not applied.

### Lab

- `?cache=0`, `?dynBudget=N`, `?movers=N` (walkers through the forest), and
  `?t=` / `?stopAt=` to start and freeze the movers' clock.
- `?skinned=N` procedural skinned characters (`?skinT` freezes the
  pose, `?skin8=1` uses 8 influences).

## 0.1.0 — 2026-09-23

First public release. Sundial has been poqpoq World's default shadow system
on WebGPU since 2026-09-22.

### Core (`@poqpoq/sundial`)

- Paged (virtual) shadow map for one directional light: a 7-level clipmap
  of 128² pages in one 4096² `depth32float` pool, with toroidal addressing.
- A GPU-driven frame from one ~1 KB upload: marking from camera depth, page
  management with LRU, cluster × page culling, and three indirect draws.
- Per-level sun bands: a moving sun re-renders one level at a time.
- Alpha-tested casters through coverage-preserving mask mips.
- Receivers: `textureLoad` only (no samplers, no writes), 3×3 bilinear PCF,
  and a per-page min/max early-out that skips PCF for 60–79% of fragments
  with identical output.
- Depth is clamped to the far plane, so receivers past the range read lit.

### Babylon.js adapter (`@poqpoq/sundial/babylon`)

- `SundialBabylon`: static, dynamic and thin-instanced casters; automatic
  alpha masks from materials; `setCasters` with a registration memo;
  `updateCasterMatrices` for moving static instances without a rebuild.
- Receivers for StandardMaterial and PBRMaterial (WGSL), attached
  automatically to materials created after `start()`; `doNotSerialize`, so
  `Material.clone()` works.
- Coexists with a Babylon `ShadowGenerator` on the same light (`min()` fold).
- `DepthPrePassAlphaTestFix`: a local fix for Babylon 9.17.1's alpha test in
  the depth pre-pass, until BabylonJS/Babylon.js#18936 ships.
- Peer dependency: `@babylonjs/core` `^9.17.1`.
