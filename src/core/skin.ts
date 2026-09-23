// Skinned casters: linear blend skinning in the caster vertex stage.
//
// A skinned geometry carries, per vertex, up to 4 (or 8) bone indices and
// weights, packed into u32 words appended to the index buffer (the raster
// stage already binds WebGPU's default 8 storage buffers, so the skin data
// rides in one it has). Its clusters are flagged through the free word of the
// cluster record, and its bones are extra instance rows after the instance's
// own row. That row is not the mesh's world matrix but a per-frame BOUNDS
// transform: it maps the unit box [-1, 1]^3, which every skinned cluster
// claims as its local AABB, onto a conservative world box of the current pose.
// The cull therefore needs no change.
//
// The bounds are computed without skinning a vertex on the CPU. At build time
// each bone gets an anchor (the centre of the bind-pose box of the vertices it
// influences) and a radius (their farthest distance from the anchor). A
// skinned vertex is a convex combination (weights are normalized) of its
// bones' transforms of it, and bone b's transform of any vertex it influences
// lies inside the ellipsoid M_b(ball(anchor_b, r_b)), so every skinned vertex
// lies in the convex hull of those ellipsoids, whose AABB is the union of the
// ellipsoids' AABBs. An ellipsoid A(ball(c, r)) has half extent r * |row_k(A)|
// along world axis k: exact, not a sphere bound, and valid for any affine bone
// transform (scaled or sheared bones included).

/** Per-vertex skin influences, in the layout Babylon (and glTF) store them. */
export interface SkinInput {
  /** Bones in the skeleton; every index must be below this. At most 256. */
  boneCount: number;
  /** 4 bone indices per vertex. */
  indices: ArrayLike<number>;
  /** 4 weights per vertex. Normalized here; need not sum to 1. */
  weights: ArrayLike<number>;
  /** Optional second set of 4 (Babylon's matricesIndicesExtra / matricesWeightsExtra). */
  indicesExtra?: ArrayLike<number> | null;
  weightsExtra?: ArrayLike<number> | null;
}

export interface BuiltSkin {
  /** u32 words per vertex: 3 for 4 influences, 6 for 8. */
  stride: 3 | 6;
  /** Per vertex: [indices 4 x u8] [w0 w1 unorm16] [w2 w3 unorm16], then the same for the extra set. */
  words: Uint32Array;
  boneCount: number;
  /** Per bone: anchor xyz (bind-pose mesh space) and radius; radius < 0 when the bone influences no vertex. */
  anchors: Float32Array;
}

/** Largest bone count a packed index (u8) can address. */
export const MAX_SKIN_BONES = 256;

/**
 * Pack the influences of a geometry whose vertices are `positions` (xyz,
 * already in the geometry's final vertex order) and compute each bone's
 * anchor and radius. Weights are quantized to unorm16 and renormalized in the
 * shader, so a vertex is always a convex combination of its bones.
 */
