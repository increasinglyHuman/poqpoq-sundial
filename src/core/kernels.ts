import { COMMON_WGSL, MAX_LEVELS } from "./wgsl";

// Counter slots in the `counters` buffer.
export const C_FREE = 0;
export const C_OLD = 1;
export const C_RECENT = 2;
export const C_ALLOC = 3;
export const C_ALLOC_FAIL = 4;
export const C_RENDER = 5;
export const C_OPAQUE_PAIRS = 6;
export const C_ALPHA_PAIRS = 7;
export const C_RESIDENT = 8;
export const C_REQUESTED = 9;
export const C_DEFERRED = 10;
/** Pages the dynamic list took this frame (before dynamicBudget), and the ones it deferred. */
export const C_DYN_PAGES = 11;
export const C_DYN_DEFERRED = 12;
/** (dynamic cluster instance, page) pairs; stored from the END of each pair list, downwards. */
export const C_DYN_OPAQUE_PAIRS = 13;
export const C_DYN_ALPHA_PAIRS = 14;
/** Scalar counters: the ones cleared every frame and read back for stats. */
export const COUNTER_COUNT = 16;
/**
 * Per level, the rect of pages being rendered this frame: 4 u32 per level
 * after the scalar counters. The counters buffer is cleared every frame and is
 * the only atomic one, so the rect is stored in a form whose empty value is 0
 * and that grows with atomicMax: (n - minX, n - minY, maxX + 1, maxY + 1) in
 * window-local page coords. Not read back.
 */
export const C_LEVEL_RECT = COUNTER_COUNT;
/** u32 words in the counters buffer. */
export const COUNTER_WORDS = COUNTER_COUNT + 4 * MAX_LEVELS;

/** Frames a page may go unrequested before it is preferred for eviction. */
const OLD_AGE = 30;

/**
 * Layout of the `work` buffer (u32 offsets). Scratch state shares one buffer
 * so that no stage binds more than WebGPU's default 8 storage buffers.
 */
export interface WorkLayout {
  slotState: number;
  slotRender: number;
  physOwner: number;
  physLastUsed: number;
  lists: number; // free | old | recent, pageCount each
  /**
   * The pages drawn this frame: the static list first (S pages, renderBudget at
   * most), then, with the static cache, the dynamic list after it.
   */
  renderList: number;
  /**
   * Draw args, 4 u32 each: clear, opaque, alpha (the static casters, S pages),
   * then composite, dynamic opaque, dynamic alpha (the static cache). Word 13,
   * the composite's instance count, is the number of pages drawn this frame
   * (S, or S + D with the cache); the min/max build reads it.
   */
  indirect: number;
  /**
   * The cull's dispatchWorkgroupsIndirect args (3 u32), written by
   * finalizeRenderList. The work buffer is bound writable in the paging pass,
   * and a buffer may not be writable storage and indirect in one dispatch, so
   * the host copies these 12 bytes into a separate indirect buffer.
   */
  dispatch: number;
  total: number;
}

export function workLayout(slots: number, pages: number, renderListMax: number): WorkLayout {
  const slotState = 0;
  const slotRender = slotState + slots;
  const physOwner = slotRender + slots;
  const physLastUsed = physOwner + pages;
  const lists = physLastUsed + pages;
  const renderList = lists + pages * 3;
  const indirect = renderList + renderListMax;
  const dispatch = indirect + 24;
  return { slotState, slotRender, physOwner, physLastUsed, lists, renderList, indirect, dispatch, total: dispatch + 4 };
}

/**
 * Shared by the kernels and the raster stage: sceneData holds clusters then instances, 3 vec4f each.
 * A cluster's indices are local to its geometry; vertexBase is where that geometry's vertices start.
 */
