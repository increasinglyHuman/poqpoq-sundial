# Babylon bug: `needDepthPrePass` ignores alpha test on StandardMaterial with `MATERIAL_ALPHATEST`

**Status:** draft for Allen's approval. Not posted.
**Verified on:** Babylon.js 9.17.1, WebGL2 (GLSL) and WebGPU (WGSL), Chrome, RTX 5060.
**Local repro:** `npm run dev`, then `/repro.html?engine=webgl2|webgpu&prepass=0|1&fix=0|1`.

## Forum post (draft)

> **Title:** StandardMaterial: needDepthPrePass writes whole-quad depth when transparencyMode = MATERIAL_ALPHATEST
>
> Hi all. We use alpha-tested leaf cards with `needDepthPrePass` to cut foliage overdraw, and found that on StandardMaterial the depth prepass skips the alpha test when the material uses `transparencyMode = Material.MATERIAL_ALPHATEST`. The prepass writes the depth of the entire quad, so the transparent part of the card hides whatever is drawn behind it afterwards.
>
> Playground: *(link once saved from the snippet below)*. Toggle `needDepthPrePass` to see the hole appear and disappear. It reproduces on both WebGL2 and WebGPU.
>
> **Cause.** With a non-null `transparencyMode`, StandardMaterial defines `ALPHATEST_AFTERALLALPHACOMPUTATIONS`, which moves the alpha test to the end of `default.fragment`. But `#include<depthPrePass>` sits near the top and returns early in the `DEPTHPREPASS` variant, so in that variant the test never runs. (Line numbers from the built 9.17.1 shaders: GLSL `default.fragment` 120 / 134 / 256–257, WGSL 111 / 124 / 246–247.) PBR is not affected, because its alpha test runs inside the albedo/opacity block before the prepass exit. StandardMaterial on the legacy path (`diffuseTexture.hasAlpha` without `transparencyMode`) is not affected either, because it tests early.
>
> **Possible fix.** In the `DEPTHPREPASS` variant, run the alpha test before the early return. Minimal version, just before `#include<depthPrePass>`:
>
> ```glsl
> #if defined(DEPTHPREPASS) && defined(ALPHATEST) && defined(ALPHATEST_AFTERALLALPHACOMPUTATIONS)
>     if (alpha < alphaCutOff) discard;
> #endif
> ```
>
> Caveat: at that point `alpha` includes the diffuse-texture alpha but not contributions applied later (for example an opacity texture), so a complete fix would compute alpha fully before the prepass exit. We're working around it with a small material plugin that injects the test above at `CUSTOM_FRAGMENT_UPDATE_ALPHA`, and would be glad to open a PR if you tell us which shape you prefer.

## Playground snippet (ES module)

For the current Playground's ES-module mode. The entry file exports
`createScene`, which the Playground calls as `createScene(engine, canvas)`
(it also accepts a default export or a `Playground` class with a static
`CreateScene`). Bare `@babylonjs/core` imports resolve to the Playground's own
Babylon build. Switch the engine between WebGL2 and WebGPU to see the same
result on both.

```js
import {
    Color3,
    Color4,
    DynamicTexture,
    FreeCamera,
    HemisphericLight,
    Material,
    MeshBuilder,
    Scene,
    StandardMaterial,
    Vector3,
} from "@babylonjs/core";

export const createScene = (engine, canvas) => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.1, 0.1, 0.15, 1);

    const camera = new FreeCamera("cam", new Vector3(0, 0, -4), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(canvas, true);
    new HemisphericLight("light", new Vector3(0, 1, -1), scene);

    // Behind: an opaque red wall, drawn after the quad.
    const wall = MeshBuilder.CreatePlane("wall", { size: 3 }, scene);
    wall.position.z = 1;
    const wallMat = new StandardMaterial("wallMat", scene);
    wallMat.diffuseColor = new Color3(1, 0.1, 0.1);
    wallMat.emissiveColor = new Color3(0.6, 0.05, 0.05);
    wall.material = wallMat;
    wall.renderingGroupId = 1;
    scene.setRenderingAutoClearDepthStencil(1, false);

    // In front: an alpha-tested quad (a green disc on a transparent square).
    const tex = new DynamicTexture("disc", { width: 256, height: 256 }, scene, true);
    const g = tex.getContext();
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = "#2c2";
    g.beginPath();
    g.arc(128, 128, 90, 0, Math.PI * 2);
    g.fill();
    tex.update();
    tex.hasAlpha = true;

    const quad = MeshBuilder.CreatePlane("quad", { size: 2 }, scene);
    const mat = new StandardMaterial("quadMat", scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.transparencyMode = Material.MATERIAL_ALPHATEST;
    mat.alphaCutOff = 0.5;
    mat.needDepthPrePass = true; // set false: the red wall shows around the disc, as expected
    quad.material = mat;
    quad.renderingGroupId = 0;

    return scene;
};
```

In a TypeScript playground, type the parameters:
`export const createScene = (engine: AbstractEngine, canvas: HTMLCanvasElement) => { … }`
and add `AbstractEngine` to the import (as `import type`).

**Expected:** the red wall visible all around the green disc.
**Actual (with `needDepthPrePass = true`):** a square hole, the quad's transparent area, cut through the wall.

## Measured (local repro, pixel in the quad's transparent corner)

| Backend | prepass off | prepass on | prepass on + fix |
|---|---|---|---|
| WebGL2 / GLSL | wall (255, 44, 44) | **hole (25, 25, 38)** | wall (255, 44, 44) |
| WebGPU / WGSL | wall (255, 44, 44) | **hole (25, 25, 38)** | wall (255, 44, 44) |

The green disc is identical in all six cases.

## Before posting

- Save the snippet to the Playground and put the link in the post.
- Re-check against the latest Babylon release. The line references are from 9.17.1.
- Allen decides whether and when this goes out. Our earlier atmosphere suggestion is still unanswered, and this one is smaller and clearly a bug.
