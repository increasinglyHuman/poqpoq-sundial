// Shared WGSL for Sundial: the data layout every kernel, raster pipeline and
// receiver agrees on. Engine adapters splice RECEIVER_WGSL into their own
// fragment shaders after declaring the four bindings listed there.

export const MAX_LEVELS = 8;

/** Byte size of one PsLevel (7 × vec4). */
export const LEVEL_BYTES = 7 * 16;
/** Byte offset of the invalidation regions that trail PsParams. */
export const PARAMS_HEADER_BYTES = 5 * 16 + 64 + 2 * 16 + MAX_LEVELS * LEVEL_BYTES;
/** u32 word offset of levels[0] in PsParams. */
export const LEVELS_WORD = (5 * 16 + 64 + 2 * 16) / 4;
/** u32 word offset of PsParams.shade. */
export const SHADE_WORD = (5 * 16 + 64 + 16) / 4;
/** Invalidation boxes accepted per frame (each is two vec4f). */
export const MAX_REGIONS = 256;
export const PARAMS_BYTES = PARAMS_HEADER_BYTES + MAX_REGIONS * 32;

export const COMMON_WGSL = /* wgsl */ `
const PS_MAX_LEVELS: u32 = ${MAX_LEVELS}u;
const PS_PHYS_MASK: u32 = 0xFFFFu;
const PS_MAPPED: u32 = 0x10000u;
const PS_VALID: u32 = 0x20000u;
const PS_NONE: u32 = 0xFFFFFFFFu;

// One clipmap level. Each level keeps its own frozen light basis so that a
// moving sun only invalidates a level once it drifts past that level's band.
struct PsLevel {
  right: vec4f,   // xyz light-space X axis, w = page world size
  up: vec4f,      // xyz light-space Y axis, w = 1 / page world size
  dir: vec4f,     // xyz light direction,    w = texel world size
  depth: vec4f,   // x = zMin, y = 1 / zRange, z = zRange
  window: vec4i,  // xy = absolute page coords of the window origin
  scene: vec4i,   // xy..zw = page rect covered by the scene bounds
  flags: vec4u,   // x = invalidate every page of this level this frame
};

struct PsParams {
  camera: vec4f,  // xyz eye, w = world size of one screen pixel at 1 m
  tuning: vec4f,  // x = lod bias, y = normal offset (texels), z = depth bias (texels), w = debug mode
  pool: vec4u,    // x = pool texels per side, y = pages per row, z = page texels, w = page count
  grid: vec4u,    // x = level count, y = pages per window side, z = frame, w = render budget
  misc: vec4u,    // x = invalidation region count, y = cluster instance count, z = max pairs, w = cluster count
  invViewProj: mat4x4f, // camera clip -> world, for the frame whose depth is being marked
  screen: vec4f,  // x = depth width, y = depth height, z = marking stride in pixels, w = 1 when depth is bound
  shade: vec4f,   // x = darkness: light left in full shadow (0 = black, 1 = no shadow), as Babylon's setDarkness
  levels: array<PsLevel, PS_MAX_LEVELS>,
  regions: array<vec4f>, // world-space invalidation boxes as (min, max) pairs
};

fn psWrap(a: i32, n: i32) -> i32 { return ((a % n) + n) % n; }

// Toroidal addressing: a page keeps its slot while the window scrolls past it.
fn psSlotIndex(level: u32, ax: i32, ay: i32, n: u32) -> u32 {
  let ni = i32(n);
  return level * n * n + u32(psWrap(ay, ni)) * n + u32(psWrap(ax, ni));
}

fn psPackTag(ax: i32, ay: i32) -> u32 {
  return (u32(ax) & 0xFFFFu) | ((u32(ay) & 0xFFFFu) << 16u);
}

fn psUnpackTag(t: u32) -> vec2i {
  return vec2i(i32(t << 16u) >> 16u, i32(t) >> 16u);
}

fn psInWindow(lv: PsLevel, page: vec2i, n: i32) -> bool {
  return page.x >= lv.window.x && page.y >= lv.window.y &&
         page.x < lv.window.x + n && page.y < lv.window.y + n;
}
`;

/**
 * Receiver: expects these bindings to be declared by the host shader —
 *   var<storage, read> psParams: PsParams;
 *   var<storage, read> psPageTable: array<vec2u>;
 *   var psPool: texture_depth_2d;
 * It is strictly read-only. Measured on Intel Xe-LPG: merely *containing* a
 * storage write, even one that never executes, disables early-Z for every
 * material that includes the receiver (+13 ms in a forest). Page requests are
 * therefore made by a compute pass over the camera depth, never here.
 * Uses textureLoad only: no sampler, and no derivatives, so it is safe in
 * non-uniform control flow.
 */
