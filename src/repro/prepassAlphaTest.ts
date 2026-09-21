// Minimal reproduction: StandardMaterial + transparencyMode = MATERIAL_ALPHATEST
// + needDepthPrePass writes whole-quad depth, so the transparent part of an
// alpha-tested quad hides whatever lies behind it.
//   ?engine=webgl2|webgpu   ?prepass=0|1   ?fix=0|1
import "@babylonjs/core";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DepthPrePassAlphaTestFix } from "../babylon/DepthPrePassAlphaTestFix";

const q = new URLSearchParams(location.search);
const useWebGPU = q.get("engine") === "webgpu";
const prepass = q.get("prepass") !== "0";
const fix = q.get("fix") === "1";

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  let engine: AbstractEngine;
  if (useWebGPU) {
    const e = new WebGPUEngine(canvas);
    await e.initAsync();
    engine = e;
  } else {
    engine = new Engine(canvas, true);
  }
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.1, 0.15, 1);
  const camera = new FreeCamera("cam", new Vector3(0, 0, -4), scene);
  camera.setTarget(Vector3.Zero());
  new HemisphericLight("light", new Vector3(0, 1, -1), scene);

  // Behind: an opaque red wall.
  const wall = MeshBuilder.CreatePlane("wall", { size: 3 }, scene);
  wall.position.z = 1;
  const wallMat = new StandardMaterial("wallMat", scene);
  wallMat.diffuseColor = new Color3(1, 0.1, 0.1);
  wallMat.emissiveColor = new Color3(0.6, 0.05, 0.05);
  wall.material = wallMat;

  // In front: an alpha-tested quad, a green disc on a transparent square.
  const tex = new DynamicTexture("disc", { width: 256, height: 256 }, scene, true);
  const g = tex.getContext() as CanvasRenderingContext2D;
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
  mat.needDepthPrePass = prepass;
  if (fix) new DepthPrePassAlphaTestFix(mat);
  quad.material = mat;
  // Draw the quad before the wall, as any alpha-tested foliage in front of
  // later-drawn geometry would be.
  quad.renderingGroupId = 0;
  wall.renderingGroupId = 1;
  scene.setRenderingAutoClearDepthStencil(1, false);

  document.getElementById("tag")!.textContent =
    `${useWebGPU ? "WebGPU/WGSL" : "WebGL2/GLSL"} · needDepthPrePass=${prepass} · fix=${fix}`;
  engine.runRenderLoop(() => scene.render());
  await scene.whenReadyAsync();
  (window as unknown as Record<string, unknown>).__ready = true;
}
main();