export const SCENE_WGSL = /* wgsl */ `
struct PsCluster { aabbMin: vec3f, aabbMax: vec3f, firstIndex: u32, triCount: u32, alphaLayer: u32, alphaCutoff: f32, vertexBase: u32 };
struct PsInstance { r0: vec4f, r1: vec4f, r2: vec4f };

fn psCluster(i: u32) -> PsCluster {
  let a = sceneData[i * 3u];
  let b = sceneData[i * 3u + 1u];
  let c = sceneData[i * 3u + 2u];
  return PsCluster(a.xyz, b.xyz, bitcast<u32>(a.w), bitcast<u32>(b.w), bitcast<u32>(c.x), c.y, bitcast<u32>(c.z));
}

fn psInstance(i: u32) -> PsInstance {
  let base = (psParams.misc.w + i) * 3u;
  return PsInstance(sceneData[base], sceneData[base + 1u], sceneData[base + 2u]);
}
`;

export function kernelsWGSL(w: WorkLayout, maxPairs: number): string {
  return /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<storage, read> psParams: PsParams;
@group(0) @binding(1) var<storage, read_write> psPageTable: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> psRequests: array<u32>;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> work: array<u32>;
@group(0) @binding(5) var<storage, read> sceneData: array<vec4f>;
@group(0) @binding(6) var<storage, read> clusterInstances: array<vec2u>;
@group(0) @binding(7) var<storage, read_write> pairs: array<vec2u>;   // opaque | alpha, maxPairs each

${SCENE_WGSL}

const W_SLOT_STATE: u32 = ${w.slotState}u;
const W_SLOT_RENDER: u32 = ${w.slotRender}u;
const W_PHYS_OWNER: u32 = ${w.physOwner}u;
const W_PHYS_LAST: u32 = ${w.physLastUsed}u;
const W_LISTS: u32 = ${w.lists}u;
const W_RENDER_LIST: u32 = ${w.renderList}u;
const W_INDIRECT: u32 = ${w.indirect}u;
const W_DISPATCH: u32 = ${w.dispatch}u;
const C_LEVEL_RECT: u32 = ${C_LEVEL_RECT}u;
const MAX_PAIRS: u32 = ${maxPairs}u;
// Static cache: the page's live depth is out of date where dynamic casters
// moved, but its static depth (staticPool) is good. Such a page is not valid
// (receivers fall back) until the dynamic list composites it and redraws the
// dynamic casters over it, the same frame when the budget allows. Kernel-only:
// receivers test PS_VALID alone.
const PS_STALE: u32 = 0x40000u;

fn slotCount() -> u32 { return psParams.grid.x * psParams.grid.y * psParams.grid.y; }

// Absolute page coords that local slot (sx, sy) of a level currently stands for.
fn slotPage(lv: PsLevel, local: u32, n: u32) -> vec2i {
  let ni = i32(n);
  let sx = i32(local % n);
  let sy = i32(local / n);
  return vec2i(lv.window.x + psWrap(sx - lv.window.x, ni), lv.window.y + psWrap(sy - lv.window.y, ni));
}

// Page rect of a light-space box (centre, half size), clamped to the level's window.
fn pageRectLs(lv: PsLevel, cxy: vec2f, hxy: vec2f, n: i32) -> vec4i {
  let p0 = max(vec2i(floor((cxy - hxy) * lv.up.w)), lv.window.xy);
  let p1 = min(vec2i(floor((cxy + hxy) * lv.up.w)), lv.window.xy + vec2i(n - 1));
  return vec4i(p0, p1);
}

// Light-space page rect of a world AABB (centre, half extents).
fn pageRect(lv: PsLevel, c: vec3f, e: vec3f, n: i32) -> vec4i {
  let cxy = vec2f(dot(c, lv.right.xyz), dot(c, lv.up.xyz));
  return pageRectLs(lv, cxy, vec2f(dot(e, abs(lv.right.xyz)), dot(e, abs(lv.up.xyz))), n);
}

// Static cache values the host packs into levels[0].flags (y, z, w are unused
// by every level otherwise): the dynamic invalidation regions (after the
// static ones in psParams.regions), the dynamic page budget, and the first
// dynamic cluster instance (dynamic cluster instances come last; without the
// cache, or without dynamic casters, this is the cluster instance count).
fn dynRegionCount() -> u32 { return psParams.levels[0].flags.y; }
fn dynBudget() -> u32 { return psParams.levels[0].flags.z; }
fn dynFirst() -> u32 { return psParams.levels[0].flags.w; }

// A cluster instance as an oriented box: world centre and half axes.
struct PsBox { c: vec3f, a0: vec3f, a1: vec3f, a2: vec3f };

fn clusterBox(cl: PsCluster, m: PsInstance) -> PsBox {
  let lc = (cl.aabbMin + cl.aabbMax) * 0.5;
  let le = (cl.aabbMax - cl.aabbMin) * 0.5;
  var b: PsBox;
  b.c = vec3f(dot(m.r0.xyz, lc) + m.r0.w, dot(m.r1.xyz, lc) + m.r1.w, dot(m.r2.xyz, lc) + m.r2.w);
  // The transformed cluster box is an oriented box with these half axes.
  // Projecting it straight onto each level's light axes is its exact extent;
  // going through a world AABB first inflated it twice.
  b.a0 = vec3f(m.r0.x, m.r1.x, m.r2.x) * le.x;
  b.a1 = vec3f(m.r0.y, m.r1.y, m.r2.y) * le.y;
  b.a2 = vec3f(m.r0.z, m.r1.z, m.r2.z) * le.z;
  return b;
}

// The page rect (clamped to the window) a cluster box covers at one level.
fn boxPageRect(b: PsBox, lv: PsLevel, n: i32) -> vec4i {
  let ax = lv.right.xyz;
  let ay = lv.up.xyz;
  // Exact support of the box, plus 1/1000 of a page so f32 rounding (the
  // vertex stage transforms in another order) can never shave a triangle off
  // a page it reaches: 1/8 texel at 128 texels a page, while a triangle must
  // reach half a texel into a page to cover a sample there.
  let pad = 1e-3 * lv.right.w;
  let h = vec2f(abs(dot(ax, b.a0)) + abs(dot(ax, b.a1)) + abs(dot(ax, b.a2)),
                abs(dot(ay, b.a0)) + abs(dot(ay, b.a1)) + abs(dot(ay, b.a2))) + vec2f(pad);
  return pageRectLs(lv, vec2f(dot(b.c, ax), dot(b.c, ay)), h, n);
}

// K1: retag scrolled slots, apply level invalidation, gather requests.
@compute @workgroup_size(64)
fn updateSlots(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= slotCount()) { return; }
  let n = psParams.grid.y;
  let level = idx / (n * n);
  let lv = psParams.levels[level];
  let page = slotPage(lv, idx % (n * n), n);
  let tag = psPackTag(page.x, page.y);

  var e = psPageTable[idx];
  if (lv.flags.x != 0u || e.y != tag) {
    e.x = e.x & ~(PS_VALID | PS_STALE);
    e.y = tag;
  }
  var requested = psRequests[idx] != 0u;
  // The coarsest level stays resident over the whole scene, so a missing
  // fine page always has something to fall back to.
  if (level == psParams.grid.x - 1u &&
      page.x >= lv.scene.x && page.y >= lv.scene.y && page.x <= lv.scene.z && page.y <= lv.scene.w) {
    requested = true;
  }
  if (requested) {
    atomicAdd(&counters[${C_REQUESTED}], 1u);
    if ((e.x & PS_MAPPED) != 0u) { work[W_PHYS_LAST + (e.x & PS_PHYS_MASK)] = psParams.grid.z; }
  }
  psPageTable[idx] = e;
  work[W_SLOT_STATE + idx] = select(0u, 1u, requested);
  work[W_SLOT_RENDER + idx] = PS_NONE;
}