export const RECEIVER_WGSL = /* wgsl */ `
var<private> psDebugLevel: f32 = -1.0;

fn psLookup(level: u32, page: vec2i) -> u32 {
  let n = psParams.grid.y;
  if (!psInWindow(psParams.levels[level], page, i32(n))) { return 0u; }
  let e = psPageTable[psSlotIndex(level, page.x, page.y, n)];
  if ((e.x & PS_VALID) == 0u || e.y != psPackTag(page.x, page.y)) { return 0u; }
  return (e.x & PS_PHYS_MASK) + 1u;
}

fn psFetch(level: u32, centerPage: vec2i, centerPhys: u32, t: vec2i) -> f32 {
  let s = i32(psParams.pool.z);
  let page = vec2i(floor(vec2f(t) / f32(s)));
  var phys = centerPhys;
  var local = t - page * s;
  if (any(page != centerPage)) {
    let p = psLookup(level, page);
    if (p == 0u) {
      local = clamp(t - centerPage * s, vec2i(0), vec2i(s - 1));
    } else {
      phys = p - 1u;
    }
  }
  let row = psParams.pool.y;
  let atlas = vec2i(i32(phys % row) * s, i32(phys / row) * s) + local;
  return textureLoad(psPool, atlas, 0);
}

// Light factor for a receiver: 1 fully lit, the darkness in full shadow.
fn psShadow(posW: vec3f, normalW: vec3f) -> f32 {
  // Fully faded (INVISIBLE_DARKNESS): the result would be 1 whatever the lookup says. Uniform branch.
  if (psParams.shade.x >= 0.999) { return 1.0; }
  return mix(psParams.shade.x, 1.0, psVisibility(posW, normalW));
}

// psShadow for surfaces that only take light on their front: one facing away
// from the sun gets no direct light, so it is in full shadow without a lookup.
// Not for two-sided or translucent materials, whose back is lit through.
fn psShadowFront(posW: vec3f, normalW: vec3f) -> f32 {
  if (psParams.shade.x >= 0.999) { return 1.0; }
  if (dot(normalW, psParams.levels[0].dir.xyz) > 0.0) { return psParams.shade.x; }
  return mix(psParams.shade.x, 1.0, psVisibility(posW, normalW));
}

// Returns 1 for fully lit, 0 for fully shadowed.
fn psVisibility(posW: vec3f, normalW: vec3f) -> f32 {
  let nl = psParams.grid.x;
  let n = i32(psParams.grid.y);
  let s = f32(psParams.pool.z);
  let footprint = max(distance(posW, psParams.camera.xyz) * psParams.camera.w, 1e-6);
  let wanted = ceil(log2(footprint / psParams.levels[0].dir.w) + psParams.tuning.x);
  var level = u32(clamp(wanted, 0.0, f32(nl - 1u)));
  loop {
    if (level >= nl) { break; }
    let lv = psParams.levels[level];
    let p = posW + normalW * (psParams.tuning.y * lv.dir.w);
    let lp = vec2f(dot(p, lv.right.xyz), dot(p, lv.up.xyz)) * lv.up.w;
    let page = vec2i(floor(lp));
    if (psInWindow(lv, page, n)) {
      let phys1 = psLookup(level, page);
      if (phys1 != 0u) {
        psDebugLevel = f32(level);
        let z = (dot(p, lv.dir.xyz) - lv.depth.x) * lv.depth.y
              - psParams.tuning.z * lv.dir.w * lv.depth.y;
        // 3x3 bilinear PCF over a 4x4 texel footprint. The nine taps collapse to
        // separable per-texel weights (1-f, 1, 1, f), so no array is needed.
        let t = lp * s - vec2f(1.5);
        let base = vec2i(floor(t));
        let f = fract(t);
        let wx = vec4f(1.0 - f.x, 1.0, 1.0, f.x);
        let wy = vec4f(1.0 - f.y, 1.0, 1.0, f.y);
        let si = i32(psParams.pool.z);
        let local = base - page * si;
        var sum = 0.0;
        if (all(local >= vec2i(0)) && all(local + vec2i(3) < vec2i(si))) {
          // Fast path: the whole footprint lies in one page.
          let row = psParams.pool.y;
          let phys = phys1 - 1u;
          let origin = vec2i(i32(phys % row) * si, i32(phys / row) * si) + local;
          for (var j = 0; j < 4; j++) {
            var rowSum = 0.0;
            for (var i = 0; i < 4; i++) {
              rowSum += wx[i] * select(0.0, 1.0, z <= textureLoad(psPool, origin + vec2i(i, j), 0));
            }
            sum += wy[j] * rowSum;
          }
        } else {
          for (var j = 0; j < 4; j++) {
            var rowSum = 0.0;
            for (var i = 0; i < 4; i++) {
              rowSum += wx[i] * select(0.0, 1.0, z <= psFetch(level, page, phys1 - 1u, base + vec2i(i, j)));
            }
            sum += wy[j] * rowSum;
          }
        }
        return sum / 9.0;
      }
    }
    level++;
  }
  return 1.0;
}

// Scale a light colour by the shadow term; in debug mode, replace it with the
// sampled level's colour so levels read clearly even under bright light.
fn psApply(light: vec3f, shadow: f32) -> vec3f {
  if (u32(psParams.tuning.w) == 0u) { return light * shadow; }
  if (psDebugLevel < 0.0) { return vec3f(0.5) * shadow; }
  let palette = array<vec3f, 8>(
    vec3f(1.0, 0.15, 0.15), vec3f(1.0, 0.55, 0.0), vec3f(1.0, 1.0, 0.1), vec3f(1.0, 0.2, 1.0),
    vec3f(0.1, 0.9, 1.0), vec3f(0.2, 0.3, 1.0), vec3f(1.0, 1.0, 1.0), vec3f(0.5, 0.5, 0.5));
  return palette[u32(psDebugLevel) % 8u] * 0.6 * max(shadow, 0.25);
}
`;
