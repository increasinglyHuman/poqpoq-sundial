import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Material } from "@babylonjs/core/Materials/material";
import type { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { WebGPUDataBuffer } from "@babylonjs/core/Meshes/WebGPU/webgpuDataBuffer";
import { PagedShadowCore, type InstanceGroup, type PagedShadowOptions } from "../core/PagedShadowCore";
import { COMMON_WGSL, RECEIVER_WGSL } from "../core/wgsl";

// Babylon adapter. The core owns every GPU resource and runs on Babylon's own
// GPUDevice from its own command encoder, submitted before Babylon's frame;
// Babylon only ever *samples* the result. That keeps the shadow pass outside
// any snapshot-rendering bundle by construction.

const MAX_LIGHTS = 4;

/** Collapses an instance to a point: it casts nothing. */
const ZERO_MATRIX = new Float32Array(16);

/**
 * Babylon creates its main depth buffer as a render attachment only. Page
 * marking reads it from compute, so add TEXTURE_BINDING when Babylon creates
 * it, then have Babylon recreate its attachments. This is the one Babylon
 * internal the adapter patches; an upstream option would retire it.
 */
function makeMainDepthReadable(engine: WebGPUEngine): void {
  const device = engine._device as GPUDevice & { __psPatched?: boolean };
  if (device.__psPatched) return;
  device.__psPatched = true;
  const create = device.createTexture.bind(device);
  device.createTexture = (desc: GPUTextureDescriptor) =>
    create(
      desc.label?.startsWith("Texture_MainDepthStencil")
        ? { ...desc, usage: desc.usage | GPUTextureUsage.TEXTURE_BINDING }
        : desc,
    );
  engine.resize(true);
}

interface StorageLike {
  getBuffer(): WebGPUDataBuffer;
}

function storage(buffer: GPUBuffer): StorageLike {
  const data = new WebGPUDataBuffer(buffer, buffer.size);
  return { getBuffer: () => data };
}

export interface CasterOptions {
  /** Re-read the world matrix every frame and invalidate what it moved over. */
  dynamic?: boolean;
  /** Alpha-tested caster: layer registered with `setAlphaMask`. */
  alphaLayer?: number;
  alphaCutoff?: number;
  /**
   * Dynamic thin-instanced casters: instance slots to reserve, so the
   * thin-instance count can grow up to this at runtime. Defaults to the count
   * at registration. Instances beyond it do not cast (warned once).
   */
  capacity?: number;
}

/** A caster for setCasters(): a mesh, or a mesh with its options. */
export type CasterEntry = Mesh | { mesh: Mesh; options?: CasterOptions };

interface DynamicCaster {
  mesh: Mesh;
  /** One group per material the mesh casts with; all share the mesh's instances. */
  groups: InstanceGroup[];
  /** 16 floats per instance: the final world matrices last uploaded. */
  last: Float32Array;
  warnedCount?: boolean;
}

/**
 * The triangles of a mesh that cast, one run per material, following the
 * SubMesh contract in the World wiki (Prim-Draw-Call-Reduction §10b):
 * iterate SubMeshes, never subMaterials; a null MultiMaterial slot is a
 * hidden face's pick slot and is skipped; slice by indexStart/indexCount,
 * never by the (conservative) vertex range. The material is resolved the way
 * the renderer resolves it, so a mesh with no material still casts (it draws
 * with the scene's default material).
 */
function castingRuns(mesh: Mesh, indices: ArrayLike<number>): Map<Material | null, number[]> {
  const runs = new Map<Material | null, number[]>();
  const root = mesh.material;
  const multi = root && (root as unknown as MultiMaterial).getSubMaterial ? (root as unknown as MultiMaterial) : null;
  for (const sm of mesh.subMeshes ?? []) {
    const material = multi ? multi.getSubMaterial(sm.materialIndex) : root;
    if (multi && !material) continue;
    let run = runs.get(material);
    if (!run) runs.set(material, (run = []));
    for (let i = sm.indexStart, end = sm.indexStart + sm.indexCount; i < end; i++) run.push(indices[i]);
  }
  return runs;
}

/** Two 32-bit hashes (FNV-1a and a murmur-style mix) of the arrays' raw bits, as 16 hex digits. */
function contentHash(...parts: ArrayLike<number>[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (const part of parts) {
    const words =
      part instanceof Float32Array || part instanceof Uint32Array || part instanceof Int32Array
        ? new Uint32Array(part.buffer, part.byteOffset, part.length)
        : Uint32Array.from(part as ArrayLike<number>);
    for (let i = 0; i < words.length; i++) {
      h1 = Math.imul(h1 ^ words[i], 0x01000193);
      h2 = Math.imul(h2 ^ words[i], 0x5bd1e995) ^ (h2 >>> 15);
    }
    h1 = Math.imul(h1 ^ words.length, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Keep only the vertices a run uses, so a mesh split by material does not upload its vertices once per material. */
function compact(run: number[], positions: ArrayLike<number>, uvs?: ArrayLike<number> | null) {
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

/**
 * What produced the depth buffer: captured right after the main camera
 * renders, used by the next frame's page marking. The scene's transform
 * matrix cannot stand in for it, because Babylon rewrites that matrix for
 * every camera and render target it renders (review F1).
 */
interface DepthSnapshot {
  texture: GPUTexture;
  invViewProj: Float32Array;
}

/**
 * Final world matrices of a mesh's instances: thin-instance × mesh world, or
 * the mesh world alone. Reads the thin-instance buffer Babylon renders from.
 * `thinInstanceGetWorldMatrices()` cannot be used: it builds its Matrix
 * objects once and caches them, so edits made through the buffer plus
 * `thinInstanceBufferUpdated()` never show up there.
 */
function casterMatrices(mesh: Mesh, out?: Float32Array): Float32Array {
  const world = mesh.computeWorldMatrix(true);
  const count = mesh.thinInstanceCount;
  const data = (mesh as unknown as { _thinInstanceDataStorage?: { matrixData?: Float32Array | null } })
    ._thinInstanceDataStorage?.matrixData;
  if (count > 0 && data) {
    const result = out && out.length === count * 16 ? out : new Float32Array(count * 16);
    const local = new Matrix();
    const tmp = new Matrix();
    for (let i = 0; i < count; i++) {
      Matrix.FromArrayToRef(data, i * 16, local);
      local.multiplyToRef(world, tmp);
      result.set(tmp.m, i * 16);
    }
    return result;
  }
  const result = out && out.length === 16 ? out : new Float32Array(16);
  result.set(world.m);
  return result;
}

export class SundialBabylon {
  readonly core: PagedShadowCore;
  readonly scene: Scene;
  readonly light: DirectionalLight;
  /** When false, materials fall back to plain unshadowed sun light (for A/B). */
  enabled = true;

  /** @internal */ readonly poolTexture: BaseTexture;
  /** @internal */ readonly params: StorageLike;
  /** @internal */ readonly pageTable: StorageLike;

  private readonly dynamics: DynamicCaster[] = [];
  private readonly plugins: SundialPlugin[] = [];
  private observer: Observer<Scene> | null = null;
  private running = false;
  private afterCameraObserver: Observer<Camera> | null = null;
  private depthSnapshot: DepthSnapshot | null = null;
  private readonly scratch = new Matrix();
  private scratchMatrices: Float32Array = new Float32Array(0);

  /**
   * True when Sundial can run on this engine: a WebGPU engine whose device is
   * ready. Call this before constructing; on WebGL2 keep the existing CSM.
   * Importing this module is always safe, on any backend.
   */
  static isSupported(engine: AbstractEngine): boolean {
    return !!engine.isWebGPU && !!(engine as unknown as { _device?: GPUDevice })._device;
  }

  /**
   * The camera whose depth buffer drives page marking, and whose position
   * picks the clipmap level. Defaults to the first active camera, then the
   * scene's active camera. World renders a HUD camera after the world camera,
   * so it must name the world camera explicitly.
   */
  getCamera: () => Camera | null;

  constructor(scene: Scene, light: DirectionalLight, options: PagedShadowOptions & { getCamera?: () => Camera | null }) {
    this.scene = scene;
    this.light = light;
    this.getCamera = options.getCamera ?? (() => scene.activeCameras?.[0] ?? scene.activeCamera);
    const engine = scene.getEngine() as WebGPUEngine;
    if (!engine.isWebGPU) throw new Error("Sundial needs the WebGPU engine");
    makeMainDepthReadable(engine);
    this.core = new PagedShadowCore(engine._device, options);

    const internal = engine.wrapWebGPUTexture(this.core.poolTexture);
    (internal._hardwareTexture as unknown as { createView(d: GPUTextureViewDescriptor): void }).createView({
      dimension: "2d",
      aspect: "depth-only",
    });
    this.poolTexture = new BaseTexture(scene, internal);
    this.params = storage(this.core.paramsBuffer);
    this.pageTable = storage(this.core.pageTableBuffer);
  }

  /**
   * Register a mesh (and all of its thin instances) as a shadow caster, one
   * group per material it draws with. SubMeshes whose MultiMaterial slot is
   * null (hidden faces) do not cast. Clustering is cached by geometry and
   * content, so registering the same content again is cheap.
   */
  addCaster(mesh: Mesh, opts: CasterOptions = {}): InstanceGroup[] {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices) throw new Error(`Sundial: ${mesh.name} has no geometry`);
    const alpha = opts.alphaLayer !== undefined ? { layer: opts.alphaLayer, cutoff: opts.alphaCutoff ?? 0.5 } : undefined;
    const uvs = alpha ? mesh.getVerticesData(VertexBuffer.UVKind) : null;
    const scope = `${mesh.geometry?.uniqueId ?? `mesh${mesh.uniqueId}`}:${contentHash(positions, uvs ?? [])}`;
    let matrices = casterMatrices(mesh);
    if (opts.dynamic && opts.capacity && opts.capacity * 16 > matrices.length) {
      // Reserved slots start as zero matrices, which cast nothing.
      const padded = new Float32Array(opts.capacity * 16);
      padded.set(matrices);
      matrices = padded;
    }
    const groups: InstanceGroup[] = [];
    for (const run of castingRuns(mesh, indices).values()) {
      if (run.length < 3) continue;
      const key = `${scope}:${contentHash(run)}:${alpha ? `${alpha.layer}/${alpha.cutoff}` : "opaque"}`;
      const geometry = this.core.addGeometry({ ...compact(run, positions, uvs), alpha }, key);
      groups.push(this.core.addInstances(geometry, matrices, !!opts.dynamic));
    }
    if (opts.dynamic && groups.length) this.dynamics.push({ mesh, groups, last: matrices.slice() });
    return groups;
  }

  /**
   * Replace every registered caster and rebuild. Before start() this only
   * registers; start() builds. Cached clusters make re-registering unchanged
   * content cheap, so call this as content streams in (debounced: a rebuild
   * re-renders every cached page). Returns each entry's groups, in order.
   */
  setCasters(entries: CasterEntry[]): InstanceGroup[][] {
    this.dynamics.length = 0;
    this.core.clearContent();
    const groups = entries.map((e) => ("getClassName" in e ? this.addCaster(e) : this.addCaster(e.mesh, e.options)));
    if (this.running) this.core.build();
    return groups;
  }

  setAlphaMask(layer: number, source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap, cutoff = 0.5): void {
    this.core.setAlphaLayer(layer, source, cutoff);
  }

  /** Attach the receiver to materials. Meshes must also have `receiveShadows`. */
  addReceivers(materials: Material[]): void {
    for (const m of materials) {
      if (!this.plugins.some((p) => p.target === m)) this.plugins.push(new SundialPlugin(m, this));
    }
  }

  /** Upload content and start running every frame. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.core.build();
    this.observer = this.scene.onBeforeRenderObservable.add(() => this.update());
    this.afterCameraObserver = this.scene.onAfterCameraRenderObservable.add((camera) => this.captureDepth(camera));
  }

  setEnabled(on: boolean): void {
    // Things may have moved while nothing was tracking them.
    if (on && !this.enabled) this.core.invalidateAll();
    this.enabled = on;
    for (const p of this.plugins) p.markAllDefinesAsDirty();
  }

  /**
   * Stop, free every GPU resource and turn the receivers off (materials fall
   * back to unshadowed sun light). The instance cannot be restarted.
   */
  dispose(): void {
    this.observer?.remove();
    this.afterCameraObserver?.remove();
    this.observer = this.afterCameraObserver = null;
    this.setEnabled(false);
    this.running = false;
    this.dynamics.length = 0;
    this.poolTexture.dispose();
    this.core.dispose();
  }

  /**
   * Mark pages right after the world camera renders, inside Babylon's own
   * frame encoder, while its depth is intact and exactly matches this
   * camera's matrix. A later camera (World's HUD) clears depth, so reading it
   * at the next frame's start would see an almost empty buffer (measured:
   * 153 → 32 pages requested, a blurry fallback everywhere). Ends Babylon's
   * current render pass; Babylon restarts it lazily with load ops.
   */
  private captureDepth(camera: Camera): void {
    if (!this.enabled || camera !== this.getCamera()) return;
    const engine = this.scene.getEngine() as unknown as {
      _depthTexture?: GPUTexture;
      _renderEncoder?: GPUCommandEncoder;
      _endCurrentRenderPass?: () => void;
    };
    const depth = engine._depthTexture;
    if (!depth) return;
    camera.getTransformationMatrix().invertToRef(this.scratch);
    if (engine._renderEncoder && engine._endCurrentRenderPass) {
      engine._endCurrentRenderPass();
      this.core.markInto(engine._renderEncoder, { texture: depth, invViewProj: this.scratch.m });
      this.depthSnapshot = null;
    } else {
      // No mid-frame access: fall back to marking at the next frame's start.
      this.depthSnapshot = { texture: depth, invViewProj: new Float32Array(this.scratch.m) };
    }
  }

  private update(): void {
    if (!this.enabled) return;
    this.updateDynamics();
    const camera = this.getCamera();
    if (!camera) return;
    const eye = camera.globalPosition;
    const dir = this.light.direction;
    const engine = this.scene.getEngine() as WebGPUEngine;
    const current = (engine as unknown as { _depthTexture?: GPUTexture })._depthTexture;
    // Mark only from a depth buffer we saw rendered, with the matrix it was
    // rendered with. After a resize Babylon has a fresh, empty depth texture:
    // skip marking for that one frame rather than mark garbage.
    const snap = this.depthSnapshot;
    const depth = snap && snap.texture === current ? { texture: snap.texture, invViewProj: snap.invViewProj } : undefined;
    this.core.update({
      eye: [eye.x, eye.y, eye.z],
      lightDir: [dir.x, dir.y, dir.z],
      pixelWorldSizeAt1m: (2 * Math.tan(camera.fov / 2)) / engine.getRenderHeight(),
      depth,
    });
  }

  /**
   * Re-read every dynamic caster's instance matrices and upload the ones that
   * moved. Thin-instanced casters are tracked per instance (review F2). The
   * thin-instance count may change at runtime within the registered capacity:
   * instances that disappear are collapsed to a zero matrix, which casts
   * nothing and invalidates their old footprint, and they reappear
   * automatically if the count grows back (PR #3 review F1). Growth beyond
   * the capacity is reported once; those instances do not cast.
   */
  private updateDynamics(): void {
    for (const d of this.dynamics) {
      const now = casterMatrices(d.mesh, this.scratchMatrices);
      this.scratchMatrices = now;
      const live = now.length / 16;
      const slots = d.groups[0].count;
      if (live > slots && !d.warnedCount) {
        d.warnedCount = true;
        console.warn(`Sundial: ${d.mesh.name} has ${live} thin instances but ${slots} registered slots; the extra instances do not cast. Pass { capacity } to addCaster.`);
      }
      for (let i = 0; i < slots; i++) {
        const o = i * 16;
        const next = i < live ? now.subarray(o, o + 16) : ZERO_MATRIX;
        let moved = false;
        for (let k = 0; k < 16; k++) {
          if (next[k] !== d.last[o + k]) {
            moved = true;
            break;
          }
        }
        if (moved) {
          d.last.set(next, o);
          for (const g of d.groups) this.core.setInstanceMatrix(g, i, next);
        }
      }
    }
  }
}

const DEFINES: Record<string, boolean> = { PSENABLED: false };
for (let k = 0; k < MAX_LIGHTS; k++) DEFINES[`PSLIGHT${k}`] = false;

/**
 * Receiver injection. The shadow scales the sun's light colour at
 * CUSTOM_LIGHT{k}_COLOR, which covers diffuse plus PBR specular, sheen and
 * clear coat; StandardMaterial's separate specular colour is scaled by a
 * per-light regex. No samplers are added, so terrain's 16-sampler budget is
 * untouched.
 */
class SundialPlugin extends MaterialPluginBase {
  private readonly host: SundialBabylon;
  readonly target: Material;

  constructor(material: Material, host: SundialBabylon) {
    super(material, "Sundial", 300, { ...DEFINES });
    this.host = host;
    this.target = material;
    this._enable(true);
  }

  override getClassName(): string {
    return "SundialPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const on = this.host.enabled && mesh.receiveShadows;
    let any = false;
    for (let k = 0; k < MAX_LIGHTS; k++) {
      const hit = on && mesh.lightSources[k] === this.host.light;
      defines[`PSLIGHT${k}`] = hit;
      any ||= hit;
    }
    defines.PSENABLED = any;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("psPool");
  }

  override bindForSubMesh(_ubo: UniformBuffer, _scene: Scene, engine: AbstractEngine, subMesh: SubMesh): void {
    if (!subMesh.materialDefines || !(subMesh.materialDefines as MaterialDefines).PSENABLED) return;
    const effect = subMesh.effect;
    if (!effect) return;
    effect.setTexture("psPool", this.host.poolTexture);
    const gpu = engine as WebGPUEngine;
    gpu.setStorageBuffer("psParams", this.host.params as never);
    gpu.setStorageBuffer("psPageTable", this.host.pageTable as never);
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== "fragment") return null;
    const code: Record<string, string> = {
      CUSTOM_FRAGMENT_DEFINITIONS: `
var<private> psLightShadow: array<f32, ${MAX_LIGHTS}> = array<f32, ${MAX_LIGHTS}>(${Array(MAX_LIGHTS).fill("1.0").join(", ")});
#ifdef PSENABLED
${COMMON_WGSL}
var<storage, read> psParams: PsParams;
var<storage, read> psPageTable: array<vec2u>;
var psPool: texture_depth_2d;
${(globalThis as { __psReceiver?: (s: string) => string }).__psReceiver?.(RECEIVER_WGSL) ?? RECEIVER_WGSL}
#endif
`,
    };
    for (let k = 0; k < MAX_LIGHTS; k++) {
      code[`CUSTOM_LIGHT${k}_COLOR`] = `
#ifdef PSLIGHT${k}
#ifdef ALPHATEST
// Tint lowers discard to demote-to-helper: discarded texels run to the end of
// the shader. Skip the receiver for them rather than pay for invisible pixels.
// Each material family spells its alpha test differently.
#ifdef ALPHATESTVALUE
let psLive${k} = alpha >= ALPHATESTVALUE;
#else
#ifdef ALPHATEST_AFTERALLALPHACOMPUTATIONS
let psLive${k} = alpha >= uniforms.alphaCutOff;
#else
let psLive${k} = baseColor.a >= uniforms.alphaCutOff;
#endif
#endif
if (psLive${k}) { psLightShadow[${k}] = psShadow(fragmentInputs.vPositionW, normalW); }
#else
psLightShadow[${k}] = psShadow(fragmentInputs.vPositionW, normalW);
#endif
diffuse${k} = vec4f(psApply(diffuse${k}.rgb, psLightShadow[${k}]), diffuse${k}.a);
#endif
`;
      code[`!light${k}\\.vLightSpecular\\.rgb`] = `(light${k}.vLightSpecular.rgb*psLightShadow[${k}])`;
    }
    return code;
  }
}