// K2: moving casters and edits dirty the pages their light-space bounds touch.
@compute @workgroup_size(64)
fn invalidateRegions(@builtin(global_invocation_id) gid: vec3u) {
  let nl = psParams.grid.x;
  let r = gid.x / nl;
  let level = gid.x % nl;
  if (r >= psParams.misc.x) { return; }
  let lo = psParams.regions[r * 2u].xyz;
  let hi = psParams.regions[r * 2u + 1u].xyz;
  let n = i32(psParams.grid.y);
  let rect = pageRect(psParams.levels[level], (lo + hi) * 0.5, (hi - lo) * 0.5, n);
  for (var y = rect.y; y <= rect.w; y++) {
    for (var x = rect.x; x <= rect.z; x++) {
      let s = psSlotIndex(level, x, y, u32(n));
      psPageTable[s].x = psPageTable[s].x & ~(PS_VALID | PS_STALE);
    }
  }
}

// K2d (static cache): dynamic casters moved. Their old and new bounds come as
// regions after the static ones; every valid page they touch keeps its static
// depth and only needs its dynamic casters redrawn: mark it stale. Runs before
// invalidateRegions, so a page a static edit also touched ends up needing a
// full render (that kernel clears PS_STALE with PS_VALID).
@compute @workgroup_size(64)
fn markDynamicRegions(@builtin(global_invocation_id) gid: vec3u) {
  let nl = psParams.grid.x;
  let r = gid.x / nl;
  let level = gid.x % nl;
  if (r >= dynRegionCount()) { return; }
  let k = psParams.misc.x + r;
  let lo = psParams.regions[k * 2u].xyz;
  let hi = psParams.regions[k * 2u + 1u].xyz;
  let n = i32(psParams.grid.y);
  let rect = pageRect(psParams.levels[level], (lo + hi) * 0.5, (hi - lo) * 0.5, n);
  for (var y = rect.y; y <= rect.w; y++) {
    for (var x = rect.x; x <= rect.z; x++) {
      let s = psSlotIndex(level, x, y, u32(n));
      let e = psPageTable[s].x;
      // Every writer stores the same bits, so overlapping regions do not race.
      if ((e & PS_VALID) != 0u) { psPageTable[s].x = (e & ~PS_VALID) | PS_STALE; }
    }
  }
}

