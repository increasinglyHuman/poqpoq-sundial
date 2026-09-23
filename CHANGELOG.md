# Changelog

All notable changes to `@poqpoq/sundial`. The project follows
[semantic versioning](https://semver.org/); while it is 0.x, a minor version
may change the API.

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
