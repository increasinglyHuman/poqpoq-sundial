# Handoff: Sundial is live on poqpoq.com behind a flag (end of 2026-09-22)

**For:** the next shadow-lane session, and anyone on World touching shadows.
**Read with:** `2026-09-22-sundial-world-debut.md` (this morning's plan). Everything in its steps 1–3
is done; step 4 (the field A/B) has started.

## Where things stand

**Prod:** poqpoq.com World = `c431e39c` (bundle `index-BwpnP9bz.js`), deployed by world-e7.
- Sundial is in, **flag OFF**. Normal users get CSM exactly as before.
- Turn it on with `?sundial=1`, or live with `bbWorldsApp.shadows.sundial(true)`.
- Face grouping is a separate flag, `?facegroups=1`. Flags stack with `&`.
- Check which build is running in the console:
  `document.querySelector('script[src*="index-"]').src`.

**First field run (Allen, NVIDIA, sim `724591c4`, vegetation-heavy):**

| run | fps |
|---|---|
| CSM | 50–70 |
| CSM + face groups | 70–90 |
| Sundial | 75–126 ("shadow quality radically better") |
| Sundial + face groups | 75–90 |

- **Why face groups help CSM:** CSM redraws every caster per cascade. Sundial's cost isn't per draw.
- **Open question:** Sundial's top end dropping with face groups is unexplained. The suspect is
  rebuild churn (see Open work 2).

**Merged today**
- **poqpoq-sundial**
  - `#9`: World readiness, plus four integration fixes:
    - receivers rebind across instances
    - marking uses the camera's real depth target
    - plugin priority is after the atmosphere
    - min() into Babylon's shadow term
  - `#10`: `CasterOptions.instanceMatrices`.
- **poqpoq-world**
  - `#2000`: Sundial as a ShadowDirector backend, flag OFF.
  - `#2004`: trees cast from InstanceManager's canonical matrices.
  - Also: `#1999`, the angleBetween atan2 fix (another session; `#2001` closed as its duplicate).

**Open**
- **poqpoq-sundial `#11`**, `perf/rebuild-hitch`: rebuilds re-render only what changed and repack
  nothing that didn't.
  - Lab result: rebuild 21 → 10.6 ms, pages re-rendered afterwards 118 → 0.
  - Needs review, merge, a World repin (`SUNDIAL_REF`), and a deploy.

## How it fits together (decisions worth keeping)

- **Casters.** The director classifies casters as it does for CSM (`classifyCaster`), but registers
  each one individually, with no proxy merge. Unfrozen casters are dynamic.
- **Skinned avatars** can't cast in Sundial: its caster pass has no skinning.
  - Under Sundial they get a small avatar-only CSM: `SUNDIAL_AVATAR_SHADOW`, 2 cascades over 50 m
    at 2048.
  - Receivers take `min()` of the two shadows. Sundial folds its factor into Babylon's per-light
    `shadow` just before `aggShadow+=shadow;`.
- **InstanceManager thin hosts** (trees, instanced prims) cast from their CANONICAL matrices
  (`composeThinMemberMatrixTo`). The live buffer is a view: distance culling zero-scales far members.
  A change in `getThinBufferEpoch` triggers a rebuild.
- **Alpha masks** follow Babylon's `ShadowGenerator` rule, not the render shader's:
  - `getAlphaTestTexture()` (diffuse or albedo), the alpha channel, `alphaCutOff ?? 0.5`.
  - The texture is read through `GetTextureDataAsync`'s render-target path, which also decodes KTX2.

## Traps found today (each cost an hour)

1. **Post-processes move the depth.** A camera with post-processes renders into the post-process's
   input target, not Babylon's main depth. Page marking must read the camera's real depth target.
2. **The atmosphere overwrites the light colour.** Babylon's atmosphere PBR plugin (priority 600)
   overwrites `diffuse{k}` at `CUSTOM_LIGHT{k}_COLOR`, so scaling the light colour there is lost, and
   the compiler drops it as dead code.
3. **Empty maps compile no shadow.** Babylon compiles `SHADOW{k}` into a material only if the map's
   render list is non-empty *when the material prepares*. The avatar map starts empty, so the
   director re-prepares materials on the empty ↔ non-empty transition.
4. **`subMesh.materialDefines` lies from the console.** Read from page.evaluate, it returns the
   CURRENT render pass's defines. Trust pixel diffs (with/without), not that probe.
5. **Distance culling zero-scales thin members.** Anything that snapshots thin-instance buffers
   must read the canon, or it captures the culled state.
6. **Receivers must rebind.** A material keeps its plugin for life, and Babylon silently rejects a
   second plugin of the same name, so a new SundialBabylon instance must rebind existing receivers.
7. **Windows-only traps.**
   - Python defaults to cp1252. `open(p, 'w')` truncates before a failed encode. Always pass
     `encoding='utf-8'`.
   - `npm install` in a World worktree runs husky, which sets `core.hooksPath` in World's SHARED git
     config. Use `HUSKY=0 npm install`.

## Rules in force

- **World CI takes about 7–12 minutes** per run (8–12 min on 2026-09-22). Budget for it before a
  deploy: a pin change needs a green run on its PR before it merges.
- **World deploys:** message every live World session (on 2026-09-22 that was world-ee, world-e7
  and world-25) and wait for acks; one builder at a time (Allen's rule).
  - Deploy with the wsl-poqpoq recipe: narrow rsync of `assets/`, `runtime/` and `index.html`,
    back up `index.html` first, never `--delete`.
- **poqpoq-sundial:** everything goes through PRs. Codex reviews via `docs/TEAM_COMMS.md`.
- **Sibling pins:** World's `SUNDIAL_REF` pins a poqpoq-sundial commit on `main`. Never pin a PR head
  for a merge.
- **World pre-commit hook:** it reformats whole files (World isn't prettier-clean). Skipping it
  needs Allen's approval each time.

## Open work, in order

1. **Land `#11` (the rebuild hitch).** Review, merge, repin `SUNDIAL_REF`, then deploy (with acks).
2. **Add a rebuild counter to `status()`** (per minute, with the reason) to confirm or rule out
   face groups causing rebuild churn.
3. **Field A/B, properly:**
   - Compare CSM + face groups against Sundial + face groups on the same route.
   - Sims: the comm sim (prim-heavy, 4,500 CSM shadow draws per frame), Plaza, Elf Beach.
   - Then an Intel run.
4. **Intel tuning of the avatar map.** In the lab at street level it costs about 1 ms on the Xe-LPG
   (Sundial + avatar map was 1.4 ms slower than CSM). Try a 1024 map, or a single non-cascaded map
   with lighter filtering.
5. **Two things seen in field status.**
   - The page pool was full (1,024/1,024 resident). Consider an 8192 pool (4,096 pages, +192 MB).
   - The scene bounds span 980 m vertically: some caster sits very high or low.
6. **The hook.** Allen wants the pre-commit hook fixed. Proposal: remove `prettier --write` from
   `lint-staged` and keep `eslint --fix`. Tell the World sessions first.
7. **Default ON.** Allen leans toward it. Criteria before flipping: `#11` deployed, the comm sim and
   an Intel run look like today's, `?sundial=0` kept as the escape hatch.
   - Middle option: default ON for discrete GPUs only.

## Babylon upstream PRs (separate thread, both open)

Both came out of this lane's work. They're filed from Allen's fork, clone `C:/Users/incre/blackbox/Babylon.js`,
with remote `upstream` = BabylonJS/Babylon.js. Read memory `babylon-upstream-pr-workflow` before
touching either. **The visual-test harness runs the UMD bundle, not `dev/core/dist`:** after every
source change run `node scripts/ensureUmdBuilds.mjs` and grep the bundle for your change, or the
tests silently check stale code. Babylon's CI starts only when a maintainer comments `/azp run`.

### #18934: Atmosphere plugin scope (branch `fix/atmosphere-plugin-scene-scope`)
- **The bug.** `Atmosphere` registered its PBR material plugin globally, so PBR materials in OTHER
  scenes or engines got an atmosphere plugin bound to the wrong context.
- **Commits.**
  - `6dba46b`: the factory only attaches in the atmosphere's own scene.
  - `4b1676c`: after Popov's review, per-instance registration keys (`atmo-pbr-${uniqueId}`); no
    unconditional unregister; `dispose()` removes only its own key. Adds
    `addons/test/unit/atmosphere/materialPluginRegistration.test.ts` (NullEngine, 4 cases, all fail
    on master).
- **Status (2026-09-22 14:21Z):** Popov **APPROVED**. deltakosh **CHANGES_REQUESTED** (10:17Z), so it's
  still blocked:
  > With two Atmospheres in the SAME scene, both factories run for each new PBR material. The second
  > `AtmospherePBRMaterialPlugin` activates itself before `_addPlugin` rejects the duplicate name, so
  > it stays in `_activePlugins`, its shader injections concatenate with the first's, and the material
  > can fail to compile.
- **To do:**
  - Don't construct a second plugin when the material already has one. In the factory, check
    `material.pluginManager?.getPlugin("AtmospherePBRMaterialPlugin")` and return null. Or enforce
    one Atmosphere per scene.
  - Add a same-scene regression test that checks the ACTIVE plugins or the shader, not just
    `getPlugin()`.

### #18936: StandardMaterial depth pre-pass honours alpha test (branch `fix/standard-depthprepass-alphatest`)
- **The bug.** A StandardMaterial with `needDepthPrePass` and an alpha test wrote depth for discarded
  texels, punching holes in later geometry. Separately, `alphaCutOff` wasn't bound for alpha sources
  other than textures.
- **Commits.**
  - `b39f460`: a shared GLSL/WGSL alpha include, evaluated before the pre-pass exits.
  - `0800c3b`: bind `alphaCutOff` whenever `ALPHATEST` is defined.
  - `819ac00`: the visualization test `needDepthPrePassStandardAlphaTest` (Playground `#7EDYVC#3`),
    which fails on master and passes on WebGL2 and WebGPU.
  - The full suite was compared against master: no regressions.
- **Status (15:41Z):** deltakosh **APPROVED**. Popov: "approve with minor changes" (14:21Z), with two
  inline asks on `packages/tools/tests/test/visualization/config.json`:
  1. Cover the newly supported alpha paths as well: **material-only alpha**,
     **`INSTANCESCOLOR && INSTANCES`** and **`OPACITYFRESNEL`**. Today's scene covers only diffuse
     alpha, opacity-texture alpha and vertex alpha.
  2. Add **`Textures`** and **`Meshes`** to the test's `dependsOn`, so selective CI runs it.
- **To do:** extend the Playground scene with those three cases, save a new snippet revision,
  regenerate and LOOK at the reference image (after `ensureUmdBuilds`), update `config.json`, and
  reply inline.

## Local layout

- `C:/Users/incre/blackbox/poqpoq-sundial`: the flat clone World resolves through `file:`. Keep its
  `dist` built from `main` whenever someone may deploy World.
- `C:/Users/incre/blackbox/sundial-hitch`: worktree for `#11`.
- `C:/Users/incre/blackbox/World-sundial`: World worktree with its own `node_modules`, needed
  because the shared one lacked main's Babylon patch.
- Lab helpers used today (in the session scratchpad, not the repo):
  - director bench: off / CSM / Sundial, with optional stand-in avatars
  - CDP rebuild profiler
  - rebuild timer