// K3: sort physical pages into free / old / recently-used candidate lists.
@compute @workgroup_size(64)
fn collectPhys(@builtin(global_invocation_id) gid: vec3u) {
  let p = gid.x;
  let count = psParams.pool.w;
  if (p >= count) { return; }
  let owner = work[W_PHYS_OWNER + p];
  if (owner == 0u) {
    work[W_LISTS + atomicAdd(&counters[${C_FREE}], 1u)] = p;
    return;
  }
  atomicAdd(&counters[${C_RESIDENT}], 1u);
  if (work[W_SLOT_STATE + owner - 1u] != 0u) { return; }
  if (psParams.grid.z - work[W_PHYS_LAST + p] > ${OLD_AGE}u) {
    work[W_LISTS + count + atomicAdd(&counters[${C_OLD}], 1u)] = p;
  } else {
    work[W_LISTS + count * 2u + atomicAdd(&counters[${C_RECENT}], 1u)] = p;
  }
}

// K4: give every requested, unmapped slot a physical page, evicting the
// longest-unused pages first. A failed allocation just falls back a level.
@compute @workgroup_size(64)
fn allocate(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= slotCount() || work[W_SLOT_STATE + idx] == 0u) { return; }
  var e = psPageTable[idx];
  if ((e.x & PS_MAPPED) != 0u) { return; }
  let count = psParams.pool.w;
  let nFree = atomicLoad(&counters[${C_FREE}]);
  let nOld = atomicLoad(&counters[${C_OLD}]);
  let nRecent = atomicLoad(&counters[${C_RECENT}]);
  let i = atomicAdd(&counters[${C_ALLOC}], 1u);
  var p = PS_NONE;
  if (i < nFree) {
    p = work[W_LISTS + i];
  } else if (i < nFree + nOld) {
    p = work[W_LISTS + count + i - nFree];
  } else if (i < nFree + nOld + nRecent) {
    p = work[W_LISTS + count * 2u + i - nFree - nOld];
  }
  if (p == PS_NONE) {
    atomicAdd(&counters[${C_ALLOC_FAIL}], 1u);
    return;
  }
  let prev = work[W_PHYS_OWNER + p];
  if (prev != 0u) {
    psPageTable[prev - 1u].x = 0u;
  }
  work[W_PHYS_OWNER + p] = idx + 1u;
  work[W_PHYS_LAST + p] = psParams.grid.z;
  e.x = p | PS_MAPPED;
  psPageTable[idx] = e;
}

