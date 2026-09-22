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

fn caster(vi: u32, pairIndex: u32) -> CasterOut {
  var out: CasterOut;
  let pair = pairs[pairIndex];
  let ci = clusterInstances[pair.x];
  let cl = psCluster(ci.x);
  if (vi / 3u >= cl.triCount) {
    out.pos = vec4f(0.0, 0.0, 2.0, 1.0);   // padding triangle: outside the depth range
    ${clipCull}
    return out;
  }
  let vtx = indices[cl.firstIndex + vi] + cl.vertexBase;
  let lp = vec3f(vertices[vtx * 5u], vertices[vtx * 5u + 1u], vertices[vtx * 5u + 2u]);
  let m = psInstance(ci.y);
  let wp = vec3f(dot(m.r0.xyz, lp) + m.r0.w, dot(m.r1.xyz, lp) + m.r1.w, dot(m.r2.xyz, lp) + m.r2.w);

  let info = pageInfo(pair.y);
  let lv = psParams.levels[info.level];
  let pageUv = vec2f(dot(wp, lv.right.xyz), dot(wp, lv.up.xyz)) * lv.up.w - vec2f(info.page);
  let atlas = info.atlasOrigin + pageUv * f32(psParams.pool.z);
  let depth = (dot(wp, lv.dir.xyz) - lv.depth.x) * lv.depth.y;
  out.pos = vec4f(atlasToClip(atlas), clamp(depth, 0.0, 1.0), 1.0);
  ${clipAssign}
  out.pageUv = pageUv;
  out.uv = vec2f(vertices[vtx * 5u + 3u], vertices[vtx * 5u + 4u]);
  out.alpha = vec2u(cl.alphaLayer, bitcast<u32>(cl.alphaCutoff));
  return out;
}

@vertex
fn opaqueVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CasterOut {
  return caster(vi, ii);
}

@vertex
fn alphaVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CasterOut {
  return caster(vi, MAX_PAIRS + ii);
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
