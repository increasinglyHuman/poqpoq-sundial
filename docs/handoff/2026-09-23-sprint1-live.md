# Handoff — Sundial Sprint 1 live (2026-09-23 morning)

Read this first. It supersedes `2026-09-22-sundial-live.md` (history now).

## Where things stand

- **Prod:** World main `1da3f967` = `assets/index-Ch7xUDBb.js` (sha256 `af3aed79…`), deployed 2026-09-23 ~05:28Z.
  - Sundial is the **default** shadow system on WebGPU. `?sundial=0` opts out; WebGL falls back to CSM on its own.
  - Rollback: `/var/www/world/index.html.bak-20260923T052800-pre-1da3f967` (older ones sit beside it).
- **Sundial:** `main` = `6a55c2d`, pinned by World's `SUNDIAL_REF`. The shared checkout `C:/Users/incre/blackbox/poqpoq-sundial` is on main, with `dist/` built from 6a55c2d.
- **Field results:**
  - comm A/B: 29 fps (CSM) → 41 (Sundial).
  - A `meshAdded` rebuild on comm: 1,539 → 170 ms.
  - Allen: "overall shadow performance is significantly improved".

## What shipped 2026-09-22 → 23

| Sundial PR | What |
|---|---|
| #13 | Content-addressed geometry keys, per-cluster `vertexBase` (repack = copies), a cache grace of 4 builds. |
| #14 | Receiver plugin `doNotSerialize`. `Material.clone()` threw on prod, which broke face edits, media and texture animation. |
| #15 | `contentHash` truncated `number[]` positions to integers. Since #13, similar prims shared one shadow. |
| #16 | Batch 1: dormant at darkness ≥ 0.999, back-face receiver skip, coarsest level listed first, collapsed instances have no footprint, region overflow merges boxes, padded depth sphere. |
| #17, #21 | `CONSUMER_PORT` for parallel consumer tests; `shoot.mjs` honours `PORT`. |
| #18 | Per-frame CPU: no per-frame allocations, `profiling` off by default, cheaper dynamic casters. |
| #19 | Receiver min/max early-out: 60–79% of receiver fragments skip PCF, byte-exact. |
| #20 | Registration memo (unchanged rebuild 81 → 5–9 ms), radix sort, `updateCasterMatrices`, coalesced alpha-mask rebuilds. |
| #22 | Pair-overflow fix (pages lost casters), indirect and per-level cull, tighter light-space bounds, lean opaque VS, scene-rect marking, optional marking rotation (`markRotate`, off). |

World: #2005/#2012/#2014/#2017 repins, #2006 hook runs eslint only, #2007 `status().rebuildLog`, #2008 default ON + veto store v4, #2011 thin-host bounds, #2022 avatar map by reach + no teardown on camera switch + skip no-op rebuilds, #2032 Sprint 1 integration (settle scan, terrain-sculpt re-register, profiling follows `gpuTiming`).

**Lab A/B, idle GPU, before → after Sprint 1** (`scripts/bench.mjs`, interleaved):

| | village | overview | forest |
|---|---|---|---|
| NVIDIA | 2.67 → 2.14–2.23 ms | 2.95 → 2.44–2.49 ms | 1.92 → 1.58–1.72 ms |
| Intel Xe-LPG | 8.41 → 7.26 ms | 8.53 → 7.34 ms | 7.38 → 6.14 ms |

**Intel, new build:** off 3.8 / 3.9 / 5.0 ms; **Sundial 7.1 / 7.3 / 6.2**; CSM medium 10.6 / 9.7 / 8.8; CSM high 18 / 17–20 / 15.

## Targets (agreed with Allen)

1. **Intel parity:** Sundial ≤ CSM medium on Intel. **MET** — it is 25–33% faster.
2. **Shadow tax:** ≤ ~1 ms on Intel, ≤ ~0.3 ms on NVIDIA. **Not met on Intel** (1.2–3.3 ms). Most of what's left is the receiver.
3. **No hitches:** no shadow-caused frame over 33 ms on stream, teleport, camera switch or sun move. Needs a field walk.
4. **Field:** shadows off vs on differ by ≤ ~10% fps on comm and Elf Beach. Needs a field walk.

## Open work, in Allen's order

1. **Sprint 2**
   - **Receiver bug:** a receiver beyond the depth range (z > 1: far sea past the scene) reads SHADOWED. Clamp z. Repro: the demo's `?sea=1&cam=90,25,40,200,0,120`.
   - **World thin hosts:** on a canon-epoch change, call `SundialBabylon.updateCasterMatrices` instead of a full rebuild. It returns false on a count change; fall back to the rebuild then.
   - **Tuning:** `lodBias` (+0.5?) and `markStride` 4 with `markRotate`. Decide with Intel numbers; `requestedPages` counts are already in the #22 PR.
2. **Screen-space shadow mask, phase 0** (2–4 h): measure receiver overdraw and the receiver's share of frame time in World on Intel. The `globalThis.__psReceiver` hook swaps the receiver WGSL.
   - Full build is ~3–5 days and needs a full depth pre-pass in World (CPU risk on prim-heavy sims).
   - Poqpoq gain ~1–2 ms on Intel only. The bigger value is portability: a mask is an engine-agnostic receiver interface, which makes three.js much easier. Allen: worth it for the broader community and to gauge interest.