// K5: every requested page that is mapped but stale gets rendered, up to budget.
// Two dispatches, coarsest level first: it is the fallback every finer page
// relies on, and with no valid page at all a receiver is fully lit. Filled in
// one atomic order, the coarsest slots (the highest indices) came last and were
// the first to be deferred when the budget overflowed.
@compute @workgroup_size(64)
fn buildRenderListCoarse(@builtin(global_invocation_id) gid: vec3u) {
  let perLevel = psParams.grid.y * psParams.grid.y;
  if (gid.x >= perLevel) { return; }
  listPage((psParams.grid.x - 1u) * perLevel + gid.x);
}

@compute @workgroup_size(64)
fn buildRenderListFine(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= (psParams.grid.x - 1u) * psParams.grid.y * psParams.grid.y) { return; }
  listPage(gid.x);
}

fn listPage(idx: u32) {
  if (idx >= slotCount() || work[W_SLOT_STATE + idx] == 0u) { return; }
  let e = psPageTable[idx];
  // A stale page's static depth is good: the dynamic list takes it.
  if ((e.x & PS_MAPPED) == 0u || (e.x & (PS_VALID | PS_STALE)) != 0u) { return; }
  let r = atomicAdd(&counters[${C_RENDER}], 1u);
  if (r >= psParams.grid.w) {
    atomicAdd(&counters[${C_DEFERRED}], 1u);
    return;
  }
  work[W_RENDER_LIST + r] = idx;
  work[W_SLOT_RENDER + idx] = r;
  psPageTable[idx].x = e.x | PS_VALID;
  // Grow this level's rect of rendered pages (see C_LEVEL_RECT), so the cull
  // skips levels, and the parts of levels, where nothing is being drawn.
  let n = psParams.grid.y;
  let level = idx / (n * n);
  let local = vec2u(psUnpackTag(e.y) - psParams.levels[level].window.xy);
  let o = C_LEVEL_RECT + level * 4u;
  atomicMax(&counters[o], n - local.x);
  atomicMax(&counters[o + 1u], n - local.y);
  atomicMax(&counters[o + 2u], local.x + 1u);
  atomicMax(&counters[o + 3u], local.y + 1u);
}

@compute @workgroup_size(1)
fn finalizeRenderList() {
  let rendered = min(atomicLoad(&counters[${C_RENDER}]), psParams.grid.w);
  work[W_INDIRECT + 0u] = 6u;
  work[W_INDIRECT + 1u] = rendered;
  work[W_INDIRECT + 2u] = 0u;
  work[W_INDIRECT + 3u] = 0u;
  // Pages drawn this frame, for the min/max build; finalizeDynamicList adds its own.
  work[W_INDIRECT + 12u] = 6u;
  work[W_INDIRECT + 13u] = rendered;
  work[W_INDIRECT + 14u] = 0u;
  work[W_INDIRECT + 15u] = 0u;
  // The cull runs one thread per static cluster instance. On the common static
  // frame (no page to render) it is not launched at all, instead of being
  // launched over the whole scene only for every thread to return.
  work[W_DISPATCH + 0u] = select(0u, (dynFirst() + 63u) / 64u, rendered > 0u);
  work[W_DISPATCH + 1u] = 1u;
  work[W_DISPATCH + 2u] = 1u;
}

// K5d (static cache): every requested stale page is composited from the static
// pool and gets its dynamic casters redrawn, up to dynamicBudget, coarsest
// level first as in K5. Its entries follow the static list's. A page over
// budget stays stale (receivers fall back a level) and is taken next frame.
@compute @workgroup_size(64)
fn buildDynamicListCoarse(@builtin(global_invocation_id) gid: vec3u) {
  let perLevel = psParams.grid.y * psParams.grid.y;
  if (gid.x >= perLevel) { return; }
  listDynamicPage((psParams.grid.x - 1u) * perLevel + gid.x);
}

