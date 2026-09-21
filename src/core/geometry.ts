// Cluster building. A geometry is cut into fixed-size triangle clusters after
// sorting its triangles along a Morton curve, so each cluster is spatially
// compact and its bounds cull tightly against individual shadow pages.

export interface ClusterRecord {
  aabbMin: [number, number, number];
  aabbMax: [number, number, number];
  firstIndex: number; // into the global index buffer
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
  positions: Float32Array;
  uvs: Float32Array;
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
  order.sort((a, b) => keys[a] - keys[b]);

  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    const t = order[i];
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

  return {
    positions: pos,
    uvs: input.uvs ?? new Float32Array(vertexCount * 2),
    indices,
    clusters,
    aabbMin: min,
    aabbMax: max,
  };
}
