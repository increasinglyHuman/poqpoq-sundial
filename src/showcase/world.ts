import * as THREE from "three/webgpu";

// The showcase's world: 256 m of terrain, a forest of alpha-tested leaf cards,
// a cobbled village in a clearing and a dirt road leading from it into the
// forest. Everything is procedural and seeded, so every visitor sees the same
// scene. (A fork of the lab's world, src/demo-three/world.ts, which stays
// unchanged as the benchmark scene.)
//
// Coordinates are three's own: y up, the village square at the origin.

export const SIM = 256;

export function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

// ---- roads -------------------------------------------------------------------------
/** The village street, west to east, through the square at the origin. */
export const STREET: [number, number][] = [[-38, 3], [-26, -1], [-13, 1.5], [0, 0], [13, -2], [25, 0.5], [38, -1]];
/** The dirt road from the street's west end into the forest. */
export const FOREST_ROAD: [number, number][] = [[-38, 3], [-52, 7], [-66, 5], [-80, -2], [-95, -5], [-110, 0], [-126, 5]];
/** The lane from the square up to the windmill. */
export const MILL_LANE: [number, number][] = [[0, 0], [5, -12], [12, -24], [20, -33]];
export const SQUARE_RADIUS = 9.5;
export const CLEARING = { x: 0, z: -5, rx: 46, rz: 38 };

/** Distance from (x, z) to a polyline, and the closest point's segment direction. */
export function polylineDistance(line: [number, number][], x: number, z: number): { d: number; dx: number; dz: number } {
  let best = Infinity;
  let bdx = 1, bdz = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i];
    const [bx, bz] = line[i + 1];
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2));
    const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
    if (d < best) {
      best = d;
      const l = Math.sqrt(len2);
      bdx = ex / l;
      bdz = ez / l;
    }
  }
  return { d: best, dx: bdx, dz: bdz };
}

/** Samples a polyline at arc length s (clamped), returning point and direction. */
export function polylineAt(line: [number, number][], s: number): { x: number; z: number; dx: number; dz: number } {
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i];
    const [bx, bz] = line[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    if (s <= l || i + 2 === line.length) {
      const t = Math.min(1, Math.max(0, s / l));
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: (bx - ax) / l, dz: (bz - az) / l };
    }
    s -= l;
  }
  return { x: line[0][0], z: line[0][1], dx: 1, dz: 0 };
}

export function polylineLength(line: [number, number][]): number {
  let s = 0;
  for (let i = 0; i + 1 < line.length; i++) s += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  return s;
}

/** 0 outside the clearing, 1 well inside it. */
export function clearingFactor(x: number, z: number): number {
  const e = Math.hypot((x - CLEARING.x) / CLEARING.rx, (z - CLEARING.z) / CLEARING.rz);
  return 1 - smoothstep(0.8, 1.05, e);
}

export function roadDistance(x: number, z: number): number {
  return Math.min(polylineDistance(FOREST_ROAD, x, z).d, polylineDistance(STREET, x, z).d, polylineDistance(MILL_LANE, x, z).d);
}

// ---- terrain -------------------------------------------------------------------------
const rolling = (x: number, z: number) => 5 * Math.sin((x / SIM) * 5.1 + 0.7) * Math.cos((z / SIM) * 4.3 - 0.4);
const bumps = (x: number, z: number) => {
  const u = x / SIM, v = z / SIM;
  return 2.2 * Math.sin(u * 13.7 + v * 9.1) + 0.7 * Math.cos(u * 31.0 - v * 27.0);
};

/** Terrain height: rolling hills, smoothed in the village and along the roads. */
export function heightAt(x: number, z: number): number {
  const flat = Math.max(clearingFactor(x, z), 1 - smoothstep(3, 9, roadDistance(x, z)));
  return rolling(x, z) + bumps(x, z) * (1 - 0.92 * flat);
}

function grassCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  const r = rng(3);
  g.fillStyle = "#6f8f3e";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 14000; i++) {
    const k = r();
    g.fillStyle = k < 0.15 ? `rgba(${150 + r() * 40}, ${140 + r() * 30}, ${60 + r() * 30}, 0.5)` : `rgba(${70 + r() * 60}, ${110 + r() * 60}, ${35 + r() * 30}, 0.55)`;
    g.fillRect(r() * 512, r() * 512, 1.5 + r() * 1.5, 2 + r() * 3);
  }
  return c;
}

function leafCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const r = rng(7);
  for (let i = 0; i < 80; i++) {
    const x = 20 + r() * 216;
    const y = 20 + r() * 216;
    const s = 9 + r() * 15;
    g.save();
    g.translate(x, y);
    g.rotate(r() * Math.PI);
    const warm = r();
    g.fillStyle = warm < 0.2
      ? `rgb(${130 + r() * 50}, ${150 + r() * 40}, ${40 + r() * 20})`
      : `rgb(${50 + r() * 40}, ${115 + r() * 60}, ${30 + r() * 25})`;
    g.beginPath();
    g.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2);
    g.fill();
    // A midrib: a little structure inside each leaf.
    g.strokeStyle = "rgba(20, 40, 10, 0.35)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-s * 0.8, 0);
    g.lineTo(s * 0.8, 0);
    g.stroke();
    g.restore();
  }
  return c;
}

