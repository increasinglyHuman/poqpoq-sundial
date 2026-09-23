// Cluster building. A geometry is cut into fixed-size triangle clusters after
// sorting its triangles along a Morton curve, so each cluster is spatially
// compact and its bounds cull tightly against individual shadow pages.

export interface ClusterRecord {
  aabbMin: [number, number, number];
  aabbMax: [number, number, number];
  firstIndex: number; // relative to its geometry's indices; build() adds the geometry's index base
  triCount: number;
  alphaLayer: number; // 0xFFFFFFFF = opaque
  alphaCutoff: number;
}

export interface GeometryInput {
  positions: Float32Array; // xyz per vertex, local space
  indices: Uint32Array | Uint16Array | number[];
  uvs?: Float32Array; // xy per vertex; required when alpha is set
  alpha?: { layer: number; cutoff: number };
}

export interface BuiltGeometry {
  /**
   * Position xyz + uv per vertex (5 floats), exactly as the vertex buffer holds
   * it. Interleaved once here, so a repack copies it instead of rebuilding it.
   */
  vertices: Float32Array;
  vertexCount: number;
  indices: Uint32Array; // local vertex indices, clusters contiguous
  clusters: ClusterRecord[]; // firstIndex relative to this geometry
  aabbMin: [number, number, number];
  aabbMax: [number, number, number];
}

function part1by2(n: number): number {
  n &= 0x3ff;
  n = (n | (n << 16)) & 0x030000ff;
  n = (n | (n << 8)) & 0x0300f00f;
  n = (n | (n << 4)) & 0x030c30c3;
  n = (n | (n << 2)) & 0x09249249;
  return n >>> 0;
}

/**
 * `order` (triangle ids, in id order) sorted by their 30-bit Morton keys,
 * ascending and STABLE: equal keys keep id order. That is exactly what the
 * comparator sort this replaces produced (V8's comparator sort is a stable
 * merge sort, and `order` starts as the identity), so clusters are unchanged.
 * An LSD radix sort, 3 passes of 10 bits carrying key and id together: linear,
 * no comparator calls. Start-up clustering of a comm sim (6.3 M triangles) was
 * ~605 ms in the comparator sort against ~85 ms this way. May return `order`
 * or a new array; `keys` and `order` are clobbered.
 */
export function sortByMorton(keys: Uint32Array, order: Uint32Array): Uint32Array {
  const n = keys.length;
  if (n < 2) return order;
  let srcKey: Uint32Array = keys;
  let srcId: Uint32Array = order;
  let dstKey: Uint32Array = new Uint32Array(n);
  let dstId: Uint32Array = new Uint32Array(n);
  const counts = new Uint32Array(1024);
  for (let shift = 0; shift < 30; shift += 10) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(srcKey[i] >>> shift) & 1023]++;
    // Exclusive prefix sum: each digit's first output slot.
    let sum = 0;
    for (let d = 0; d < 1024; d++) {
      const c = counts[d];
      counts[d] = sum;
      sum += c;
    }
    // Scatter in input order, so equal digits keep their relative order (stability).
    for (let i = 0; i < n; i++) {
      const k = srcKey[i];
      const o = counts[(k >>> shift) & 1023]++;
      dstKey[o] = k;
      dstId[o] = srcId[i];
    }
    [srcKey, dstKey] = [dstKey, srcKey];
    [srcId, dstId] = [dstId, srcId];
  }
  return srcId;
}

export function buildGeometry(input: GeometryInput, clusterTris: number): BuiltGeometry {
  const pos = input.positions;
  const src = input.indices;
  const triCount = Math.floor(src.length / 3);
  const vertexCount = pos.length / 3;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertexCount; v++) {
    for (let k = 0; k < 3; k++) {
      const x = pos[v * 3 + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  const ext = [max[0] - min[0] || 1, max[1] - min[1] || 1, max[2] - min[2] || 1];

  const keys = new Uint32Array(triCount);
  const order = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let c = 0; c < 3; c++) {
      const v = src[t * 3 + c];
      cx += pos[v * 3];
      cy += pos[v * 3 + 1];
      cz += pos[v * 3 + 2];
    }
    const qx = Math.min(1023, Math.max(0, Math.floor(((cx / 3 - min[0]) / ext[0]) * 1023)));
    const qy = Math.min(1023, Math.max(0, Math.floor(((cy / 3 - min[1]) / ext[1]) * 1023)));
    const qz = Math.min(1023, Math.max(0, Math.floor(((cz / 3 - min[2]) / ext[2]) * 1023)));
    keys[t] = (part1by2(qx) | (part1by2(qy) << 1) | (part1by2(qz) << 2)) >>> 0;
    order[t] = t;
  }
  const sorted = sortByMorton(keys, order);

  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    const t = sorted[i];
    indices[i * 3] = src[t * 3];
    indices[i * 3 + 1] = src[t * 3 + 1];
    indices[i * 3 + 2] = src[t * 3 + 2];
  }

  const clusters: ClusterRecord[] = [];
  for (let first = 0; first < triCount; first += clusterTris) {
    const count = Math.min(clusterTris, triCount - first);
    const cmin: [number, number, number] = [Infinity, Infinity, Infinity];
    const cmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = first * 3; i < (first + count) * 3; i++) {
      const v = indices[i];
      for (let k = 0; k < 3; k++) {
        const x = pos[v * 3 + k];
        if (x < cmin[k]) cmin[k] = x;
        if (x > cmax[k]) cmax[k] = x;
      }
    }
    clusters.push({
      aabbMin: cmin,
      aabbMax: cmax,
      firstIndex: first * 3,
      triCount: count,
      alphaLayer: input.alpha ? input.alpha.layer : 0xffffffff,
      alphaCutoff: input.alpha ? input.alpha.cutoff : 0,
    });
  }

  const uvs = input.uvs;
  const vertices = new Float32Array(vertexCount * 5);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 5] = pos[i * 3];
    vertices[i * 5 + 1] = pos[i * 3 + 1];
    vertices[i * 5 + 2] = pos[i * 3 + 2];
    if (uvs) {
      vertices[i * 5 + 3] = uvs[i * 2];
      vertices[i * 5 + 4] = uvs[i * 2 + 1];
    }
  }
  return {
    vertices,
    vertexCount,
    indices,
    clusters,
    aabbMin: min,
    aabbMax: max,
  };
}
