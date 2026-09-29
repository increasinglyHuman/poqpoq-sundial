import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { heightAt, rng, STREET, MILL_LANE, SQUARE_RADIUS, polylineAt, polylineDistance, polylineLength } from "./world";

// A procedural storybook village: half-timbered houses with framed windows,
// shutters, flower boxes, door recesses, porches, awnings, chimneys and
// overhanging eaves, a cobbled street and square, a well, market stalls,
// fences, barrels, crates and lamp posts, a bell tower and a windmill. Lots of
// small, shadow-catching detail near the camera.
//
// Static parts are merged by material into three meshes (vertex colours carry
// the palette), and the cobbles are one InstancedMesh, so the whole village is
// a handful of draw calls. Movers (windmill sails, a cart, a swinging sign)
// are separate meshes.

type MatKey = "matte" | "glass" | "lamp";

const C = (hex: string) => new THREE.Color(hex);
const PAL = {
  plaster: ["#f1e2bf", "#e8c27c", "#eab9a6", "#c3d5df", "#f4efe2", "#d2dbb1", "#f0cf9a"].map(C),
  timber: C("#4a3222"),
  timberLight: C("#6e4a2f"),
  stone: C("#a39a8b"),
  stoneDark: C("#7d766b"),
  roof: ["#b4532f", "#8e3326", "#4d5663", "#3f6e6c", "#9a7a45", "#a8462b"].map(C),
  shutter: ["#3d6b5a", "#2f5c86", "#8c3a2e", "#c98a2c", "#5b7f3a"].map(C),
  door: ["#6b3f26", "#2f4f6b", "#7a2f2a", "#4f5f2f"].map(C),
  frame: C("#f2eadb"),
  wood: C("#8a5f36"),
  crate: C("#b08850"),
  iron: C("#2c2c30"),
  leaf: C("#4f7f35"),
  flowers: ["#d8413f", "#f0c238", "#e87fa8", "#f4f1ea", "#9b59c9"].map(C),
  canvas: ["#c0392b", "#2e6da4", "#d4a017", "#3c8a5a"].map(C),
  cream: C("#f3ead3"),
  water: C("#243c4a"),
};

// ---- geometry kit ------------------------------------------------------------------
const V = new THREE.Vector3();
const Q = new THREE.Quaternion();
const S = new THREE.Vector3();
const E = new THREE.Euler();
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
UNIT_BOX.deleteAttribute("uv");

/** Local transform: translate, rotate (Y then X then Z), scale. */
function local(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, ry = 0, rx = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(V.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz, "YXZ")), S.set(sx, sy, sz));
}

class Kit {
  private parts: Record<MatKey, THREE.BufferGeometry[]> = { matte: [], glass: [], lamp: [] };

  add(key: MatKey, geo: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.Color) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (g.getAttribute("uv")) g.deleteAttribute("uv");
    g.applyMatrix4(matrix);
    const n = g.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.parts[key].push(g);
  }

  /** A box of size (sx, sy, sz) centred at (x, y, z) in `base`'s space. */
  box(key: MatKey, color: THREE.Color, base: THREE.Matrix4, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0) {
    this.add(key, UNIT_BOX, new THREE.Matrix4().multiplyMatrices(base, local(x, y, z, sx, sy, sz, ry, rx, rz)), color);
  }

  cyl(key: MatKey, color: THREE.Color, base: THREE.Matrix4, x: number, y: number, z: number, rTop: number, rBot: number, h: number, seg: number, ry = 0, rx = 0, rz = 0) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
    this.add(key, g, new THREE.Matrix4().multiplyMatrices(base, local(x, y, z, 1, 1, 1, ry, rx, rz)), color);
    g.dispose();
  }

  blob(color: THREE.Color, base: THREE.Matrix4, x: number, y: number, z: number, r: number) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    this.add("matte", g, new THREE.Matrix4().multiplyMatrices(base, local(x, y, z)), color);
    g.dispose();
  }

  build(materials: Record<MatKey, THREE.Material>): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const key of Object.keys(this.parts) as MatKey[]) {
      if (!this.parts[key].length) continue;
      const merged = mergeGeometries(this.parts[key], false)!;
      for (const g of this.parts[key]) g.dispose();
      this.parts[key] = [];
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.name = `village.${key}`;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      out.push(mesh);
    }
    return out;
  }
}

