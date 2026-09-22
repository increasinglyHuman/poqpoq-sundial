# Handoff: Sundial's World debut (for 2026-09-22)

**Goal for the day:** Sundial running in World behind a flag, default OFF, and deployed. Allen then
switches it on and we A/B it against CSM on real sims. It is NOT in World yet. The steps below are in
order.

## Where things stand (end of 2026-09-21)

**poqpoq-sundial** (`main` at `4754044`): the working example, the three Codex review fixes, and the
`@poqpoq/sundial` package with its consumer test. Open branches, no PRs yet:

| Branch | What | State |
|---|---|---|
| `feat/world-readiness` (`adc9988`) | Same-frame page marking via `markInto()`. World's HUD camera clears depth, which dropped page requests from 153 to 32; with the fix it's 153 = 153. Also a `getCamera` option and a `clipDistances` option. | Pushed, WIP. Continue here. |
| `repro/upstream-prepass-verify` | Babylon prepass-fix verification page, plus the visual-test Playground scene | Pushed; open a PR when convenient |

**Measured (lab, 1600×900, 1,400 trees):**
- Shadow cost on the RTX 5060: Sundial 1.3–2.0 ms, CSM MEDIUM 2.2–2.7 ms, CSM HIGH 5.5–10.3 ms.
- On the Xe-LPG: Sundial ~3.1 ms, CSM MEDIUM 5.3 ms, CSM HIGH ~11 ms.
- With the one-draw leaf prepass, Sundial's frame is ~45–50% faster than CSM MEDIUM on both GPUs.
- Full numbers: wiki page `Sundial-Paged-Shadows`.

**Babylon upstream:**
- **Atmosphere PR, BabylonJS/Babylon.js#18934: changes requested by Popov.** To do:
  - Register under a per-scene key, `${MaterialPlugin}-${scene.uid}`.
  - Drop the constructor's unconditional unregister.
  - Unregister only this instance's key in `dispose()`.
  - Add unit tests:
    - one atmosphere plus a foreign scene
    - two scenes, each with an atmosphere
    - materials created before and after the second atmosphere
    - disposal in either order
- **Prepass PR: opened as BabylonJS/Babylon.js#18936** (2026-09-22). Three commits on fork branch
  `fix/standard-depthprepass-alphatest`:
  - `b39f460`: the shared alpha block, evaluated before the prepass exits.
  - `0800c3b`: bind `alphaCutOff` whenever ALPHATEST is defined. This fixes a second bug, where
    vertex and instance alpha, opacity Fresnel and `material.alpha` never discarded.
  - `819ac00`: a visual test on Playground `#7EDYVC#3`. It fails on master and passes with the fix,
    on WebGL2 and WebGPU.
- The full-suite A/B against master found no regressions. Candidates were re-run 3× with retries
  off; each either passed consistently or failed identically on master.
- Next: respond to review.

**World:** nothing of Sundial yet.
- Merged: #1959 face grouping (flag OFF), #1988 leaf prepass (OFF), and #1979.
- Nothing is open in `ShadowDirector`.

## Morning, in order

### 1. Unblock CI and the build (Allen, 5 minutes, do first)

World CI checks out its private sibling packages at pinned SHAs using `secrets.SIBLING_REPO_TOKEN`.
See `.github/workflows/ci.yml`: the "Checkout … contract" steps, then `link_sibling`.
- **Add `increasinglyHuman/poqpoq-sundial` to that token's repository access.** Otherwise World CI
  breaks the moment World depends on Sundial.
- Confirm where prod builds resolve siblings (wsl-poqpoq skill). `poqpoq-sundial` must be cloned and
  built with `npm run build` beside World there as well.

### 2. Finish `feat/world-readiness` in poqpoq-sundial (as a PR, with Codex review)

- **Rebuild API.** `setCasters(list)` clears and re-registers, rebuilding the GPU buffers and
  destroying the old ones.
  - Cache each geometry's clusters, keyed by Babylon geometry id plus a hash of the positions.
    Terrain sculpting changes positions, so the hash matters.
  - The cache is what keeps rebuilds cheap while content streams in.
- **SubMesh-aware registration.** Follow the contract in wiki `Prim-Draw-Call-Reduction` §10b:
  - Iterate SubMeshes.
  - **Skip null-material slots.** Those are hidden prim faces, and they'd otherwise cast.
  - Group SubMeshes by material, one geometry each.