@compute @workgroup_size(64)
fn buildDynamicListFine(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= (psParams.grid.x - 1u) * psParams.grid.y * psParams.grid.y) { return; }
  listDynamicPage(gid.x);
}

fn listDynamicPage(idx: u32) {
  if (idx >= slotCount() || work[W_SLOT_STATE + idx] == 0u) { return; }
  let e = psPageTable[idx];
  if ((e.x & (PS_MAPPED | PS_VALID | PS_STALE)) != (PS_MAPPED | PS_STALE)) { return; }
  let d = atomicAdd(&counters[${C_DYN_PAGES}], 1u);
  if (d >= dynBudget()) {
    atomicAdd(&counters[${C_DYN_DEFERRED}], 1u);
    return;
  }
  // After the static list's entries (finalizeRenderList wrote their count).
  let r = work[W_INDIRECT + 1u] + d;
  work[W_RENDER_LIST + r] = idx;
  work[W_SLOT_RENDER + idx] = r;
  psPageTable[idx].x = (e.x | PS_VALID) & ~PS_STALE;
}

@compute @workgroup_size(1)
fn finalizeDynamicList() {
  work[W_INDIRECT + 13u] = work[W_INDIRECT + 1u] + min(atomicLoad(&counters[${C_DYN_PAGES}]), dynBudget());
}

// Each level's rect of rendered pages, absolute page coords (min.xy, max.zw);
// empty (min > max) where the level renders nothing this frame.
var<workgroup> renderedRects: array<vec4i, PS_MAX_LEVELS>;
// Static pages this frame (x), and the room the dynamic pairs left in the
// opaque (y) and alpha (z) lists.
var<workgroup> cullLimits: vec3u;

// K6: pair every static cluster instance with each static page being rendered
// that it overlaps. Dispatched indirectly: not at all on a frame that renders
// no static page. With the static cache, dynamic cluster instances (the last
// ones) are paired by cullDynamicClusters instead.
@compute @workgroup_size(64)
fn cullClusters(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  let n = i32(psParams.grid.y);
  // One load per level per workgroup instead of four atomics per level per thread.
  if (li < psParams.grid.x) {
    let o = C_LEVEL_RECT + li * 4u;
    let w = psParams.levels[li].window.xy;
    let lo = w + vec2i(n) - vec2i(i32(atomicLoad(&counters[o])), i32(atomicLoad(&counters[o + 1u])));
    let hi = w + vec2i(i32(atomicLoad(&counters[o + 2u])), i32(atomicLoad(&counters[o + 3u]))) - vec2i(1);
    renderedRects[li] = vec4i(lo, hi);
  }
  if (li == 0u) {
    // The dynamic cull ran first (see update), so its pair counts are final.
    cullLimits = vec3u(work[W_INDIRECT + 1u],
                       MAX_PAIRS - min(atomicLoad(&counters[${C_DYN_OPAQUE_PAIRS}]), MAX_PAIRS),
                       MAX_PAIRS - min(atomicLoad(&counters[${C_DYN_ALPHA_PAIRS}]), MAX_PAIRS));
  }
  workgroupBarrier();
  let i = gid.x;
  if (i >= dynFirst()) { return; }
  let ci = clusterInstances[i];
  let cl = psCluster(ci.x);
  let b = clusterBox(cl, psInstance(ci.y));
  let isAlpha = cl.alphaLayer != PS_NONE;
  let limits = cullLimits;
  for (var level = 0u; level < psParams.grid.x; level++) {
    let live = renderedRects[level];
    if (live.x > live.z) { continue; }
    let full = boxPageRect(b, psParams.levels[level], n);
    let rect = vec4i(max(full.xy, live.xy), min(full.zw, live.zw));
    for (var y = rect.y; y <= rect.w; y++) {
      for (var x = rect.x; x <= rect.z; x++) {
        let r = work[W_SLOT_RENDER + psSlotIndex(level, x, y, u32(n))];
        // Static casters draw into static pages only (the static list's
        // entries come first); dynamic-list pages keep their static depth.
        if (r >= limits.x) { continue; }
        var fits: bool;
        if (isAlpha) {
          let k = atomicAdd(&counters[${C_ALPHA_PAIRS}], 1u);
          fits = k < limits.z;
          if (fits) { pairs[MAX_PAIRS + k] = vec2u(i, r); }
        } else {
          let k = atomicAdd(&counters[${C_OPAQUE_PAIRS}], 1u);
          fits = k < limits.y;
          if (fits) { pairs[k] = vec2u(i, r); }
        }
        // Pair list full: this page is drawn without this cluster. listPage
        // already marked it valid, so it would keep the hole until its next
        // invalidation. Unmark it: receivers fall back a level this frame and
        // it is rendered again next frame. Every writer stores the same bits,
        // and the raster reads only the phys and tag fields.
        if (!fits) {
          let slot = work[W_RENDER_LIST + r];
          psPageTable[slot].x = psPageTable[slot].x & ~(PS_VALID | PS_STALE);
        }
      }
    }
  }
}