/** The attic volume under a gable roof: a triangular prism, ridge along x. */
function gablePrism(w: number, d: number, rise: number): THREE.BufferGeometry {
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  const p = [
    x0, 0, z0, x0, 0, z1, x0, rise, 0, // -x end
    x1, 0, z0, x1, rise, 0, x1, 0, z1, // +x end
    x0, 0, z1, x1, 0, z1, x1, rise, 0, x0, 0, z1, x1, rise, 0, x0, rise, 0, // +z slope
    x0, 0, z0, x0, rise, 0, x1, rise, 0, x0, 0, z0, x1, rise, 0, x1, 0, z0, // -z slope
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** A gable roof over a w x d footprint at height y: attic, two slabs with eaves, a ridge cap. */
function gableRoof(kit: Kit, base: THREE.Matrix4, y: number, w: number, d: number, pitch: number, roof: THREE.Color, gable: THREE.Color) {
  const rise = (d / 2) * Math.tan(pitch);
  const attic = gablePrism(w, d, rise);
  kit.add("matte", attic, new THREE.Matrix4().multiplyMatrices(base, local(0, y, 0)), gable);
  attic.dispose();
  const eave = 0.6, verge = 0.4, th = 0.16;
  const run = d / 2 + eave;
  const len = run / Math.cos(pitch);
  for (const side of [1, -1]) {
    // Slab centre: half-way down the slope, lifted by half its thickness along its normal.
    const cz = side * (run / 2);
    const cy = y + rise - (run / 2) * Math.tan(pitch) + (th / 2) / Math.cos(pitch);
    kit.box("matte", roof, base, 0, cy, cz, w + 2 * verge, th, len, 0, side * pitch);
    // A fascia board along the eave: a crisp shadow line under the roof edge.
    kit.box("matte", PAL.timber, base, 0, y + rise - run * Math.tan(pitch) - 0.05, side * (run - 0.04), w + 2 * verge, 0.18, 0.06);
  }
  kit.box("matte", roof.clone().multiplyScalar(0.7), base, 0, y + rise + 0.12, 0, w + 2 * verge + 0.05, 0.14, 0.34);
  return rise;
}

interface HouseStyle {
  w: number; d: number; floors: number; jetty: number; pitch: number;
  plaster: THREE.Color; roof: THREE.Color; shutter: THREE.Color | null; door: THREE.Color;
  timbered: boolean; chimney: boolean; porch: "none" | "canopy" | "posts"; awning: THREE.Color | null; flowers: boolean;
}

/** A framed window with sill, optional shutters and flower box, in facade space (+z out of the wall). */
function window_(kit: Kit, f: THREE.Matrix4, cx: number, cy: number, ww: number, wh: number, s: HouseStyle, r: () => number) {
  kit.box("glass", PAL.water, f, cx, cy, 0, ww, wh, 0.08);
  const fr = s.timbered ? PAL.timber : PAL.frame;
  kit.box("matte", fr, f, cx, cy + wh / 2 + 0.06, 0.05, ww + 0.26, 0.13, 0.14);
  kit.box("matte", fr, f, cx, cy - wh / 2 - 0.06, 0.05, ww + 0.26, 0.13, 0.14);
  kit.box("matte", fr, f, cx - ww / 2 - 0.06, cy, 0.05, 0.13, wh, 0.14);
  kit.box("matte", fr, f, cx + ww / 2 + 0.06, cy, 0.05, 0.13, wh, 0.14);
  kit.box("matte", fr, f, cx, cy, 0.04, 0.05, wh, 0.06);
  kit.box("matte", fr, f, cx, cy + wh * 0.12, 0.04, ww, 0.05, 0.06);
  kit.box("matte", PAL.stone, f, cx, cy - wh / 2 - 0.16, 0.12, ww + 0.42, 0.08, 0.26);
  if (s.shutter) {
    for (const side of [-1, 1]) {
      const sx = cx + side * (ww / 2 + 0.14 + ww / 4);
      kit.box("matte", s.shutter, f, sx, cy, 0.05, ww / 2 + 0.02, wh, 0.05);
      // Louvre lines on the shutter.
      for (let k = 1; k < 5; k++) kit.box("matte", s.shutter.clone().multiplyScalar(0.7), f, sx, cy - wh / 2 + (k * wh) / 5, 0.085, ww / 2 - 0.06, 0.03, 0.03);
    }
  }
  if (s.flowers && r() < 0.7) {
    const by = cy - wh / 2 - 0.34;
    kit.box("matte", PAL.wood, f, cx, by, 0.2, ww + 0.1, 0.22, 0.24);
    const flower = PAL.flowers[Math.floor(r() * PAL.flowers.length)];
    for (let k = 0; k < 7; k++) {
      const fx = cx - ww / 2 + 0.08 + (k / 6) * (ww - 0.16);
      kit.blob(k % 2 ? PAL.leaf : flower, f, fx, by + 0.14 + r() * 0.06, 0.2 + (r() - 0.5) * 0.08, 0.09 + r() * 0.04);
    }
  }
}

/** A striped awning over (cx, top), sloping out from the wall. */
function awning(kit: Kit, f: THREE.Matrix4, cx: number, top: number, width: number, color: THREE.Color) {
  const stripes = Math.max(3, Math.round(width / 0.3));
  const sw = width / stripes;
  const depth = 1.3, slope = 0.42;
  for (let i = 0; i < stripes; i++) {
    const x = cx - width / 2 + (i + 0.5) * sw;
    const c = i % 2 ? PAL.cream : color;
    kit.box("matte", c, f, x, top - Math.sin(slope) * depth / 2, Math.cos(slope) * depth / 2, sw + 0.002, 0.04, depth, 0, slope);
    kit.box("matte", c, f, x, top - Math.sin(slope) * depth - 0.12, Math.cos(slope) * depth, sw + 0.002, 0.26, 0.03);
  }
  for (const side of [-1, 1]) kit.box("matte", PAL.iron, f, cx + side * (width / 2 - 0.05), top - Math.sin(slope) * depth / 2, Math.cos(slope) * depth / 2, 0.03, 0.03, depth + 0.1, 0, slope);
}

function house(kit: Kit, x: number, z: number, rotY: number, s: HouseStyle, r: () => number) {
  const base = new THREE.Matrix4().compose(V.set(x, 0, z), Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), S.set(1, 1, 1));
  // Ground under the footprint: the floor sits on the highest corner, the plinth reaches the lowest.
  const corners: number[] = [];
  const front = new THREE.Vector3(0, 0, s.d / 2 + 1.2).applyMatrix4(base);
  for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = new THREE.Vector3((cx * s.w) / 2, 0, (cz * s.d) / 2).applyMatrix4(base);
    corners.push(heightAt(p.x, p.z));
  }
  const lo = Math.min(...corners, heightAt(front.x, front.z));
  const y0 = Math.max(...corners) + 0.05;
  const plinthTop = y0 + 0.45;
  kit.box("matte", PAL.stone, base, 0, (lo - 0.3 + plinthTop) / 2, 0, s.w + 0.24, plinthTop - lo + 0.3, s.d + 0.24);

  const hs = 2.7;
  let top = y0;
  let W = s.w, D = s.d;
  for (let floor = 0; floor < s.floors; floor++) {
    if (floor > 0 && s.jetty > 0) {
      W += 2 * s.jetty;
      D += 2 * s.jetty;
    }
    kit.box("matte", s.plaster, base, 0, top + hs / 2, 0, W, hs, D);
    if (s.timbered) {
      for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) kit.box("matte", PAL.timber, base, (cx * (W - 0.14)) / 2, top + hs / 2, (cz * (D - 0.14)) / 2, 0.24, hs, 0.24);
      if (floor > 0) {
        // Braces at the corners of the upper storey's front and back.
        for (const fz of [1, -1]) for (const side of [-1, 1]) {
          kit.box("matte", PAL.timber, base, side * (W / 2 - 0.75), top + hs / 2, fz * (D / 2 + 0.03), 0.14, hs * 1.05, 0.08, 0, 0, side * 0.55);
        }
        // Mid-rail.
        kit.box("matte", PAL.timber, base, 0, top + 0.95, 0, W + 0.06, 0.12, D + 0.06);
      }
    }
    // The beam between storeys (and under the eaves): a shadow line all round.
    kit.box("matte", s.timbered ? PAL.timber : PAL.stoneDark, base, 0, top + hs - 0.08, 0, W + 0.1, 0.2, D + 0.1);
    if (floor > 0 && s.jetty > 0) {
      // Joist ends under the jetty.
      for (let jx = -W / 2 + 0.4; jx < W / 2 - 0.2; jx += 0.6) kit.box("matte", PAL.timber, base, jx, top + 0.06, D / 2 - s.jetty / 2, 0.12, 0.14, s.jetty + 0.1);
    }

    // Windows on all four facades.
    const facades: [THREE.Matrix4, number][] = [
      [new THREE.Matrix4().multiplyMatrices(base, local(0, 0, D / 2)), W],
      [new THREE.Matrix4().multiplyMatrices(base, local(0, 0, -D / 2, 1, 1, 1, Math.PI)), W],
      [new THREE.Matrix4().multiplyMatrices(base, local(W / 2, 0, 0, 1, 1, 1, Math.PI / 2)), D],
      [new THREE.Matrix4().multiplyMatrices(base, local(-W / 2, 0, 0, 1, 1, 1, -Math.PI / 2)), D],
    ];
    facades.forEach(([f, span], fi) => {
      const n = Math.max(1, Math.floor((span - 0.6) / 2.3));
      const wy = top + (floor === 0 ? 1.55 : 1.4);
      for (let i = 0; i < n; i++) {
        const wx = -span / 2 + ((i + 0.5) * span) / n;
        if (fi === 0 && floor === 0 && Math.abs(wx) < 1.1) continue; // the door
        if (fi >= 2 && n === 1 && floor === 0 && r() < 0.4) continue;
        window_(kit, f, wx, wy, 0.85, floor === 0 ? 1.2 : 1.05, s, r);
      }
      if (fi === 0 && floor === 0 && s.awning) awning(kit, f, n > 1 ? -span / 2 + (0.5 * span) / n : 0, top + 2.3, 1.8, s.awning);
    });
    top += hs;
  }

  // Door, recessed behind a deep frame, with a step down to the ground.
  const f = new THREE.Matrix4().multiplyMatrices(base, local(0, 0, s.d / 2));
  const dh = 2.05;
  kit.box("matte", s.door, f, 0, plinthTop + dh / 2, -0.02, 1.0, dh, 0.1);
  for (let k = -2; k <= 2; k++) kit.box("matte", s.door.clone().multiplyScalar(0.75), f, k * 0.2, plinthTop + dh / 2, 0.035, 0.03, dh - 0.1, 0.02);
  kit.box("matte", PAL.iron, f, 0.36, plinthTop + 1.0, 0.07, 0.06, 0.06, 0.08);
  kit.box("matte", PAL.timber, f, -0.6, plinthTop + dh / 2, 0.1, 0.2, dh + 0.1, 0.24);
  kit.box("matte", PAL.timber, f, 0.6, plinthTop + dh / 2, 0.1, 0.2, dh + 0.1, 0.24);
  kit.box("matte", PAL.timber, f, 0, plinthTop + dh + 0.12, 0.12, 1.5, 0.24, 0.3);
  kit.box("matte", PAL.stone, f, 0, (lo - 0.2 + plinthTop) / 2, 0.45, 1.5, plinthTop - lo + 0.2, 0.9);
  kit.box("matte", PAL.stone, f, 0, (lo - 0.2 + plinthTop - 0.22) / 2, 1.05, 1.7, plinthTop - 0.22 - lo + 0.2, 0.4);
  if (s.porch === "canopy") {
    kit.box("matte", s.roof, f, 0, plinthTop + dh + 0.55, 0.55, 1.9, 0.08, 1.2, 0, 0.3);
    for (const side of [-1, 1]) kit.box("matte", PAL.timber, f, side * 0.8, plinthTop + dh + 0.2, 0.35, 0.08, 0.08, 0.8, 0, -0.7);
  } else if (s.porch === "posts") {
    const py = plinthTop + dh + 0.5;
    kit.box("matte", s.roof, f, 0, py, 0.85, 2.3, 0.1, 1.8, 0, 0.22);
    for (const side of [-1, 1]) {
      kit.box("matte", PAL.timberLight, f, side * 1.0, (lo + py) / 2 - 0.1, 1.55, 0.14, py - lo - 0.2, 0.14);
    }
    kit.box("matte", PAL.timberLight, f, 0, py - 0.28, 1.55, 2.2, 0.12, 0.14);
  }

  // Roof, over the top storey's footprint.
  const rise = gableRoof(kit, base, top, W, D, s.pitch, s.roof, s.plaster);
  if (s.chimney) {
    const cx = (r() < 0.5 ? -1 : 1) * (W / 2 - 0.9);
    const cz = (r() < 0.5 ? -1 : 1) * D * 0.18;
    const ch = rise + 1.3;
    kit.box("matte", PAL.stoneDark, base, cx, top + ch / 2, cz, 0.7, ch, 0.7);
    kit.box("matte", PAL.stone, base, cx, top + ch + 0.06, cz, 0.9, 0.12, 0.9);
    kit.box("matte", PAL.iron, base, cx, top + ch + 0.22, cz, 0.3, 0.22, 0.3);
  }
  return { base, y0, lo };
}