/** A tree's leaves: crossed cards around a crown, one BufferGeometry. */
function leafGeometry(): THREE.BufferGeometry {
  const r = rng(11);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < 32; i++) {
    const cy = 4.5 + r() * 4.5;
    const rad = (1 - Math.abs(cy - 6.5) / 3.5) * 2.8 + 0.4;
    const ang = r() * Math.PI * 2;
    const cx = Math.cos(ang) * rad * r();
    const cz = Math.sin(ang) * rad * r();
    const size = 1.4 + r() * 0.9;
    const rot = r() * Math.PI;
    const tilt = (r() - 0.5) * 1.2;
    const ax = new THREE.Vector3(Math.cos(rot) * size, 0, Math.sin(rot) * size);
    const ay = new THREE.Vector3(-Math.sin(rot) * Math.sin(tilt) * size, Math.cos(tilt) * size, Math.cos(rot) * Math.sin(tilt) * size);
    // Normals lean outwards from the crown, so the canopy shades like a volume.
    const n = new THREE.Vector3().crossVectors(ax, ay).normalize();
    const out = new THREE.Vector3(cx, cy - 6.5, cz).normalize();
    if (n.dot(out) < 0) n.negate();
    n.lerp(out, 0.6).normalize();
    const base = pos.length / 3;
    for (const [sx, sy, u, v] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) {
      pos.push(cx + ax.x * sx + ay.x * sy, cy + ax.y * sx + ay.y * sy, cz + ax.z * sx + ay.z * sy);
      nrm.push(n.x, n.y, n.z);
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

export interface ShowcaseWorld {
  group: THREE.Group;
  terrain: THREE.Mesh;
  trunks: THREE.InstancedMesh;
  leaves: THREE.InstancedMesh;
  leafMask: HTMLCanvasElement;
}

const UP = new THREE.Vector3(0, 1, 0);

export function buildWorld(treeCount: number): ShowcaseWorld {
  const group = new THREE.Group();
  group.name = "world";

  // Terrain: 256 x 256 quads, vertex-tinted: dirt on the roads, earthier under the forest.
  const terrainGeo = new THREE.PlaneGeometry(SIM, SIM, 256, 256).rotateX(-Math.PI / 2);
  const tp = terrainGeo.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(tp.count * 3);
  const grass = new THREE.Color(1, 1, 1);
  // Tints multiply the green grass texture, so they lean away from green.
  const forestFloor = new THREE.Color().setRGB(1.25, 0.82, 1.1, THREE.LinearSRGBColorSpace);
  const dirt = new THREE.Color().setRGB(2.0, 0.95, 2.6, THREE.LinearSRGBColorSpace);
  const cobbleBed = new THREE.Color().setRGB(1.2, 0.65, 2.2, THREE.LinearSRGBColorSpace);
  const tint = new THREE.Color();
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i), z = tp.getZ(i);
    tp.setY(i, heightAt(x, z));
    const clear = clearingFactor(x, z);
    const patch = 0.5 + 0.5 * Math.sin(x * 0.11 + Math.cos(z * 0.07) * 2) * Math.cos(z * 0.09 - x * 0.03);
    tint.copy(grass).lerp(forestFloor, (1 - clear) * (0.35 + 0.35 * patch));
    const road = Math.min(polylineDistance(FOREST_ROAD, x, z).d, polylineDistance(MILL_LANE, x, z).d);
    tint.lerp(dirt, 1 - smoothstep(1.4, 2.8, road + 0.4 * Math.sin(x * 1.7 + z * 2.3)));
    const street = Math.min(polylineDistance(STREET, x, z).d - 2.6, Math.hypot(x, z) - SQUARE_RADIUS);
    tint.lerp(cobbleBed, 1 - smoothstep(-0.2, 0.8, street));
    colors.set([tint.r, tint.g, tint.b], i * 3);
  }
  terrainGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  tp.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  const grassTex = new THREE.CanvasTexture(grassCanvas());
  grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
  grassTex.repeat.set(56, 56);
  grassTex.colorSpace = THREE.SRGBColorSpace;
  grassTex.anisotropy = 8;
  const terrainMat = new THREE.MeshStandardMaterial({ map: grassTex, vertexColors: true, roughness: 0.95, metalness: 0 });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.name = "terrain";
  terrain.receiveShadow = true;
  group.add(terrain);

  // Forest: trunks and leaf cards, one InstancedMesh each; a per-tree leaf tint.
  const barkMat = new THREE.MeshStandardMaterial({ color: "#5a4332", roughness: 0.97, metalness: 0 });
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.3, 6, 8).translate(0, 3, 0);
  const leafMask = leafCanvas();
  const leafTex = new THREE.CanvasTexture(leafMask);
  leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.anisotropy = 4;
  // Lambert: the canopy is most of the fill on screen, and leaves need no specular.
  const leafMat = new THREE.MeshLambertMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide });
  const trunks = new THREE.InstancedMesh(trunkGeo, barkMat, treeCount);
  const leaves = new THREE.InstancedMesh(leafGeometry(), leafMat, treeCount);
  trunks.name = "trunks";
  leaves.name = "leaves";
  trunks.receiveShadow = leaves.receiveShadow = true;

  const r = rng(42);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const t = new THREE.Vector3();
  const c = new THREE.Color();
  const leafTints = ["#ffffff", "#f2ffd9", "#e6f0c8", "#fff0c2", "#d9ecd0"].map((h) => new THREE.Color(h));
  let placed = 0;
  let guard = 0;
  while (placed < treeCount && guard++ < treeCount * 20) {
    const x = (r() - 0.5) * (SIM - 8);
    const z = (r() - 0.5) * (SIM - 8);
    const scale = 0.75 + r() * 0.7;
    const tint = leafTints[Math.floor(r() * leafTints.length)];
    const yaw = r() * Math.PI * 2;
    const stretch = 0.85 + r() * 0.3;
    if (clearingFactor(x, z) > 0.15 || roadDistance(x, z) < 3.3) continue;
    s.set(scale, scale * stretch, scale);
    q.setFromAxisAngle(UP, yaw);
    t.set(x, heightAt(x, z) - 0.2, z);
    m.compose(t, q, s);
    trunks.setMatrixAt(placed, m);
    leaves.setMatrixAt(placed, m);
    leaves.setColorAt(placed, c.copy(tint));
    placed++;
  }
  trunks.count = leaves.count = placed;
  trunks.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  group.add(trunks, leaves);

  for (const o of [terrain, trunks, leaves]) {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  }
  return { group, terrain, trunks, leaves, leafMask };
}