export function buildSkin(skin: SkinInput, positions: Float32Array, vertexCount: number): BuiltSkin {
  const bones = skin.boneCount;
  if (!(bones > 0 && bones <= MAX_SKIN_BONES)) {
    throw new Error(`Sundial: skinned geometry has ${bones} bones; 1 to ${MAX_SKIN_BONES} are supported`);
  }
  const extra = !!(skin.indicesExtra && skin.weightsExtra) && hasWeight(skin.weightsExtra!, vertexCount * 4);
  const sets = extra ? 2 : 1;
  const stride = (extra ? 6 : 3) as 3 | 6;
  const words = new Uint32Array(vertexCount * stride);
  const lo = new Float64Array(bones * 3).fill(Infinity);
  const hi = new Float64Array(bones * 3).fill(-Infinity);
  const idx = new Uint32Array(8);
  const w = new Float64Array(8);
  const q = new Uint32Array(8);

  for (let v = 0; v < vertexCount; v++) {
    let sum = 0;
    for (let s = 0; s < sets; s++) {
      const I = s === 0 ? skin.indices : skin.indicesExtra!;
      const W = s === 0 ? skin.weights : skin.weightsExtra!;
      for (let k = 0; k < 4; k++) {
        const j = s * 4 + k;
        const b = I[v * 4 + k] | 0;
        const wt = W[v * 4 + k];
        const valid = b >= 0 && b < bones && wt > 0;
        idx[j] = valid ? b : 0;
        w[j] = valid ? wt : 0;
        sum += w[j];
      }
    }
    // A vertex with no weight at all follows bone 0 rigidly (Babylon would
    // collapse it to the mesh origin; such data is broken either way).
    if (sum <= 0) {
      w[0] = 1;
      idx[0] = 0;
      sum = 1;
    }
    for (let j = 0; j < sets * 4; j++) q[j] = Math.round((w[j] / sum) * 65535);
    // Quantizing can round a weight to 0; round the largest back up so the
    // vertex keeps at least one influence (the shader divides by the sum).
    let any = false;
    for (let j = 0; j < sets * 4; j++) if (q[j] > 0) any = true;
    if (!any) {
      let best = 0;
      for (let j = 1; j < sets * 4; j++) if (w[j] > w[best]) best = j;
      q[best] = 1;
    }
    for (let s = 0; s < sets; s++) {
      const o = v * stride + s * 3;
      const j = s * 4;
      words[o] = (idx[j] | (idx[j + 1] << 8) | (idx[j + 2] << 16) | (idx[j + 3] << 24)) >>> 0;
      words[o + 1] = (q[j] | (q[j + 1] << 16)) >>> 0;
      words[o + 2] = (q[j + 2] | (q[j + 3] << 16)) >>> 0;
    }
    // Bone boxes over exactly the influences the shader will apply.
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    for (let j = 0; j < sets * 4; j++) {
      if (q[j] === 0) continue;
      const b = idx[j] * 3;
      if (x < lo[b]) lo[b] = x;
      if (y < lo[b + 1]) lo[b + 1] = y;
      if (z < lo[b + 2]) lo[b + 2] = z;
      if (x > hi[b]) hi[b] = x;
      if (y > hi[b + 1]) hi[b + 1] = y;
      if (z > hi[b + 2]) hi[b + 2] = z;
    }
  }

  const anchors = new Float32Array(bones * 4);
  for (let b = 0; b < bones; b++) {
    const o = b * 4;
    if (lo[b * 3] > hi[b * 3]) {
      anchors[o + 3] = -1;
      continue;
    }
    for (let k = 0; k < 3; k++) anchors[o + k] = (lo[b * 3 + k] + hi[b * 3 + k]) / 2;
  }
  // Radii: the farthest influenced vertex from the (f32) anchor.
  const r2 = new Float64Array(bones);
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    for (let s = 0; s < sets; s++) {
      const o = v * stride + s * 3;
      const packed = words[o];
      for (let k = 0; k < 4; k++) {
        const wq = k < 2 ? (words[o + 1] >>> (k * 16)) & 0xffff : (words[o + 2] >>> ((k - 2) * 16)) & 0xffff;
        if (wq === 0) continue;
        const b = (packed >>> (k * 8)) & 0xff;
        const dx = x - anchors[b * 4], dy = y - anchors[b * 4 + 1], dz = z - anchors[b * 4 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d > r2[b]) r2[b] = d;
      }
    }
  }
  for (let b = 0; b < bones; b++) {
    // A hair of slack for the f32 transforms on the GPU side.
    if (anchors[b * 4 + 3] >= 0) anchors[b * 4 + 3] = Math.sqrt(r2[b]) * (1 + 1e-5) + 1e-6;
  }

  return { stride, words, boneCount: bones, anchors };
}

function hasWeight(w: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i++) if (w[i] > 0) return true;
  return false;
}