// ---- props ---------------------------------------------------------------------------------
function barrel(kit: Kit, x: number, z: number, r: () => number, lying = false) {
  const y = heightAt(x, z);
  const base = local(x, y, z, 1, 1, 1, r() * Math.PI);
  if (lying) {
    kit.cyl("matte", PAL.wood, base, 0, 0.32, 0, 0.3, 0.3, 0.9, 12, 0, 0, Math.PI / 2);
    for (const hx of [-0.3, 0.3]) kit.cyl("matte", PAL.iron, base, hx, 0.32, 0, 0.315, 0.315, 0.05, 12, 0, 0, Math.PI / 2);
    return;
  }
  kit.cyl("matte", PAL.wood, base, 0, 0.45, 0, 0.3, 0.3, 0.9, 12);
  for (const hy of [0.15, 0.75]) kit.cyl("matte", PAL.iron, base, 0, hy, 0, 0.315, 0.315, 0.05, 12);
  kit.cyl("matte", PAL.timber, base, 0, 0.905, 0, 0.26, 0.26, 0.02, 12);
}

function crate(kit: Kit, x: number, y: number, z: number, size: number, ry: number) {
  const base = local(x, y, z, 1, 1, 1, ry);
  kit.box("matte", PAL.crate, base, 0, size / 2, 0, size, size, size);
  // Edge boards: every face gets a frame.
  const e = 0.06, h = size / 2;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) kit.box("matte", PAL.wood, base, sx * (h - e / 2 + 0.01), h, sz * (h - e / 2 + 0.01), e, size + 0.01, e);
  for (const yy of [e / 2, size - e / 2]) {
    kit.box("matte", PAL.wood, base, 0, yy, h - e / 2 + 0.01, size, e, e);
    kit.box("matte", PAL.wood, base, 0, yy, -h + e / 2 - 0.01, size, e, e);
    kit.box("matte", PAL.wood, base, h - e / 2 + 0.01, yy, 0, e, e, size);
    kit.box("matte", PAL.wood, base, -h + e / 2 - 0.01, yy, 0, e, e, size);
  }
}

