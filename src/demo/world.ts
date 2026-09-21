import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

// A procedural stand-in for a poqpoq sim: 256 m of terrain at World's
// triangle count, a forest of thin-instanced trees with alpha-tested leaf
// cards (the integrated-GPU worst case), a prim village, and things that move.

export const SIM = 256;

export interface DemoWorld {
  terrain: Mesh;
  trunks: Mesh;
  leaves: Mesh;
  leafMask: HTMLCanvasElement;
  prims: Mesh[];
  movers: { mesh: Mesh; update(t: number): void }[];
  materials: Material[];
  heightAt(x: number, z: number): number;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function heightAt(x: number, z: number): number {
  const u = x / SIM;
  const v = z / SIM;
  return (
    6 * Math.sin(u * 5.1 + 0.7) * Math.cos(v * 4.3 - 0.4) +
    2.5 * Math.sin(u * 13.7 + v * 9.1) +
    0.8 * Math.cos(u * 31.0 - v * 27.0) +
    9 * Math.max(0, (Math.hypot(u - 0.8, v - 0.2) < 0.18 ? 1 - Math.hypot(u - 0.8, v - 0.2) / 0.18 : 0)) ** 2
  );
}

function leafCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 256, 256);
  const r = rng(7);
  for (let i = 0; i < 70; i++) {
    const x = 20 + r() * 216;
    const y = 20 + r() * 216;
    const s = 10 + r() * 16;
    const a = r() * Math.PI;
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillStyle = `rgb(${40 + r() * 40}, ${110 + r() * 70}, ${30 + r() * 30})`;
    g.beginPath();
    g.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  return c;
}