/**
 * A skinned instance's rows from its world matrix and its bones' skinning
 * matrices (both 16 floats, column-major, translation at 12..14: Babylon's and
 * three.js's layout; a bone matrix maps bind-pose mesh space to posed mesh
 * space, as Babylon's skeleton.getTransformMatrices gives them). Writes bone
 * row b at dst[d + 12 * (1 + b)] = world * bone_b, and the bounds row at
 * dst[d]: the unit box onto the pose's conservative world box. `bones` null
 * means the bind pose. Allocates nothing.
 */
export function writeSkinRows(
  dst: Float32Array,
  d: number,
  skin: BuiltSkin,
  world: ArrayLike<number>,
  wo: number,
  bones: ArrayLike<number> | null,
  bo: number,
): void {
  // A collapsed (zero-scale) world matrix casts nothing, as for rigid instances.
  let linear = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) linear += Math.abs(world[wo + k * 4 + i]);
  if (linear === 0) {
    dst.fill(0, d, d + 12 * (1 + skin.boneCount));
    return;
  }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const a = skin.anchors;
  for (let b = 0; b < skin.boneCount; b++) {
    const r = d + 12 * (1 + b);
    if (bones) {
      const o = bo + b * 16;
      // (W * B) as 3 affine rows; W and B column-major, bottom rows (0 0 0 1).
      for (let i = 0; i < 3; i++) {
        const w0 = world[wo + i], w1 = world[wo + 4 + i], w2 = world[wo + 8 + i], w3 = world[wo + 12 + i];
        for (let k = 0; k < 4; k++) {
          const c = o + k * 4;
          dst[r + i * 4 + k] = w0 * bones[c] + w1 * bones[c + 1] + w2 * bones[c + 2] + (k === 3 ? w3 : 0);
        }
      }
    } else {
      for (let i = 0; i < 3; i++) for (let k = 0; k < 4; k++) dst[r + i * 4 + k] = world[wo + k * 4 + i];
    }
    const rad = a[b * 4 + 3];
    if (rad < 0) continue;
    const ax = a[b * 4], ay = a[b * 4 + 1], az = a[b * 4 + 2];
    // Row i: the anchor's world coordinate and the ellipsoid's half extent.
    for (let i = 0; i < 3; i++) {
      const p = r + i * 4;
      const m0 = dst[p], m1 = dst[p + 1], m2 = dst[p + 2];
      const c = m0 * ax + m1 * ay + m2 * az + dst[p + 3];
      const e = rad * Math.sqrt(m0 * m0 + m1 * m1 + m2 * m2);
      if (i === 0) {
        if (c - e < x0) x0 = c - e;
        if (c + e > x1) x1 = c + e;
      } else if (i === 1) {
        if (c - e < y0) y0 = c - e;
        if (c + e > y1) y1 = c + e;
      } else {
        if (c - e < z0) z0 = c - e;
        if (c + e > z1) z1 = c + e;
      }
    }
  }
  if (!(x0 <= x1)) {
    // No bone influences anything, or a collapsed world matrix: cast nothing.
    for (let k = 0; k < 12; k++) dst[d + k] = 0;
    return;
  }
  // Unit box onto [x0, x1] x [y0, y1] x [z0, z1]. A flat axis keeps a tiny
  // extent so the row never reads as a collapsed (zero-scale) instance.
  const ex = Math.max((x1 - x0) / 2, 1e-6), ey = Math.max((y1 - y0) / 2, 1e-6), ez = Math.max((z1 - z0) / 2, 1e-6);
  dst[d] = ex; dst[d + 1] = 0; dst[d + 2] = 0; dst[d + 3] = (x0 + x1) / 2;
  dst[d + 4] = 0; dst[d + 5] = ey; dst[d + 6] = 0; dst[d + 7] = (y0 + y1) / 2;
  dst[d + 8] = 0; dst[d + 9] = 0; dst[d + 10] = ez; dst[d + 11] = (z0 + z1) / 2;
}