function lampPost(kit: Kit, x: number, z: number, facing: number) {
  const y = heightAt(x, z);
  const base = local(x, y, z, 1, 1, 1, facing);
  kit.box("matte", PAL.stoneDark, base, 0, 0.15, 0, 0.36, 0.3, 0.36);
  kit.cyl("matte", PAL.iron, base, 0, 1.7, 0, 0.05, 0.08, 3.2, 8);
  kit.box("matte", PAL.iron, base, 0, 3.2, 0.3, 0.05, 0.05, 0.65);
  kit.box("matte", PAL.iron, base, 0, 3.0, 0.15, 0.04, 0.04, 0.4, 0, -0.8);
  kit.box("lamp", PAL.cream, base, 0, 2.85, 0.6, 0.22, 0.32, 0.22);
  kit.cyl("matte", PAL.iron, base, 0, 3.08, 0.6, 0.0, 0.2, 0.18, 4, Math.PI / 4);
  kit.box("matte", PAL.iron, base, 0, 2.67, 0.6, 0.26, 0.04, 0.26);
}

/** A picket fence from (ax, az) to (bx, bz). */
function fence(kit: Kit, ax: number, az: number, bx: number, bz: number, color: THREE.Color) {
  const len = Math.hypot(bx - ax, bz - az);
  const ry = Math.atan2(-(bz - az), bx - ax);
  const posts = Math.max(1, Math.round(len / 1.8));
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    kit.box("matte", PAL.timber, local(x, heightAt(x, z), z, 1, 1, 1, ry), 0, 0.55, 0, 0.1, 1.2, 0.1);
  }
  for (let i = 0; i < posts; i++) {
    const t = (i + 0.5) / posts;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const y = heightAt(x, z);
    const seg = len / posts;
    for (const ry2 of [0.3, 0.8]) kit.box("matte", color.clone().multiplyScalar(0.8), local(x, y, z, 1, 1, 1, ry), 0, ry2, 0.06, seg, 0.07, 0.04);
  }
  const pickets = Math.floor(len / 0.17);
  for (let i = 0; i < pickets; i++) {
    const t = (i + 0.5) / pickets;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const base = local(x, heightAt(x, z), z, 1, 1, 1, ry);
    kit.box("matte", color, base, 0, 0.47, 0.1, 0.07, 0.94, 0.025);
    kit.box("matte", color, base, 0, 0.95, 0.1, 0.05, 0.05, 0.025, 0, 0, Math.PI / 4);
  }
}