// K6d (static cache): pair every dynamic cluster instance with each page drawn
// this frame that it overlaps, static and dynamic list alike: a static page is
// composited into the live pool too, so it needs its dynamic casters redrawn.
// Dispatched over the dynamic cluster instances only, before the static cull;
// its pairs fill each list from the end, downwards.
@compute @workgroup_size(64)
fn cullDynamicClusters(@builtin(global_invocation_id) gid: vec3u) {
  let i = dynFirst() + gid.x;
  if (i >= psParams.misc.y || work[W_INDIRECT + 13u] == 0u) { return; }
  let ci = clusterInstances[i];
  let m = psInstance(ci.y);
  // A collapsed (zero-scale) instance casts nothing: its box would be a point
  // at a meaningless translation.
  if (all(m.r0.xyz == vec3f(0.0)) && all(m.r1.xyz == vec3f(0.0)) && all(m.r2.xyz == vec3f(0.0))) { return; }
  let cl = psCluster(ci.x);
  let b = clusterBox(cl, m);
  let isAlpha = cl.alphaLayer != PS_NONE;
  let n = i32(psParams.grid.y);
  for (var level = 0u; level < psParams.grid.x; level++) {
    let rect = boxPageRect(b, psParams.levels[level], n);
    for (var y = rect.y; y <= rect.w; y++) {
      for (var x = rect.x; x <= rect.z; x++) {
        let r = work[W_SLOT_RENDER + psSlotIndex(level, x, y, u32(n))];
        if (r == PS_NONE) { continue; }
        var k: u32;
        if (isAlpha) {
          k = atomicAdd(&counters[${C_DYN_ALPHA_PAIRS}], 1u);
          if (k < MAX_PAIRS) { pairs[MAX_PAIRS * 2u - 1u - k] = vec2u(i, r); }
        } else {
          k = atomicAdd(&counters[${C_DYN_OPAQUE_PAIRS}], 1u);
          if (k < MAX_PAIRS) { pairs[MAX_PAIRS - 1u - k] = vec2u(i, r); }
        }
        // Full: the page's static depth is still good, so it only needs its
        // dynamic casters again: stale, for next frame's dynamic list. The
        // static cull runs after this one, and a static overflow on the same
        // page clears PS_STALE as well (it then needs a full render).
        if (k >= MAX_PAIRS) {
          let slot = work[W_RENDER_LIST + r];
          psPageTable[slot].x = (psPageTable[slot].x & ~PS_VALID) | PS_STALE;
        }
      }
    }
  }
}

