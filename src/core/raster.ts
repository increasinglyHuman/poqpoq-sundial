import { COMMON_WGSL } from "./wgsl";
import { SCENE_WGSL, type WorkLayout } from "./kernels";

// Raster stage. One draw per pipeline, whatever the scene size: each instance
// is a (cluster instance, page) pair, and the vertex shader pulls the triangle,
// transforms it into the page's light space and places it in the page's atlas
// rectangle. Triangles are clipped to that rectangle with clip distances when
// the device has them, and with a fragment discard otherwise.

export function rasterWGSL(w: WorkLayout, maxPairs: number, useClipDistances: boolean): string {
  const clipOut = useClipDistances ? "@builtin(clip_distances) clip: array<f32, 4>," : "";
  const clipAssign = useClipDistances
    ? "out.clip = array<f32, 4>(pageUv.x, 1.0 - pageUv.x, pageUv.y, 1.0 - pageUv.y);"
    : "";
  const clipCull = useClipDistances ? "out.clip = array<f32, 4>(-1.0, -1.0, -1.0, -1.0);" : "";
  // With clip distances the opaque pipeline has no fragment stage, so its
  // vertex stage outputs only what the rasterizer needs: no UVs, no alpha
  // record, no page UV (the discard fallback and the alpha pipeline keep them).
  // `pair` is the pair index for instance ii: static pairs count up from the
  // front of each list, dynamic ones (the static cache) down from its end.
  const opaqueEntry = (name: string, pair: string) =>
    useClipDistances
      ? `@vertex
fn ${name}(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> OpaqueOut {
  let v = casterVertex(vi, ${pair});
  var out: OpaqueOut;
  out.pos = v.pos;
  out.clip = array<f32, 4>(v.pageUv.x, 1.0 - v.pageUv.x, v.pageUv.y, 1.0 - v.pageUv.y);
  if (v.vtx == PS_NONE) { out.clip = array<f32, 4>(-1.0, -1.0, -1.0, -1.0); }
  return out;
}`
      : `@vertex
fn ${name}(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CasterOut {
  return caster(vi, ${pair});
}`;
  const opaqueVS = `${useClipDistances ? `struct OpaqueOut {
  @builtin(position) pos: vec4f,
  @builtin(clip_distances) clip: array<f32, 4>,
};` : ""}

${opaqueEntry("opaqueVS", "ii")}

${opaqueEntry("opaqueDynamicVS", "MAX_PAIRS - 1u - ii")}`;
  const clipTest = useClipDistances
    ? ""
    : "if (any(in.pageUv < vec2f(0.0)) || any(in.pageUv > vec2f(1.0))) { discard; }";
  return /* wgsl */ `
${useClipDistances ? "enable clip_distances;" : ""}
${COMMON_WGSL}

@group(0) @binding(0) var<storage, read> psParams: PsParams;
@group(0) @binding(1) var<storage, read> psPageTable: array<vec2u>;
@group(0) @binding(2) var<storage, read> work: array<u32>;
@group(0) @binding(3) var<storage, read> pairs: array<vec2u>;
@group(0) @binding(4) var<storage, read> sceneData: array<vec4f>;
@group(0) @binding(5) var<storage, read> clusterInstances: array<vec2u>;
@group(0) @binding(6) var<storage, read> vertices: array<f32>;   // x y z u v
@group(0) @binding(7) var<storage, read> indices: array<u32>;
@group(0) @binding(8) var alphaTex: texture_2d_array<f32>;
@group(0) @binding(9) var alphaSampler: sampler;
// Static cache only, and only in the pass that writes the live pool.
@group(1) @binding(0) var staticPool: texture_depth_2d;

${SCENE_WGSL}

const W_RENDER_LIST: u32 = ${w.renderList}u;
const MAX_PAIRS: u32 = ${maxPairs}u;

struct PageInfo { level: u32, page: vec2i, atlasOrigin: vec2f };

fn pageInfo(renderIndex: u32) -> PageInfo {
  let slot = work[W_RENDER_LIST + renderIndex];
  let n = psParams.grid.y;
  let e = psPageTable[slot];
  let phys = e.x & PS_PHYS_MASK;
  let row = psParams.pool.y;
  var info: PageInfo;
  info.level = slot / (n * n);
  info.page = psUnpackTag(e.y);
  info.atlasOrigin = vec2f(f32(phys % row), f32(phys / row)) * f32(psParams.pool.z);
  return info;
}

fn atlasToClip(atlas: vec2f) -> vec2f {
  let size = f32(psParams.pool.x);
  return vec2f(atlas.x / size * 2.0 - 1.0, 1.0 - atlas.y / size * 2.0);
}

// ---- page clear -----------------------------------------------------------

@vertex
fn clearVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let info = pageInfo(ii);
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let atlas = info.atlasOrigin + corners[vi] * f32(psParams.pool.z);
  return vec4f(atlasToClip(atlas), 1.0, 1.0);
}

// ---- static cache composite ----------------------------------------------
// clearVS places the quad over the page; both pools lay pages out alike, so
// the fragment's own position addresses the page's static depth.

@fragment
fn compositeFS(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  return textureLoad(staticPool, vec2i(p.xy), 0);
}

// ---- casters --------------------------------------------------------------

struct CasterOut {
  @builtin(position) pos: vec4f,
  ${clipOut}
  @location(0) pageUv: vec2f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) alpha: vec2u,   // x = layer, y = cutoff bits
};

// Clip distances are vertex outputs only, so fragments get their own struct.
struct CasterIn {
  @location(0) pageUv: vec2f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) alpha: vec2u,
};

// Position of one caster vertex in its page's atlas rectangle. vtx is the
// vertex's index, or PS_NONE for a padding triangle past the cluster's end.
struct CasterVertex { pos: vec4f, pageUv: vec2f, vtx: u32, cl: PsCluster };

fn casterVertex(vi: u32, pairIndex: u32) -> CasterVertex {
  var v: CasterVertex;
  let pair = pairs[pairIndex];
  let ci = clusterInstances[pair.x];
  v.cl = psCluster(ci.x);
  if (vi / 3u >= v.cl.triCount) {
    v.pos = vec4f(0.0, 0.0, 2.0, 1.0);   // padding triangle: outside the depth range
    v.vtx = PS_NONE;
    return v;
  }
  v.vtx = indices[v.cl.firstIndex + vi] + v.cl.vertexBase;
  let lp = vec3f(vertices[v.vtx * 5u], vertices[v.vtx * 5u + 1u], vertices[v.vtx * 5u + 2u]);
  let m = psInstance(ci.y);
  let wp = vec3f(dot(m.r0.xyz, lp) + m.r0.w, dot(m.r1.xyz, lp) + m.r1.w, dot(m.r2.xyz, lp) + m.r2.w);

  let info = pageInfo(pair.y);
  let lv = psParams.levels[info.level];
  v.pageUv = vec2f(dot(wp, lv.right.xyz), dot(wp, lv.up.xyz)) * lv.up.w - vec2f(info.page);
  let atlas = info.atlasOrigin + v.pageUv * f32(psParams.pool.z);
  let depth = (dot(wp, lv.dir.xyz) - lv.depth.x) * lv.depth.y;
  v.pos = vec4f(atlasToClip(atlas), clamp(depth, 0.0, 1.0), 1.0);
  return v;
}

fn caster(vi: u32, pairIndex: u32) -> CasterOut {
  var out: CasterOut;
  let v = casterVertex(vi, pairIndex);
  out.pos = v.pos;
  if (v.vtx == PS_NONE) {
    ${clipCull}
    return out;
  }
  let pageUv = v.pageUv;
  ${clipAssign}
  out.pageUv = pageUv;
  out.uv = vec2f(vertices[v.vtx * 5u + 3u], vertices[v.vtx * 5u + 4u]);
  out.alpha = vec2u(v.cl.alphaLayer, bitcast<u32>(v.cl.alphaCutoff));
  return out;
}

${opaqueVS}

@vertex
fn alphaVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CasterOut {
  return caster(vi, MAX_PAIRS + ii);
}

@vertex
fn alphaDynamicVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CasterOut {
  return caster(vi, MAX_PAIRS * 2u - 1u - ii);
}

@fragment
fn opaqueFS(in: CasterIn) {
  ${clipTest}
}

@fragment
fn alphaFS(in: CasterIn) {
  let a = textureSample(alphaTex, alphaSampler, in.uv, in.alpha.x).a;
  ${clipTest}
  if (a < bitcast<f32>(in.alpha.y)) { discard; }
}
`;
}