function stall(kit: Kit, x: number, z: number, ry: number, color: THREE.Color, r: () => number) {
  const y = heightAt(x, z);
  const base = local(x, y, z, 1, 1, 1, ry);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) kit.box("matte", PAL.timberLight, base, sx * 1.1, 1.15 + (sz < 0 ? 0.25 : 0), sz * 0.6, 0.09, 2.3 + (sz < 0 ? 0.5 : 0), 0.09);
  kit.box("matte", PAL.wood, base, 0, 0.9, 0, 2.4, 0.08, 1.3);
  kit.box("matte", PAL.timber, base, 0, 0.5, 0.62, 2.3, 0.7, 0.04);
  // Striped canopy.
  const stripes = 8;
  for (let i = 0; i < stripes; i++) {
    kit.box("matte", i % 2 ? PAL.cream : color, base, -1.25 + (i + 0.5) * (2.5 / stripes), 2.55, 0, 2.5 / stripes + 0.002, 0.04, 1.7, 0, 0.3);
    kit.box("matte", i % 2 ? PAL.cream : color, base, -1.25 + (i + 0.5) * (2.5 / stripes), 2.18, 0.82, 2.5 / stripes + 0.002, 0.24, 0.03);
  }
  // Produce: rows of apples, pumpkins and baskets.
  const goods = [C("#c0392b"), C("#e67e22"), C("#f1c40f"), C("#7fa33a")];
  for (let i = 0; i < 18; i++) kit.blob(goods[i % 4], base, -1.0 + (i % 9) * 0.25, 1.0, -0.3 + Math.floor(i / 9) * 0.45 + r() * 0.05, 0.1 + r() * 0.03);
}

// ---- the village ----------------------------------------------------------------------------
export interface Mover {
  mesh: THREE.Object3D;
  update(t: number): void;
}

export interface Village {
  group: THREE.Group;
  /** Static meshes, merged by material. */
  statics: THREE.Mesh[];
  cobbles: THREE.InstancedMesh;
  /** Meshes that move: register as dynamic casters. */
  dynamics: THREE.Mesh[];
  movers: Mover[];
  glass: THREE.MeshStandardMaterial;
  lamps: THREE.MeshStandardMaterial;
  triangles: number;
  /** Where the houses stand (front = local +z), for picking views. */
  houses: { x: number; z: number; rotY: number; w: number; d: number }[];
}