- **Alpha masks from Babylon's own textures,** for alpha-tested materials (`needAlphaTesting()`):
  - Read the diffuse, albedo or opacity texture with `readPixels()`.
  - Dedupe by texture uniqueId into 16 or more alpha layers.
  - Build coverage-preserving mips (already in `setAlphaLayer`).
  - Take the cutoff from `material.alphaCutOff`.
  - Treat the caster as opaque until its mask resolves, then rebuild.
- **Darkness.** Add `tuning.darkness`, fed from World's `fill` plus the dusk fade
  (`effectiveDarkness`). The receiver returns `mix(darkness, 1, shadow)`. This needs a new params
  `vec4`, which shifts `LEVELS_WORD`.
- **Scene bounds.** `setSceneBounds(min, max)`, followed by invalidateAll.
- **Late materials.** Materials created after start pick up the receiver automatically, via
  `onNewMaterialAddedObservable`.
- **Re-run everything:** `npm run test:consumer`, the lab bench (NVIDIA, then Intel), `?hud=1` and
  `?clip=0`.

### 3. World branch `feat/sundial-debut` (own worktree, flag OFF)

- **Worktree.** Run `git worktree add ../World-sundial -b feat/sundial-debut origin/main`. The
  worktree must sit beside World so `file:../` paths resolve, and its `node_modules` is a junction to
  `World/node_modules`, per World's convention.
- **Package.**
  - Clone `poqpoq-sundial` to `C:/Users/incre/blackbox/poqpoq-sundial`, then `npm ci` and
    `npm run build`.
  - World's dependency line: `"@poqpoq/sundial": "file:../poqpoq-sundial"`.
  - Add it to `ci.yml` (checkout at `SUNDIAL_REF`, `npm ci`, build, `link_sibling`) and to the
    pin-drift script's list.
- **Device feature.** Add `'clip-distances'` to `requiredFeatures` in `BabylonEngine.ts`. It's safe,
  because Babylon intersects the list with what the adapter offers, and the fallback path renders
  pixel-identically anyway.
- **`ShadowDirector` backend seam.**
  - When the flag is on and `SundialBabylon.isSupported(engine)` is true, `apply()` builds Sundial
    instead of the CSM generator.
  - Keep the watchdog, veto, fill/fade and probe hold.
  - `rebuildNow()` hands the classified casters to `setCasters`: terrain, thin hosts, alphaTest,
    dynamic (unfrozen), and the proxy set as static.
  - `getWorldCamera` becomes Sundial's `getCamera`.
  - `status()` reports Sundial's stats.
  - Flag: `?sundial=1`, plus `bbWorldsApp.shadows.sundial(true)`.
  - Skinned avatars won't cast in v1, unless we keep a one-cascade CSM for them. Allen's call.
- **Then:** tests, lint and World CI, a Codex review, merge with the flag OFF, and deploy (wsl-poqpoq
  skill).

### 4. Field A/B

- **Sims:**
  - Forest Alpha (vegetation)
  - Plaza (thin-instanced prims)
  - comm (the sim with 4,500 shadow draws per frame)
  - later, Elf Beach
- **Order:** NVIDIA first, Intel second.
- **Baseline:** compare Sundial against CSM **with `?facegroups=1`**, which is the honest baseline.
- **Method:** throughput with the warm-up and flush protocol, plus Sundial's own pass timestamps.
  `shadows.cost()` can't price Sundial, because its casters are GPU-driven.

## Rulings to keep (details in memory: `sundial-receiver-rulings`)

- Material receivers must be read-only. A storage write that never executes still killed early-Z
  (+13 ms).
- Alpha-test before the expensive work. The earlier "demote-to-helper" explanation was wrong.
- No dynamically indexed local arrays in hot fragment code on Intel.
- iGPU A/B needs warm-up and flush pages.
- Keep wind out of the caster pass.
- The shadow raster stays out of snapshot bundles; Sundial already is, by construction.
- Babylon's visual harness runs the UMD bundles. Rebuild them, and grep them for your change, before
  testing.

## Coordination

- **world-ee** owns `BabylonTree` edits, including the leaf prepass (#1988).
- **world-7f** owns prims: #1959, Legacy#77, Elf Beach.
- **legacy-ac:** Legacy will ship KTX2 textures with prebuilt, coverage-preserving mips.
- Message the owner of any file before touching it. `ShadowDirector` had no open work at handoff.
