// Helpers every engine adapter needs to turn a mesh into Sundial geometry:
// content keys (so identical shapes share clusters and survive re-creation)
// and per-run compaction (so a mesh split by material does not upload its
// vertices once per material). Engine-free.

import type { SkinInput } from "./skin";

const HASH_F32 = new Float32Array(1);
const HASH_U32 = new Uint32Array(HASH_F32.buffer);

/**
 * Two 32-bit hashes (FNV-1a and a murmur-style mix) of the arrays' 32-bit
 * words, as 16 hex digits. Allocates nothing per element: 32-bit arrays are
 * read as their raw bits through a view, other integer arrays widen exactly
 * (a Uint16Array index view hashes as the Uint32Array copy it replaced), and
 * plain number[] (MeshBuilder keeps positions that way) and Float64Array go
 * through float32. Never truncate those to integers: shapes that differed only
 * by fractions of a unit then shared one key (and one shadow).
 */
export function contentHash(...parts: ArrayLike<number>[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (const part of parts) {
    const n = part.length;
    if (part instanceof Float32Array || part instanceof Uint32Array || part instanceof Int32Array) {
      const words = new Uint32Array(part.buffer, part.byteOffset, n);
      for (let i = 0; i < n; i++) {
        h1 = Math.imul(h1 ^ words[i], 0x01000193);
        h2 = Math.imul(h2 ^ words[i], 0x5bd1e995) ^ (h2 >>> 15);
      }
    } else if (ArrayBuffer.isView(part) && !(part instanceof Float64Array)) {
      for (let i = 0; i < n; i++) {
        const w = part[i] >>> 0;
        h1 = Math.imul(h1 ^ w, 0x01000193);
        h2 = Math.imul(h2 ^ w, 0x5bd1e995) ^ (h2 >>> 15);
      }
    } else {
      for (let i = 0; i < n; i++) {
        HASH_F32[0] = part[i];
        const w = HASH_U32[0];
        h1 = Math.imul(h1 ^ w, 0x01000193);
        h2 = Math.imul(h2 ^ w, 0x5bd1e995) ^ (h2 >>> 15);
      }
    }
    h1 = Math.imul(h1 ^ n, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Keep only the vertices a run uses, renumbered in first-use order. */
export function compact(run: ArrayLike<number>, positions: ArrayLike<number>, uvs?: ArrayLike<number> | null) {
  const remap = new Map<number, number>();
  const indices = new Uint32Array(run.length);
  for (let i = 0; i < run.length; i++) {
    let v = remap.get(run[i]);
    if (v === undefined) remap.set(run[i], (v = remap.size));
    indices[i] = v;
  }
  const outPositions = new Float32Array(remap.size * 3);
  const outUvs = uvs ? new Float32Array(remap.size * 2) : undefined;
  for (const [src, dst] of remap) {
    outPositions[dst * 3] = positions[src * 3];
    outPositions[dst * 3 + 1] = positions[src * 3 + 1];
    outPositions[dst * 3 + 2] = positions[src * 3 + 2];
    if (outUvs && uvs) {
      outUvs[dst * 2] = uvs[src * 2];
      outUvs[dst * 2 + 1] = uvs[src * 2 + 1];
    }
  }
  return { positions: outPositions, indices, uvs: outUvs };
}

/** A run's skin influences, compacted with the same remap as compact() gives its positions. */
export function compactSkin(skin: SkinInput, run: ArrayLike<number>): SkinInput {
  const remap = new Map<number, number>();
  for (let i = 0; i < run.length; i++) if (!remap.has(run[i])) remap.set(run[i], remap.size);
  const pick = (src: ArrayLike<number> | null | undefined) => {
    if (!src) return null;
    const out = new Float32Array(remap.size * 4);
    for (const [from, to] of remap) for (let k = 0; k < 4; k++) out[to * 4 + k] = src[from * 4 + k];
    return out;
  };
  return {
    boneCount: skin.boneCount,
    indices: pick(skin.indices)!,
    weights: pick(skin.weights)!,
    indicesExtra: pick(skin.indicesExtra),
    weightsExtra: pick(skin.weightsExtra),
  };
}