export function buildVillage(): Village {
  const group = new THREE.Group();
  group.name = "village";
  const kit = new Kit();
  const r = rng(2024);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const footprints: { x: number; z: number; rad: number }[] = [];
  const free = (x: number, z: number, rad: number) => footprints.every((f) => Math.hypot(f.x - x, f.z - z) > f.rad + rad);

  const style = (w: number, d: number): HouseStyle => ({
    w, d,
    floors: r() < 0.65 ? 2 : 1,
    jetty: r() < 0.5 ? 0.35 : 0,
    pitch: THREE.MathUtils.degToRad(32 + r() * 18),
    plaster: pick(PAL.plaster).clone().lerp(C("#ffffff"), r() * 0.1),
    roof: pick(PAL.roof),
    shutter: r() < 0.7 ? pick(PAL.shutter) : null,
    door: pick(PAL.door),
    timbered: r() < 0.6,
    chimney: r() < 0.75,
    porch: (["none", "canopy", "canopy", "posts"] as const)[Math.floor(r() * 4)],
    awning: r() < 0.3 ? pick(PAL.canvas) : null,
    flowers: r() < 0.7,
  });

  const houses: { x: number; z: number; rotY: number; w: number; d: number; base: THREE.Matrix4 }[] = [];
  const place = (x: number, z: number, rotY: number, w: number, d: number) => {
    const rad = Math.hypot(w, d) / 2 + 0.6;
    if (!free(x, z, rad)) return false;
    if (polylineDistance(STREET, x, z).d < d / 2 + 3.4) return false;
    if (polylineDistance(MILL_LANE, x, z).d < Math.max(w, d) / 2 + 2.2) return false;
    if (Math.hypot(x, z) < SQUARE_RADIUS + d / 2 + 1.5) return false;
    footprints.push({ x, z, rad });
    const { base } = house(kit, x, z, rotY, style(w, d), r);
    houses.push({ x, z, rotY, w, d, base });
    return true;
  };

  // Bell tower on the north side of the square.
  {
    const tx = -9, tz = -16;
    footprints.push({ x: tx, z: tz, rad: 3 });
    const y = heightAt(tx, tz);
    const base = local(tx, 0, tz, 1, 1, 1, 0.2);
    kit.box("matte", PAL.stone, base, 0, y + 7, 0, 3.6, 16, 3.6);
    for (let k = 0; k < 4; k++) kit.box("matte", PAL.stoneDark, base, 0, y + 3 + k * 4, 0, 3.8, 0.25, 3.8);
    for (const [fx, fz, ry] of [[0, 1.81, 0], [0, -1.81, Math.PI], [1.81, 0, Math.PI / 2], [-1.81, 0, -Math.PI / 2]] as const) {
      const f = new THREE.Matrix4().multiplyMatrices(base, local(fx, 0, fz, 1, 1, 1, ry));
      kit.box("glass", PAL.water, f, 0, y + 13.2, 0, 1.1, 1.8, 0.1);
      kit.box("matte", PAL.stoneDark, f, 0, y + 14.2, 0.06, 1.4, 0.2, 0.14);
      kit.box("matte", PAL.frame, f, 0, y + 9, 0.02, 1.3, 1.3, 0.06);
      kit.box("matte", PAL.iron, f, 0, y + 9, 0.07, 0.05, 0.5, 0.04, 0, 0, 0.4);
    }
    kit.cyl("matte", PAL.roof[2], base, 0, y + 17.4, 0, 0, 3.0, 5, 4, Math.PI / 4);
    kit.cyl("matte", PAL.iron, base, 0, y + 20.3, 0, 0.03, 0.03, 1.2, 4);
  }

  // Houses along the street, fronts facing it.
  const L = polylineLength(STREET);
  for (const side of [1, -1]) {
    let s = 3;
    while (s < L - 3) {
      const w = 5.5 + r() * 3;
      const d = 4.8 + r() * 1.8;
      const p = polylineAt(STREET, s + w / 2);
      const nx = -p.dz, nz = p.dx;
      const off = 2.6 + 1.3 + d / 2 + r() * 0.6;
      const x = p.x + nx * side * off, z = p.z + nz * side * off;
      place(x, z, Math.atan2(-side * nx, -side * nz), w, d);
      s += w + 0.9 + r() * 1.2;
    }
  }
  // Houses around the square, facing its centre.
  for (const a of [0.6, 1.35, 2.05, 2.75, 3.85, 4.5, 5.45]) {
    const w = 6 + r() * 2, d = 5 + r() * 1.5;
    const rad = SQUARE_RADIUS + 1.8 + d / 2;
    place(Math.cos(a) * rad, Math.sin(a) * rad, Math.atan2(-Math.cos(a), -Math.sin(a)), w, d);
  }
  // A second ring of cottages further out in the clearing.
  for (let i = 0; i < 160 && houses.length < 40; i++) {
    const a = r() * Math.PI * 2;
    const rad = 19 + r() * 15;
    const x = Math.cos(a) * rad * 1.1, z = -4 + Math.sin(a) * rad * 0.85;
    place(x, z, Math.atan2(-x, -z) + (r() - 0.5) * 0.6, 5 + r() * 2.5, 4.5 + r() * 1.5);
  }

  // Street furniture: lamp posts along the street, props by the houses.
  for (let s = 6; s < L - 3; s += 11) {
    const p = polylineAt(STREET, s);
    const side = Math.floor(s / 11) % 2 ? 1 : -1;
    const x = p.x - p.dz * side * 3.0, z = p.z + p.dx * side * 3.0;
    if (Math.hypot(x, z) < SQUARE_RADIUS + 1) continue;
    lampPost(kit, x, z, Math.atan2(p.dz * side, -p.dx * side));
  }
  for (const a of [0.2, 2.4, 3.3, 5.0]) lampPost(kit, Math.cos(a) * (SQUARE_RADIUS + 0.4), Math.sin(a) * (SQUARE_RADIUS + 0.4), Math.atan2(-Math.cos(a), -Math.sin(a)) + Math.PI);
  houses.forEach((h, i) => {
    const side = i % 2 ? 1 : -1;
    const p = new THREE.Vector3(side * (h.w / 2 + 0.9), 0, h.d / 2 + 0.2).applyMatrix4(h.base);
    const k = r();
    if (k < 0.35) {
      barrel(kit, p.x, p.z, r);
      barrel(kit, p.x + 0.7, p.z + 0.2, r);
      if (r() < 0.5) barrel(kit, p.x + 0.2, p.z - 0.7, r, true);
    } else if (k < 0.65) {
      const y = heightAt(p.x, p.z);
      crate(kit, p.x, y, p.z, 0.7, h.rotY + 0.2);
      crate(kit, p.x + 0.85, y, p.z + 0.1, 0.6, h.rotY - 0.1);
      if (r() < 0.6) crate(kit, p.x + 0.3, y + 0.7, p.z, 0.5, h.rotY + 0.5);
    }
    // Gardens with picket fences behind some houses.
    if (r() < 0.45) {
      const color = r() < 0.5 ? PAL.frame : PAL.wood;
      const pts = [[-h.w / 2, -h.d / 2], [-h.w / 2 - 0.5, -h.d / 2 - 5], [h.w / 2 + 0.5, -h.d / 2 - 5], [h.w / 2, -h.d / 2]].map(([lx, lz]) => new THREE.Vector3(lx, 0, lz).applyMatrix4(h.base));
      let ok = true;
      for (const q of pts) if (polylineDistance(STREET, q.x, q.z).d < 3.2 || polylineDistance(MILL_LANE, q.x, q.z).d < 2) ok = false;
      if (ok) for (let j = 0; j < 3; j++) fence(kit, pts[j].x, pts[j].z, pts[j + 1].x, pts[j + 1].z, color);
    }
  });

  // The square: a well and market stalls.
  {
    const wx = 3.2, wz = 4.2;
    const y = heightAt(wx, wz);
    const base = local(wx, y, wz);
    kit.cyl("matte", PAL.stone, base, 0, 0.45, 0, 1.1, 1.15, 0.9, 20);
    kit.cyl("matte", PAL.stoneDark, base, 0, 0.93, 0, 1.18, 1.18, 0.08, 20);
    kit.cyl("glass", PAL.water, base, 0, 0.9, 0, 0.9, 0.9, 0.04, 20);
    for (const side of [-1, 1]) kit.box("matte", PAL.timber, base, side * 1.0, 1.4, 0, 0.14, 2.8, 0.14);
    kit.box("matte", PAL.timber, base, 0, 2.2, 0, 2.2, 0.12, 0.12);
    kit.cyl("matte", PAL.wood, base, 0, 1.5, 0, 0.16, 0.13, 0.3, 10);
    kit.box("matte", PAL.iron, base, 0, 1.95, 0, 0.02, 0.5, 0.02);
    for (const side of [-1, 1]) kit.box("matte", PAL.roof[0], base, 0, 2.95, side * 0.55, 2.6, 0.08, 1.4, 0, side * 0.62);
  }
  stall(kit, -4.5, 5.5, 0.4, PAL.canvas[0], r);
  stall(kit, 6.5, -4.5, 3.4, PAL.canvas[1], r);
  stall(kit, -6.2, -3.8, 2.6, PAL.canvas[2], r);

  // The windmill, at the end of the lane.
  const mill = MILL_LANE[MILL_LANE.length - 1];
  const mx = mill[0] + 3, mz = mill[1] - 4;
  const my = heightAt(mx, mz);
  const millFacing = Math.atan2(-mx, -mz); // sails face the village
  {
    const base = local(mx, my, mz, 1, 1, 1, millFacing);
    footprints.push({ x: mx, z: mz, rad: 4 });
    kit.cyl("matte", PAL.stone, base, 0, 0.6, 0, 3.3, 3.4, 1.2, 8, Math.PI / 8);
    kit.cyl("matte", PAL.plaster[4], base, 0, 6.2, 0, 2.1, 3.1, 10.4, 8, Math.PI / 8);
    kit.cyl("matte", PAL.roof[4], base, 0, 12.6, 0, 0.3, 2.6, 2.6, 8, Math.PI / 8);
    kit.box("matte", PAL.timber, base, 0, 2.1, 3.0, 1.1, 2.0, 0.2);
    kit.box("matte", PAL.timber, base, 0, 7.4, 2.52, 0.8, 1.0, 0.25, 0, -0.1);
    kit.box("matte", PAL.timber, base, 0, 11.6, 2.2, 0.5, 0.5, 1.4);
    // Gallery ring with railing posts.
    kit.cyl("matte", PAL.timberLight, base, 0, 4.6, 0, 3.9, 3.9, 0.15, 16);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      kit.box("matte", PAL.timber, base, Math.cos(a) * 3.8, 5.1, Math.sin(a) * 3.8, 0.07, 0.9, 0.07);
    }
    kit.cyl("matte", PAL.timber, base, 0, 5.55, 0, 3.8, 3.8, 0.06, 24);
  }

  const glass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.2, emissive: "#ffb35c", emissiveIntensity: 0 });
  const lamps = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: "#ffc070", emissiveIntensity: 0 });
  const matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  const statics = kit.build({ matte, glass, lamp: lamps });
  group.add(...statics);
  for (const m of statics) m.updateMatrix();

  // ---- cobbles --------------------------------------------------------------------------------
  const spots: [number, number][] = [];
  for (let x = -40; x <= 40; x += 0.34) {
    for (let z = -12; z <= 12; z += 0.34) {
      const jx = x + ((Math.floor(z / 0.34) % 2) * 0.17), jz = z;
      if (polylineDistance(STREET, jx, jz).d < 2.55 || Math.hypot(jx, jz) < SQUARE_RADIUS) spots.push([jx, jz]);
    }
  }
  const cobbleGeo = new THREE.BoxGeometry(0.29, 0.1, 0.29);
  const cobbleMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  const cobbles = new THREE.InstancedMesh(cobbleGeo, cobbleMat, spots.length);
  cobbles.name = "cobbles";
  const cm = new THREE.Matrix4();
  const tints = ["#b3aa9b", "#a19788", "#c2b8a6", "#958b7d", "#b9a58c"].map(C);
  spots.forEach(([x, z], i) => {
    const sc = 0.8 + r() * 0.3;
    cm.compose(V.set(x + (r() - 0.5) * 0.04, heightAt(x, z) + 0.01, z + (r() - 0.5) * 0.04), Q.setFromEuler(E.set((r() - 0.5) * 0.08, r() * 0.4, (r() - 0.5) * 0.08)), S.set(sc, 0.8 + r() * 0.5, 0.8 + r() * 0.3));
    cobbles.setMatrixAt(i, cm);
    cobbles.setColorAt(i, pick(tints));
  });
  cobbles.instanceMatrix.needsUpdate = true;
  cobbles.instanceColor!.needsUpdate = true;
  cobbles.castShadow = cobbles.receiveShadow = true;
  cobbles.matrixAutoUpdate = false;
  group.add(cobbles);

  // ---- movers ---------------------------------------------------------------------------------
  const movers: Mover[] = [];
  const dynamics: THREE.Mesh[] = [];
  const mk = (build: (k: Kit, id: THREE.Matrix4) => void, name: string) => {
    const k = new Kit();
    build(k, new THREE.Matrix4());
    const mesh = k.build({ matte, glass, lamp: lamps })[0];
    mesh.name = name;
    mesh.matrixAutoUpdate = true;
    return mesh;
  };

  // Windmill sails: four lattice sails, turning.
  const sails = mk((k, id) => {
    k.cyl("matte", PAL.timber, id, 0, 0, 0, 0.35, 0.35, 0.7, 10, 0, Math.PI / 2);
    for (let a = 0; a < 4; a++) {
      const arm = new THREE.Matrix4().makeRotationZ((a * Math.PI) / 2);
      k.box("matte", PAL.timber, arm, 0, 3.6, 0.1, 0.2, 7.2, 0.14);
      k.box("matte", PAL.timberLight, arm, 0.75, 4.2, 0.18, 0.05, 5.6, 0.05);
      k.box("matte", PAL.timberLight, arm, -0.15, 4.2, 0.18, 0.05, 5.6, 0.05);
      for (let j = 0; j < 14; j++) k.box("matte", PAL.timberLight, arm, 0.3, 1.6 + j * 0.4, 0.18, 1.0, 0.05, 0.05);
      // Half of each sail is clothed; the other half shows the lattice.
      k.box("matte", PAL.cream, arm, 0.52, 5.2, 0.2, 0.46, 3.4, 0.02);
    }
  }, "windmill.sails");
  const hub = new THREE.Vector3(0, 11.6, 3.0).applyMatrix4(local(mx, my, mz, 1, 1, 1, millFacing));
  sails.position.copy(hub);
  sails.rotation.set(-0.1, millFacing, 0, "YXZ");
  group.add(sails);
  dynamics.push(sails);
  movers.push({ mesh: sails, update: (t) => { sails.rotation.z = t * 0.5; } });

  // A hand cart trundling along the street and back.
  const cart = new THREE.Group();
  cart.name = "cart";
  const body = mk((k, id) => {
    k.box("matte", PAL.wood, id, 0, 0.75, 0, 1.1, 0.08, 1.8);
    for (const side of [-1, 1]) {
      k.box("matte", PAL.timberLight, id, side * 0.53, 0.98, 0, 0.05, 0.4, 1.8);
      for (let j = -2; j <= 2; j++) k.box("matte", PAL.timber, id, side * 0.56, 0.98, j * 0.42, 0.04, 0.46, 0.06);
      k.box("matte", PAL.timber, id, side * 0.4, 0.7, 1.6, 0.06, 0.06, 1.8, 0, -0.08);
    }
    k.box("matte", PAL.timberLight, id, 0, 0.98, 0.88, 1.1, 0.4, 0.05);
    k.box("matte", PAL.timberLight, id, 0, 0.98, -0.88, 1.1, 0.4, 0.05);
    k.cyl("matte", PAL.wood, id, 0, 1.0, -0.3, 0.3, 0.3, 0.9, 12, 0, 0, Math.PI / 2);
    k.box("matte", PAL.crate, id, 0.1, 1.0, 0.45, 0.5, 0.45, 0.5, 0.3);
    k.box("matte", PAL.iron, id, 0, 0.45, 0, 1.3, 0.06, 0.06);
  }, "cart.body");
  const wheels = mk((k, id) => {
    for (const side of [-1, 1]) {
      k.cyl("matte", PAL.timber, id, side * 0.66, 0, 0, 0.45, 0.45, 0.07, 16, 0, 0, Math.PI / 2);
      for (let j = 0; j < 6; j++) k.box("matte", PAL.timberLight, id, side * 0.71, 0, 0, 0.03, 0.8, 0.05, 0, (j * Math.PI) / 6);
    }
  }, "cart.wheels");
  wheels.position.y = 0.45;
  cart.add(body, wheels);
  group.add(cart);
  dynamics.push(body, wheels);
  movers.push({
    mesh: cart,
    update: (t) => {
      const span = L - 16;
      const u = (t * 0.9) % (2 * span);
      const s = 8 + (u < span ? u : 2 * span - u);
      const p = polylineAt(STREET, s);
      const dir = u < span ? 1 : -1;
      const px = p.x + p.dz * dir * 1.0, pz = p.z - p.dx * dir * 1.0; // keep to the right
      cart.position.set(px, heightAt(px, pz), pz);
      cart.rotation.y = Math.atan2(p.dx * dir, p.dz * dir);
      wheels.rotation.x = s / 0.45;
    },
  });

  // A tavern sign swinging on its bracket, on the first street house.
  const h0 = houses[0];
  if (h0) {
    const signAt = new THREE.Vector3(h0.w / 2 - 0.4, 0, h0.d / 2).applyMatrix4(h0.base);
    const sy = heightAt(signAt.x, signAt.z) + 3.1;
    kit.box("matte", PAL.iron, local(signAt.x, sy, signAt.z, 1, 1, 1, h0.rotY), 0, 0.5, 0.45, 0.05, 0.05, 0.9);
    const statics2 = kit.build({ matte, glass, lamp: lamps });
    for (const m of statics2) {
      m.updateMatrix();
      group.add(m);
      statics.push(m);
    }
    const sign = mk((k, id) => {
      k.box("matte", PAL.iron, id, 0, -0.1, 0, 0.02, 0.2, 0.02);
      k.box("matte", PAL.door[0], id, 0, -0.55, 0, 0.06, 0.7, 0.9);
      k.box("matte", PAL.flowers[1], id, 0.04, -0.55, 0, 0.02, 0.3, 0.3, 0, Math.PI / 4);
    }, "sign");
    const pivot = new THREE.Vector3(0, 0.5, 0.85).applyMatrix4(local(signAt.x, sy, signAt.z, 1, 1, 1, h0.rotY));
    sign.position.copy(pivot);
    group.add(sign);
    dynamics.push(sign);
    movers.push({ mesh: sign, update: (t) => { sign.rotation.set(0, h0.rotY, 0.2 * Math.sin(t * 1.3), "YXZ"); } });
  }

  let triangles = cobbles.count * 12;
  for (const m of [...statics, ...dynamics]) triangles += m.geometry.getAttribute("position").count / 3;
  return { group, statics, cobbles, dynamics, movers, glass, lamps, triangles, houses: houses.map(({ x, z, rotY, w, d }) => ({ x, z, rotY, w, d })) };
}
