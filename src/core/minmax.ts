import { COMMON_WGSL, MINMAX_TILE } from "./wgsl";
import type { WorkLayout } from "./kernels";

// Min/max depth atlas: a reduced-resolution companion to the pool that lets a
// receiver skip PCF where its whole filter footprint is on one side of the
// caster depth. It lies over the pool page for page (same physical placement,
// scaled by 1/MINMAX_TILE), so the page table's physical index addresses both.
//
// The receiver's 3x3 bilinear PCF reads a 4x4 texel footprint [b, b + 3] (per
// axis) starting at any texel b of the page. Texel T of the atlas holds the
// min and max of every footprint that starts in tile T, i.e. of the page
// texels [TILE*T, TILE*T + TILE + 2] (clamped to the page): tile T and the
// tiles after it that such a footprint reaches. So the receiver needs a single
// load, not the 2x2 an unpadded tile grid would need where a footprint
// straddles tile edges, and the bound is exact by construction, whatever the
// alignment. The price is bounds over a wider window than the footprint
// (6 texels for TILE = 2, 8 for TILE = 4), so fewer fragments near a shadow
// edge, or on ground sloped against the light, can skip.
//
// TILE = 2 against 4, measured on the lab (fragments still running PCF, of
// ~960k / ~805k with no early-out): village 381k vs 489k, forest 172k vs 247k.
// It costs a 2048² atlas (32 MB) for a 4096² pool, against 8 MB for TILE = 4.
//
// Stored as raw f32 bits in rg32uint: a uint texture needs no filtering
// support and no unfilterable-float binding, which Babylon cannot declare
// (its WGSL texture declarations bind f32 textures as filterable "float").

export function minMaxWGSL(w: WorkLayout): string {
  // Tiles past T a footprint starting in tile T can reach: its last texel is
  // at most TILE - 1 + 3 past the tile's first (1 for TILE = 4).
  const extra = Math.floor((MINMAX_TILE + 2) / MINMAX_TILE);
  const side = 8 + extra;
  const taps: string[] = [];
  for (let j = 0; j <= extra; j++) for (let i = 0; i <= extra; i++) taps.push(`tiles[k + ${j * side + i}u]`);
  const combine = taps.map((t) => `mm = vec2f(min(mm.x, ${t}.x), max(mm.y, ${t}.y));`).join("\n  ");
  return /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<storage, read> psParams: PsParams;
@group(0) @binding(1) var<storage, read> psPageTable: array<vec2u>;
@group(0) @binding(2) var<storage, read> work: array<u32>;
@group(0) @binding(3) var psPool: texture_depth_2d;
@group(0) @binding(4) var psMinMaxOut: texture_storage_2d<rg32uint, write>;

const W_RENDER_LIST: u32 = ${w.renderList}u;
const W_INDIRECT: u32 = ${w.indirect}u;
const TILE: i32 = ${MINMAX_TILE};
const SIDE: u32 = ${side}u;

// One workgroup writes 8x8 output texels, which read ${side}x${side} tiles (the
// extra rows and columns are the neighbours). Tiles are reduced once into
// shared memory, then each output combines its ${extra + 1}x${extra + 1}: ${side * side} tile
// reductions per 64 outputs instead of ${64 * (extra + 1) ** 2}.
var<workgroup> tiles: array<vec2f, ${side * side}>;

// x, y: 8x8 blocks of output texels in the page; z: render-list index. The
// host dispatches z for the whole render budget; indices past this frame's
// render count (the clear draw's instance count) leave at once.
@compute @workgroup_size(8, 8)
fn buildMinMax(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u,
               @builtin(local_invocation_index) li: u32) {
  // Read-only storage at a workgroup-uniform index: uniform, so the early
  // return keeps the barrier below in uniform control flow.
  if (wg.z >= work[W_INDIRECT + 1u]) { return; }
  let slot = work[W_RENDER_LIST + wg.z];
  let phys = psPageTable[slot].x & PS_PHYS_MASK;
  let s = i32(psParams.pool.z);
  let row = psParams.pool.y;
  let tilesPerSide = s / TILE;
  let origin = vec2i(i32(phys % row), i32(phys / row)) * s;
  let t0 = vec2i(wg.xy) * 8;

  for (var k = li; k < SIDE * SIDE; k += 64u) {
    let t = t0 + vec2i(i32(k % SIDE), i32(k / SIDE));
    // A tile past the page edge is empty: it must not widen the bounds.
    var mm = vec2f(3.0e38, -3.0e38);
    if (all(t < vec2i(tilesPerSide))) {
      let p = origin + t * TILE;
      for (var j = 0; j < TILE; j++) {
        for (var i = 0; i < TILE; i++) {
          let d = textureLoad(psPool, p + vec2i(i, j), 0);
          mm = vec2f(min(mm.x, d), max(mm.y, d));
        }
      }
    }
    tiles[k] = mm;
  }
  workgroupBarrier();

  let t = t0 + vec2i(lid.xy);
  if (any(t >= vec2i(tilesPerSide))) { return; }
  let k = lid.y * SIDE + lid.x;
  var mm = vec2f(3.0e38, -3.0e38);
  ${combine}
  textureStore(psMinMaxOut, origin / TILE + t, vec4u(bitcast<u32>(mm.x), bitcast<u32>(mm.y), 0u, 0u));
}
`;
}