3. **The About.** Allen's item 1: what Sundial is, how it works, results, using it, limits, credits. Also decide where it lives (README / docs / a public page). Sections 3 and 6 can come from this doc and the review reports.
4. **Sprint 3:** static/dynamic page separation (UE5-style; WebGPU cannot copy depth sub-rects, so composite with a `frag_depth` quad per page), then true skinning in the caster VS (bones as extra `PsInstance` rows). Rigid bone proxies were rejected.
5. **Standalone library:** the repo is private and `"private": true`; there is no CI (PRs show "no checks"); the README path is stale (`file:../poqpoq-virtualShadowMapper/lab`); no API reference, no tags. The three.js adapter is Allen's item 2. The core has zero Babylon imports; receivers via TSL are the unknown (or via the mask).

## Upstream Babylon PRs (both fully approved; waiting for a maintainer merge)

- **#18934 (atmosphere scope):** 84e0f4d adds the same-scene factory guard and a test counting ACTIVE plugins. deltakosh and Popov both APPROVED on 09-22.
- **#18936 (depth pre-pass alpha):** 77f7d70 moves the test to `#7EDYVC#5` (material alpha, thin-instance colour, opacity fresnel) and adds `Textures`/`Meshes` to dependsOn. Both APPROVED.
- Babylon CI starts only on a maintainer's `/azp run`.

## Handed to other lanes

- **Linden trees → Kudzu** (world-c8's trees lane, now "the veg instance"; world-b5 owns the BuildingManager door). comm's ~6.1 M of 6.3 M unique triangles are 219 per-placement BabylonTree generations from OAR `linden://` rows, using the interim Landscaper presets. Allen's ruling: route them into Kudzu's normal trees. Open questions for Allen: migrate or route at load time; ownership of the `legacy_import` rows; the 108 skipped ferns. SceneMutationApplier needs a linden arm. This is the likely cause of comm's hub at ~44 fps vs ~70 outside it.
- **Vanishing prims up close** (world-b5): not Sundial (it never hides meshes). Suspects are the CameraObstructionFader or grouped SubMesh bounds.

## Traps found (each cost real time)

- **`scripts/shoot.mjs` ignored `PORT`** before #21. Two parity claims (#13, #16) compared the same unrelated server; both were re-verified. #13 alone changed thousands of pixels (the hash bug). Today's main equals pre-#13, and #16 is identical. The stats panel is wider than 240×200: mask 420×320.
- **Intel power states** make runs bimodal (~8 vs ~25 ms). Use bench.mjs's flush-page protocol and discard the outlier mode. A "3× night-mode win" was this artefact.
- **World's shared build inputs:**
  - **Sundial:** World builds from the shared checkout's `dist/`. Keep it at the pinned commit, and never run `npm run test:consumer` there on a branch (it rebuilds `dist/`).
  - **Scripter:** the scripter-build guard needs BlackBoxScripter at World's pin. `C:/tmp/scripter-pin-e30899e` is a pinned worktree, and `World-sundial/node_modules/blackbox-scripter` is a junction to it (wsl-poqpoq skill §5.1a2).
- **Babylon delivers `onNewMeshAdded` asynchronously.** Tests that depend on it go in their own file (`ShadowDirector.rebuildSkip.test.ts`).
- **Babylon `Material.clone()` rebuilds plugins by class name:** any shipped plugin must be `doNotSerialize` or registered.
- **Multi-agent sprints:**
  - Give each agent its own worktree (node_modules junction) plus consumer and demo ports.
  - Merge one PR at a time and have its author rebase.
  - Watch for **shared-word collisions**: two lanes both claimed `psParams.shade.y`.
  - Agents can't benchmark on a shared GPU; the orchestrator runs clean A/Bs after merging.
- **Default flips** need an edit-path smoke test and a note to every World lane (memory `default-flip-needs-edit-path-smoke`).
- **Deploys:**
  - Ack round with every live World lane.
  - Back up `index.html` first.
  - Check `git log <prod>..origin/main` right before building.
  - Name every merged-but-undeployed PR to Allen: main may carry other lanes' work he hasn't ruled on.

## Local layout

- `C:/Users/incre/blackbox/poqpoq-sundial` — the shared Sundial checkout (main + dist). Do branch work in `C:/tmp/<name>` worktrees with a node_modules junction.
- `C:/Users/incre/blackbox/World-sundial` — the World build worktree (own node_modules; scripter junction as above).
- `C:/Users/incre/blackbox/sundial-hitch` — stale worktree of the merged #11 branch; safe to remove.
- Consumer test: `CONSUMER_PORT=<port> npm run test:consumer`. Demo: `node node_modules/vite/bin/vite.js --port <p> --strictPort`. Bench: `PORT=<p> [GPU=nvidia] node scripts/bench.mjs "profile=0"` (Intel is the default adapter). Rebuild probe: `PORT=<p> node scripts/rebuild-probe.mjs`.
