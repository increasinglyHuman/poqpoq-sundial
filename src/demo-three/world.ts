import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// A three.js port of src/demo/world.ts: the same procedural stand-in for a
// poqpoq sim (256 m of terrain at World's triangle count, a forest of
// instanced trees with alpha-tested leaf cards, a prim village, and things
// that move), built with the SAME numbers (heightAt, seeds, counts, sizes)
// as the Babylon lab so the two show the same world.
//
// Handedness: Babylon is left-handed, three is right-handed. Every position
// and rotation below uses EXACTLY the same (x, y, z) values Babylon's
// world.ts uses (same heightAt(x, z), same instance matrices) — nothing here
// is mirrored. The caller (main.ts) parents the returned `group` under a
// container with `scale.z = -1`; three's renderer auto-corrects triangle
// winding for a negatively-scaled object (it flips front-face order whenever
// `object.matrixWorld.determinantAffine() < 0`), so geometry built with
// Babylon's own numbers renders with correct-facing normals once mirrored.
// The camera (main.ts) negates the Z of its position/target the same way, so
// the same `cam=` string used against the Babylon lab looks at the same
// content from the same relative viewpoint.

export const SIM = 256;

export interface DemoWorld {
  /** Parent everything is added under; main.ts mirrors this (scale.z = -1). */
  group: THREE.Group;
  terrain: THREE.Mesh;
  trunks: THREE.InstancedMesh;
  leaves: THREE.InstancedMesh;
  leafMask: HTMLCanvasElement;
  prims: THREE.Mesh[];
  movers: { mesh: THREE.Mesh; update(t: number): void }[];
  materials: THREE.Material[];
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

/** A tree's leaves: a few dozen crossed cards around a crown, one BufferGeometry. */
function leafGeometry(): THREE.BufferGeometry {
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
    const axx = Math.cos(rot) * size, axy = 0, axz = Math.sin(rot) * size;
    const ayx = -Math.sin(rot) * Math.sin(tilt) * size, ayy = Math.cos(tilt) * size, ayz = Math.cos(rot) * Math.sin(tilt) * size;
    // n = normalize(cross(ax, ay))
    let nx = axy * ayz - axz * ayy;
    let ny = axz * ayx - axx * ayz;
    let nz = axx * ayy - axy * ayx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const base = pos.length / 3;
    const corners: [number, number, number, number][] = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
    for (const [sx, sy, u, v] of corners) {
      pos.push(cx + axx * sx + ayx * sy, cy + axy * sx + ayy * sy, cz + axz * sx + ayz * sy);
      nrm.push(nx, ny, nz);
      uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

const UP = new THREE.Vector3(0, 1, 0);

export function buildWorld(treeCount: number): DemoWorld {
  const group = new THREE.Group();
  group.name = "world";
  const materials: THREE.Material[] = [];

  // Terrain: 256 x 256 quads = 131k triangles, the size of World's terrain.
  const terrainGeo = new THREE.PlaneGeometry(SIM, SIM, 256, 256).rotateX(-Math.PI / 2);
  const tp = terrainGeo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < tp.count; i++) tp.setY(i, heightAt(tp.getX(i), tp.getZ(i)));
  tp.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  const grassCanvas = document.createElement("canvas");
  grassCanvas.width = grassCanvas.height = 512;
  {
    const g = grassCanvas.getContext("2d")!;
    const r = rng(3);
    g.fillStyle = "#5d7a3a";
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(${70 + r() * 60}, ${100 + r() * 60}, ${40 + r() * 30}, 0.5)`;
      g.fillRect(r() * 512, r() * 512, 2, 3);
    }
  }
  const grassTex = new THREE.CanvasTexture(grassCanvas);
  grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
  grassTex.repeat.set(48, 48);
  grassTex.colorSpace = THREE.SRGBColorSpace;
  const terrainMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.95, metalness: 0 });
  materials.push(terrainMat);
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  terrain.matrixAutoUpdate = false;
  terrain.updateMatrix();
  group.add(terrain);

  // Forest.
  const barkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.36, 0.26, 0.18), roughness: 0.97, metalness: 0 });
  materials.push(barkMat);
  const trunkGeo = new THREE.CylinderGeometry(0.25 / 2, 0.55 / 2, 6, 8).translate(0, 3, 0);

  const leafMask = leafCanvas();
  const leafTex = new THREE.CanvasTexture(leafMask);
  leafTex.colorSpace = THREE.SRGBColorSpace;
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafTex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });
  materials.push(leafMat);
  const leafGeo = leafGeometry();

  const trunks = new THREE.InstancedMesh(trunkGeo, barkMat, treeCount);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, treeCount);
  trunks.receiveShadow = true;
  leaves.receiveShadow = true;

  const r = rng(42);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const t = new THREE.Vector3();
  let placed = 0;
  while (placed < treeCount) {
    const x = (r() - 0.5) * (SIM - 8);
    const z = (r() - 0.5) * (SIM - 8);
    if (Math.abs(x + 20) < 34 && Math.abs(z - 10) < 30) continue; // clearing for the village
    const scale = 0.7 + r() * 0.7;
    s.set(scale, scale * (0.85 + r() * 0.3), scale);
    q.setFromAxisAngle(UP, r() * Math.PI * 2);
    t.set(x, heightAt(x, z) - 0.2, z);
    m.compose(t, q, s);
    trunks.setMatrixAt(placed, m);
    leaves.setMatrixAt(placed, m);
    placed++;
  }
  trunks.instanceMatrix.needsUpdate = true;
  leaves.instanceMatrix.needsUpdate = true;
  trunks.matrixAutoUpdate = false;
  trunks.updateMatrix();
  leaves.matrixAutoUpdate = false;
  leaves.updateMatrix();
  group.add(trunks, leaves);

  // Prim village: the kind of content OAR imports are made of.
  const stoneMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.72, 0.68, 0.6), metalness: 0, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.55, 0.22, 0.16), metalness: 0, roughness: 0.6 });
  materials.push(stoneMat, roofMat);
  const prims: THREE.Mesh[] = [];
  const addPrim = (mesh: THREE.Mesh) => {
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    prims.push(mesh);
    group.add(mesh);
  };
  const vr = rng(5);
  for (let i = 0; i < 26; i++) {
    const x = -20 + (vr() - 0.5) * 56;
    const z = 10 + (vr() - 0.5) * 48;
    const w = 3 + vr() * 5;
    const d = 3 + vr() * 5;
    const h = 3 + vr() * 7;
    const y = heightAt(x, z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stoneMat);
    body.position.set(x, y + h / 2 - 0.3, z);
    body.rotation.y = vr() * Math.PI;
    body.name = `house${i}`;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0, (Math.max(w, d) * 1.35) / 2, 2.8, 4), roofMat);
    top.position.set(x, y + h + 0.95, z);
    top.rotation.y = body.rotation.y + Math.PI / 4;
    top.name = `roof${i}`;
    addPrim(body);
    addPrim(top);
  }
  // A tower and an arch: long thin shadows at low sun.
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 28, 16), stoneMat);
  tower.position.set(-24, heightAt(-24, 30) + 14, 30);
  tower.name = "tower";
  addPrim(tower);
  for (let i = 0; i < 9; i++) {
    const a = (i / 8) * Math.PI;
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 2), stoneMat);
    block.position.set(4 + Math.cos(a) * 6, heightAt(4, -4) + Math.sin(a) * 6 + 0.4, -4);
    block.rotation.z = a;
    block.name = `arch${i}`;
    addPrim(block);
  }
  // A fence of thin posts: tests fine-level sharpness.
  for (let i = 0; i < 30; i++) {
    const x = -44 + i * 1.6;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), stoneMat);
    post.position.set(x, heightAt(x, -18) + 0.6, -18);
    post.name = `post${i}`;
    addPrim(post);
  }

  // Movers: an avatar walking a loop and a windmill turning.
  const movers: DemoWorld["movers"] = [];
  const skinMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.25, 0.35, 0.8), metalness: 0, roughness: 0.5 });
  materials.push(skinMat);
  // Babylon's CreateCapsule height is pole-to-pole; three's CapsuleGeometry
  // height is the cylindrical midsection only (total = height + 2 * radius).
  const avatar = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.8 - 2 * 0.32, 4, 8), skinMat);
  avatar.receiveShadow = true;
  group.add(avatar);
  movers.push({
    mesh: avatar,
    update(tSec) {
      const a = tSec * 0.25;
      const x = -20 + Math.cos(a) * 14;
      const z = 10 + Math.sin(a) * 10;
      avatar.position.set(x, heightAt(x, z) + 0.9, z);
      avatar.updateMatrix();
    },
  });
  const blades1 = new THREE.BoxGeometry(14, 1, 0.2);
  const blades2 = new THREE.BoxGeometry(1, 14, 0.2);
  const bladeGeo = mergeGeometries([blades1, blades2], false)!;
  const bladeMesh = new THREE.Mesh(bladeGeo, stoneMat);
  bladeMesh.name = "windmill";
  bladeMesh.receiveShadow = true;
  group.add(bladeMesh);
  const mill = new THREE.Mesh(new THREE.CylinderGeometry(1.5 / 2, 3 / 2, 12, 12), stoneMat);
  const mx = 18;
  const mz = 24;
  mill.position.set(mx, heightAt(mx, mz) + 6, mz);
  mill.name = "millTower";
  addPrim(mill);
  movers.push({
    mesh: bladeMesh,
    update(tSec) {
      bladeMesh.position.set(mx, heightAt(mx, mz) + 11.5, mz - 1.8);
      bladeMesh.rotation.z = tSec * 0.6;
      bladeMesh.updateMatrix();
    },
  });

  return { group, terrain, trunks, leaves, leafMask, prims, movers, materials, heightAt };
}