// Static pairs fill each list from the front and dynamic ones from the end;
// the static cull stopped where the dynamic pairs begin.
@compute @workgroup_size(1)
fn finalizeDraws() {
  let dynOpaque = min(atomicLoad(&counters[${C_DYN_OPAQUE_PAIRS}]), MAX_PAIRS);
  let dynAlpha = min(atomicLoad(&counters[${C_DYN_ALPHA_PAIRS}]), MAX_PAIRS);
  work[W_INDIRECT + 5u] = min(atomicLoad(&counters[${C_OPAQUE_PAIRS}]), MAX_PAIRS - dynOpaque);
  work[W_INDIRECT + 9u] = min(atomicLoad(&counters[${C_ALPHA_PAIRS}]), MAX_PAIRS - dynAlpha);
  work[W_INDIRECT + 17u] = dynOpaque;
  work[W_INDIRECT + 21u] = dynAlpha;
}
`;
}

/**
 * K0: page marking from the camera depth of the previous frame. Every visible
 * surface requests the page it wants at the level whose texels match its
 * on-screen footprint (the same rule the receiver samples with). Marking lives
 * here, not in the receiver, so material shaders stay read-only and keep early-Z.
 */
export function markWGSL(multisampled: boolean): string {
  return /* wgsl */ `
${COMMON_WGSL}

@group(0) @binding(0) var<storage, read> psParams: PsParams;
@group(0) @binding(2) var<storage, read_write> psRequests: array<u32>;
@group(1) @binding(0) var depthTex: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};

@compute @workgroup_size(8, 8)
fn markPages(@builtin(global_invocation_id) gid: vec3u) {
  let stride = u32(psParams.screen.z);
  // One sample per stride x stride cell: its centre, or with rotation on
  // (shade.z), a different pixel of the cell every frame, so that over
  // stride^2 frames every pixel is sampled. A page is only evicted after going
  // unrequested for OLD_AGE frames, so a sparser stride keeps what it misses in
  // one frame resident through the next.
  var offset = vec2u(stride / 2u);
  if (psParams.shade.z != 0.0) {
    let k = psParams.grid.z % (stride * stride);
    offset = vec2u(k % stride, (k / stride + k % stride) % stride);
  }
  let px = gid.xy * stride + offset;
  let size = vec2u(psParams.screen.xy);
  if (px.x >= size.x || px.y >= size.y) { return; }
  let d = textureLoad(depthTex, vec2i(px), 0);
  if (d >= 1.0) { return; }
  let ndc = vec4f((f32(px.x) + 0.5) / f32(size.x) * 2.0 - 1.0, 1.0 - (f32(px.y) + 0.5) / f32(size.y) * 2.0, d, 1.0);
  let h = psParams.invViewProj * ndc;
  let pos = h.xyz / h.w;

  let nl = psParams.grid.x;
  let n = i32(psParams.grid.y);
  let footprint = max(distance(pos, psParams.camera.xyz) * psParams.camera.w, 1e-6);
  let wanted = ceil(log2(footprint / psParams.levels[0].dir.w) + psParams.tuning.x);
  for (var level = u32(clamp(wanted, 0.0, f32(nl - 1u))); level < nl; level++) {
    let lv = psParams.levels[level];
    let page = vec2i(floor(vec2f(dot(pos, lv.right.xyz), dot(pos, lv.up.xyz)) * lv.up.w));
    if (psInWindow(lv, page, n)) {
      // Casters lie inside the scene bounds (the host fits them so), so a page
      // outside the scene's light-space rect can hold no caster: it would be
      // allocated and cleared for nothing (sky, water, terrain past the sim
      // edge). A receiver there finds no page and is lit, as a cleared page
      // would light it. The rect is padded by a page against f32 rounding at
      // its edge; every coarser level's rect covers the same ground, so stop.
      if (page.x < lv.scene.x - 1 || page.y < lv.scene.y - 1 || page.x > lv.scene.z + 1 || page.y > lv.scene.w + 1) { return; }
      let slot = psSlotIndex(level, page.x, page.y, u32(n));
      if (psRequests[slot] == 0u) { psRequests[slot] = 1u; }
      return;
    }
  }
}
`;
}