/** A tree's leaves: a few dozen crossed cards around a crown, merged into one mesh. */
function leafGeometry(scene: Scene): Mesh {
  const r = rng(11);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < 36; i++) {
    const cy = 4.5 + r() * 4.5;
    const rad = (1 - Math.abs(cy - 6.5) / 3.5) * 2.6 + 0.4;
    const ang = r() * Math.PI * 2;
    const cx = Math.cos(ang) * rad * r();
    const cz = Math.sin(ang) * rad * r();
    const size = 1.3 + r() * 0.9;
    const rot = r() * Math.PI;
    const tilt = (r() - 0.5) * 1.2;
    const ax = new Vector3(Math.cos(rot), 0, Math.sin(rot)).scale(size);
    const ay = new Vector3(-Math.sin(rot) * Math.sin(tilt), Math.cos(tilt), Math.cos(rot) * Math.sin(tilt)).scale(size);
    const n = Vector3.Cross(ax, ay).normalize();
    const base = pos.length / 3;
    const corners = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
    for (const [sx, sy, u, v] of corners) {
      pos.push(cx + ax.x * sx + ay.x * sy, cy + ax.y * sx + ay.y * sy, cz + ax.z * sx + ay.z * sy);
      nrm.push(n.x, n.y, n.z);
      uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const mesh = new Mesh("leaves", scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nrm;
  vd.uvs = uv;
  vd.indices = idx;
  vd.applyToMesh(mesh);
  return mesh;
}

export function buildWorld(scene: Scene, treeCount: number): DemoWorld {
  const materials: Material[] = [];

  // Terrain: 256 x 256 quads = 131k triangles, the size of World's terrain.
  const terrain = MeshBuilder.CreateGround("terrain", { width: SIM, height: SIM, subdivisions: 256, updatable: true }, scene);
  const tp = terrain.getVerticesData("position")!;
  for (let i = 0; i < tp.length; i += 3) tp[i + 1] = heightAt(tp[i], tp[i + 2]);
  terrain.updateVerticesData("position", tp);
  const tn: number[] = [];
  VertexData.ComputeNormals(tp, terrain.getIndices()!, tn);
  terrain.updateVerticesData("normal", tn);
  const terrainMat = new StandardMaterial("terrainMat", scene);
  const grass = new DynamicTexture("grass", { width: 512, height: 512 }, scene, true);
  {
    const g = grass.getContext() as CanvasRenderingContext2D;
    const r = rng(3);
    g.fillStyle = "#5d7a3a";
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(${70 + r() * 60}, ${100 + r() * 60}, ${40 + r() * 30}, 0.5)`;
      g.fillRect(r() * 512, r() * 512, 2, 3);
    }
    grass.update();
  }
  grass.uScale = grass.vScale = 48;
  terrainMat.diffuseTexture = grass;
  terrainMat.specularColor = new Color3(0.05, 0.05, 0.05);
  terrain.material = terrainMat;
  terrain.receiveShadows = true;
  materials.push(terrainMat);

  // Forest.
  const bark = new StandardMaterial("bark", scene);
  bark.diffuseColor = new Color3(0.36, 0.26, 0.18);
  bark.specularColor = new Color3(0.02, 0.02, 0.02);
  const trunks = MeshBuilder.CreateCylinder("trunk", { height: 6, diameterTop: 0.25, diameterBottom: 0.55, tessellation: 8 }, scene);
  trunks.bakeTransformIntoVertices(Matrix.Translation(0, 3, 0));
  trunks.material = bark;
  trunks.receiveShadows = true;
  materials.push(bark);

  const leafMask = leafCanvas();
  const leafTex = new DynamicTexture("leafTex", { width: 256, height: 256 }, scene, true);
  (leafTex.getContext() as CanvasRenderingContext2D).drawImage(leafMask, 0, 0);
  leafTex.update();
  leafTex.hasAlpha = true;
  const leafMat = new StandardMaterial("leafMat", scene);
  leafMat.diffuseTexture = leafTex;
  leafMat.useAlphaFromDiffuseTexture = true;
  leafMat.transparencyMode = Material.MATERIAL_ALPHATEST;
  leafMat.alphaCutOff = 0.5;
  leafMat.backFaceCulling = false;
  leafMat.twoSidedLighting = true;
  leafMat.specularColor = new Color3(0.03, 0.05, 0.02);
  const leaves = leafGeometry(scene);
  leaves.material = leafMat;
  leaves.receiveShadows = true;
  materials.push(leafMat);

  const r = rng(42);
  const trunkM = new Float32Array(treeCount * 16);
  let placed = 0;
  while (placed < treeCount) {
    const x = (r() - 0.5) * (SIM - 8);
    const z = (r() - 0.5) * (SIM - 8);
    if (Math.abs(x + 20) < 34 && Math.abs(z - 10) < 30) continue; // clearing for the village
    const s = 0.7 + r() * 0.7;
    const m = Matrix.Compose(
      new Vector3(s, s * (0.85 + r() * 0.3), s),
      Quaternion.RotationYawPitchRoll(r() * Math.PI * 2, 0, 0),
      new Vector3(x, heightAt(x, z) - 0.2, z),
    );
    trunkM.set(m.m, placed * 16);
    placed++;
  }
  trunks.thinInstanceSetBuffer("matrix", trunkM, 16, true);
  leaves.thinInstanceSetBuffer("matrix", new Float32Array(trunkM), 16, true);

  // Prim village: the kind of content OAR imports are made of.
  const stone = new PBRMaterial("stone", scene);
  stone.albedoColor = new Color3(0.72, 0.68, 0.6);
  stone.metallic = 0;
  stone.roughness = 0.85;
  const roof = new PBRMaterial("roof", scene);
  roof.albedoColor = new Color3(0.55, 0.22, 0.16);
  roof.metallic = 0;
  roof.roughness = 0.6;
  materials.push(stone, roof);
  const prims: Mesh[] = [];
  const vr = rng(5);
  for (let i = 0; i < 26; i++) {
    const x = -20 + (vr() - 0.5) * 56;
    const z = 10 + (vr() - 0.5) * 48;
    const w = 3 + vr() * 5;
    const d = 3 + vr() * 5;
    const h = 3 + vr() * 7;
    const y = heightAt(x, z);
    const body = MeshBuilder.CreateBox(`house${i}`, { width: w, depth: d, height: h }, scene);
    body.position.set(x, y + h / 2 - 0.3, z);
    body.rotation.y = vr() * Math.PI;
    body.material = stone;
    const top = MeshBuilder.CreateCylinder(`roof${i}`, { diameterTop: 0, diameterBottom: Math.max(w, d) * 1.35, height: 2.8, tessellation: 4 }, scene);
    top.position.set(x, y + h + 0.95, z);
    top.rotation.y = body.rotation.y + Math.PI / 4;
    top.material = roof;
    prims.push(body, top);
  }
  // A tower and an arch: long thin shadows at low sun.
  const tower = MeshBuilder.CreateCylinder("tower", { diameter: 5, height: 28, tessellation: 16 }, scene);
  tower.position.set(-24, heightAt(-24, 30) + 14, 30);
  tower.material = stone;
  prims.push(tower);
  for (let i = 0; i < 9; i++) {
    const a = (i / 8) * Math.PI;
    const block = MeshBuilder.CreateBox(`arch${i}`, { width: 1.4, height: 1.4, depth: 2 }, scene);
    block.position.set(4 + Math.cos(a) * 6, heightAt(4, -4) + Math.sin(a) * 6 + 0.4, -4);
    block.rotation.z = a;
    block.material = stone;
    prims.push(block);
  }
  // A fence of thin posts: tests fine-level sharpness.
  for (let i = 0; i < 30; i++) {
    const x = -44 + i * 1.6;
    const post = MeshBuilder.CreateBox(`post${i}`, { width: 0.12, height: 1.4, depth: 0.12 }, scene);
    post.position.set(x, heightAt(x, -18) + 0.6, -18);
    post.material = stone;
    prims.push(post);
  }
  for (const p of prims) {
    p.receiveShadows = true;
    p.freezeWorldMatrix();
  }

  // Movers: an avatar walking a loop and a windmill turning.
  const movers: DemoWorld["movers"] = [];
  const skin = new PBRMaterial("skin", scene);
  skin.albedoColor = new Color3(0.25, 0.35, 0.8);
  skin.metallic = 0;
  skin.roughness = 0.5;
  materials.push(skin);
  const avatar = MeshBuilder.CreateCapsule("avatar", { height: 1.8, radius: 0.32 }, scene);
  avatar.material = skin;
  avatar.receiveShadows = true;
  movers.push({
    mesh: avatar,
    update(t) {
      const a = t * 0.25;
      const x = -20 + Math.cos(a) * 14;
      const z = 10 + Math.sin(a) * 10;
      avatar.position.set(x, heightAt(x, z) + 0.9, z);
    },
  });
  const blades = MeshBuilder.CreateBox("blades", { width: 14, height: 1, depth: 0.2 }, scene);
  const blades2 = MeshBuilder.CreateBox("blades2", { width: 1, height: 14, depth: 0.2 }, scene);
  const bladeMesh = Mesh.MergeMeshes([blades, blades2], true)!;
  bladeMesh.name = "windmill";
  bladeMesh.material = stone;
  bladeMesh.receiveShadows = true;
  const mill = MeshBuilder.CreateCylinder("millTower", { diameterTop: 1.5, diameterBottom: 3, height: 12, tessellation: 12 }, scene);
  const mx = 18;
  const mz = 24;
  mill.position.set(mx, heightAt(mx, mz) + 6, mz);
  mill.material = stone;
  mill.receiveShadows = true;
  mill.freezeWorldMatrix();
  prims.push(mill);
  movers.push({
    mesh: bladeMesh,
    update(t) {
      bladeMesh.position.set(mx, heightAt(mx, mz) + 11.5, mz - 1.8);
      bladeMesh.rotation.z = t * 0.6;
    },
  });

  return { terrain, trunks, leaves, leafMask, prims, movers, materials, heightAt };
}
