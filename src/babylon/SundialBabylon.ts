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
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { WebGPUDataBuffer } from "@babylonjs/core/Meshes/WebGPU/webgpuDataBuffer";
import { GetTextureDataAsync } from "@babylonjs/core/Misc/textureTools";
import { PagedShadowCore, type InstanceGroup, type PagedShadowOptions, type Vec3 } from "../core/PagedShadowCore";
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
  /**
   * Alpha-tested caster with a mask you supply: the layer registered with
   * `setAlphaMask`. Overrides the automatic mask. Use low layer numbers;
   * automatic masks are allocated from the top layer down.
   */
  alphaLayer?: number;
  alphaCutoff?: number;
  /**
   * Read alpha masks from the materials' own textures (default true), with
   * the same rule as Babylon's ShadowGenerator: an alpha-tested material casts
   * through its alpha-test texture's alpha at its alphaCutOff. Until the mask
   * has been read the caster casts opaque; then it rebuilds.
   */
  autoAlpha?: boolean;
  /**
   * Dynamic thin-instanced casters: instance slots to reserve, so the
   * thin-instance count can grow up to this at runtime. Defaults to the count
   * at registration. Instances beyond it do not cast (warned once).
   */
  capacity?: number;
  /**
   * Static thin-instanced casters: the instances' own transforms (16 floats
   * each, instance-local, the thin-instance buffer's layout), used instead of
   * the buffer Babylon renders from. For hosts whose buffer is a VIEW of the
   * content rather than the content itself: World's distance culling hides a
   * far member by writing a zero-scale matrix into its slot, and a caster read
   * from that buffer would never cast once registered, however close the
   * camera came. Ignored for dynamic casters, which follow the live buffer.
   */
  instanceMatrices?: Float32Array;
}

/** Where an alpha-tested material's coverage comes from. */
interface AlphaSource {
  texture: BaseTexture;
  cutoff: number;
}

interface AlphaLayer {
  layer: number;
  cutoff: number;
  state: "loading" | "ready" | "failed";
}

type TextureLike = BaseTexture & { getTextureMatrix?: () => Matrix };

/**
 * The texture an alpha-tested caster discards against, chosen exactly as
 * Babylon's ShadowGenerator chooses it, so Sundial's shadows cut out wherever
 * CSM's do: when the material alpha-tests for this mesh, its alpha-test
 * texture (diffuse for Standard, albedo for PBR), its alpha channel, at
 * alphaCutOff (default 0.5). Null when there is no such texture: the caster
 * casts opaque, as it does under CSM.
 */
function alphaSource(material: Material | null, mesh: Mesh): AlphaSource | null {
  if (!material) return null;
  const m = material as Material & { alphaCutOff?: number };
  if (!(m.needAlphaTestingForMesh?.(mesh) ?? m.needAlphaTesting())) return null;
  const texture = m.getAlphaTestTexture?.() as BaseTexture | null;
  if (!texture) return null;
  return { texture, cutoff: m.alphaCutOff ?? 0.5 };
}

/**
 * The UVs a caster's alpha texture is sampled with, with its texture matrix
 * (scale, offset, rotation) applied the way Babylon's vertex shaders apply it:
 * uv' = (M * vec4(uv, 1, 0)).xy.
 */
function textureUVs(mesh: Mesh, texture: TextureLike): Float32Array | null {
  // As ShadowGenerator: the second UV set when the texture asks for it, else the first.
  const second = texture.coordinatesIndex === 1 && mesh.isVerticesDataPresent(VertexBuffer.UV2Kind);
  const data = mesh.getVerticesData(second ? VertexBuffer.UV2Kind : VertexBuffer.UVKind);
  if (!data) return null;
  const uvs = new Float32Array(data);
  const matrix = texture.getTextureMatrix?.();
  if (matrix && !matrix.isIdentity()) {
    const m = matrix.m;
    for (let i = 0; i < uvs.length; i += 2) {
      const u = uvs[i];
      const v = uvs[i + 1];
      uvs[i] = m[0] * u + m[4] * v + m[8];
      uvs[i + 1] = m[1] * u + m[5] * v + m[9];
    }
  }
  return uvs;
}

/**
 * A texture as RGBA8 at `size`², rows in texture-memory order (the order the
 * shader samples in). Goes through a render target, which also decodes
 * compressed (KTX2) textures and resizes.
 * @internal exported for the consumer test
 */
export async function readCoverage(texture: BaseTexture, size: number): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const data = await GetTextureDataAsync(texture, size, size, 0, 0, true);
  const px = new Uint8ClampedArray(size * size * 4);
  px.set(new Uint8Array(data.buffer, data.byteOffset, px.length));
  return px;
}

/** Options for SundialBabylon: the core's, plus the adapter's own. */
export interface SundialBabylonOptions extends PagedShadowOptions {
  /** See SundialBabylon.getCamera. */
  getCamera?: () => Camera | null;
  /**
   * Which materials created after start() become receivers automatically.
   * Default: StandardMaterial and PBRMaterial. Return false to leave one
   * alone; pass () => false to turn it off. Only WGSL materials of the
   * classes that support plugins can receive.
   */
  receiveNewMaterials?: (material: Material) => boolean;
}

const RECEIVER_CLASSES = new Set(["StandardMaterial", "PBRMaterial"]);

/** Whether the receiver plugin can attach: a plugin-capable class, and WGSL (the receiver is WGSL only). */
function canReceive(material: Material): boolean {
  return RECEIVER_CLASSES.has(material.getClassName()) && material.shaderLanguage === ShaderLanguage.WGSL;
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
/**
 * The depth buffer a camera's geometry actually lands in. A camera with an
 * output render target, or with post-processes (World's world camera renders
 * through image processing into an HDR target), never writes Babylon's main
 * depth buffer: marking from that would see an empty buffer and request pages
 * for the far plane only. Null when that depth cannot be sampled, so the caller
 * can fall back to the main buffer.
 */
function cameraDepth(camera: Camera, scene: Scene): GPUTexture | null {
  const cam = camera as Camera & { _getFirstPostProcess?: () => { inputTexture?: RenderTargetWrapper } | null };
  const target =
    camera.outputRenderTarget?.renderTarget ??
    (scene.postProcessesEnabled ? cam._getFirstPostProcess?.()?.inputTexture : undefined) ??
    null;
  if (!target) return null;
  const texture = (target._depthStencilTexture?._hardwareTexture as { underlyingResource?: GPUTexture } | null | undefined)
    ?.underlyingResource;
  return texture && texture.usage & GPUTextureUsage.TEXTURE_BINDING ? texture : null;
}

function casterMatrices(mesh: Mesh, out?: Float32Array, instances?: Float32Array): Float32Array {
  const world = mesh.computeWorldMatrix(true);
  const count = instances ? instances.length / 16 : mesh.thinInstanceCount;
  const data =
    instances ??
    (mesh as unknown as { _thinInstanceDataStorage?: { matrixData?: Float32Array | null } })._thinInstanceDataStorage
      ?.matrixData;
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
  private entries: { mesh: Mesh; options?: CasterOptions }[] = [];
  private rebuildPending = false;
  private readonly alphaLayers = new Map<string, AlphaLayer>();
  private warnedAlphaLayers = false;
  private disposed = false;
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

  private readonly receiveNewMaterials: (material: Material) => boolean;
  private newMaterialObserver: Observer<Material> | null = null;

  constructor(scene: Scene, light: DirectionalLight, options: SundialBabylonOptions) {
    this.scene = scene;
    this.light = light;
    this.getCamera = options.getCamera ?? (() => scene.activeCameras?.[0] ?? scene.activeCamera);
    this.receiveNewMaterials = options.receiveNewMaterials ?? (() => true);
    const engine = scene.getEngine() as WebGPUEngine;
    if (!engine.isWebGPU) throw new Error("Sundial needs the WebGPU engine");
    makeMainDepthReadable(engine);
    this.core = new PagedShadowCore(engine._device, { maxAlphaLayers: 16, ...options });

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
   * content, so registering the same content again is cheap. After start()
   * the caster is built in at the next frame.
   */
  addCaster(mesh: Mesh, opts: CasterOptions = {}): InstanceGroup[] {
    this.entries.push({ mesh, options: opts });
    if (this.running) this.rebuildPending = true;
    return this.register(mesh, opts);
  }

  /**
   * Replace every registered caster and rebuild. Before start() this only
   * registers; start() builds. Cached clusters make re-registering unchanged
   * content cheap, so call this as content streams in (debounced: a rebuild
   * re-renders every cached page). Returns each entry's groups, in order.
   */
  setCasters(entries: CasterEntry[]): InstanceGroup[][] {
    this.entries = entries.map((e) => ("getClassName" in e ? { mesh: e } : e));
    return this.rebuild();
  }

  private rebuild(): InstanceGroup[][] {
    this.rebuildPending = false;
    this.dynamics.length = 0;
    this.core.clearContent();
    const groups = this.entries.map((e) => this.register(e.mesh, e.options ?? {}));
    if (this.running) this.core.build();
    return groups;
  }

  private register(mesh: Mesh, opts: CasterOptions): InstanceGroup[] {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices) throw new Error(`Sundial: ${mesh.name} has no geometry`);
    const explicit = opts.alphaLayer !== undefined ? { layer: opts.alphaLayer, cutoff: opts.alphaCutoff ?? 0.5 } : undefined;
    const scope = `${mesh.geometry?.uniqueId ?? `mesh${mesh.uniqueId}`}:${contentHash(positions)}`;
    let matrices = casterMatrices(mesh, undefined, opts.dynamic ? undefined : opts.instanceMatrices);
    if (opts.dynamic && opts.capacity && opts.capacity * 16 > matrices.length) {
      // Reserved slots start as zero matrices, which cast nothing.
      const padded = new Float32Array(opts.capacity * 16);
      padded.set(matrices);
      matrices = padded;
    }
    const groups: InstanceGroup[] = [];
    for (const [material, run] of castingRuns(mesh, indices)) {
      if (run.length < 3) continue;
      let alpha = explicit;
      let uvs: Float32Array | null = null;
      if (explicit) {
        const data = mesh.getVerticesData(VertexBuffer.UVKind);
        uvs = data ? new Float32Array(data) : null;
      } else if (opts.autoAlpha !== false) {
        const source = alphaSource(material, mesh);
        uvs = source ? textureUVs(mesh, source.texture) : null;
        alpha = source && uvs ? this.alphaLayerFor(source) : undefined;
      }
      if (!alpha) uvs = null;
      const key = `${scope}:${contentHash(run)}:${alpha ? `${alpha.layer}/${alpha.cutoff}:${contentHash(uvs!)}` : "opaque"}`;
      const geometry = this.core.addGeometry({ ...compact(run, positions, uvs), alpha }, key);
      groups.push(this.core.addInstances(geometry, matrices, !!opts.dynamic));
    }
    if (opts.dynamic && groups.length) this.dynamics.push({ mesh, groups, last: matrices.slice() });
    return groups;
  }

  /**
   * The alpha layer holding this source's coverage, or undefined while it is
   * still being read (or could not be): the caster casts opaque meanwhile,
   * and a rebuild follows once the mask is in. Layers are shared by texture,
   * and cutoff, and allocated from the top layer down.
   */
  private alphaLayerFor(source: AlphaSource): { layer: number; cutoff: number } | undefined {
    const key = `${source.texture.uniqueId}:${source.cutoff}`;
    let entry = this.alphaLayers.get(key);
    if (!entry) {
      const layer = this.core.alphaLayerCount - 1 - this.alphaLayers.size;
      if (layer < 0) {
        if (!this.warnedAlphaLayers) console.warn(`Sundial: out of alpha layers (${this.core.alphaLayerCount}); further alpha-tested casters cast opaque. Raise maxAlphaLayers.`);
        this.warnedAlphaLayers = true;
        return undefined;
      }
      entry = { layer, cutoff: source.cutoff, state: "loading" };
      this.alphaLayers.set(key, entry);
      const loaded = entry;
      readCoverage(source.texture, this.core.alphaSize)
        .then((px) => {
          if (this.disposed) return;
          const size = this.core.alphaSize;
          const canvas = new OffscreenCanvas(size, size);
          canvas.getContext("2d")!.putImageData(new ImageData(px, size, size), 0, 0);
          this.core.setAlphaLayer(loaded.layer, canvas, loaded.cutoff);
          loaded.state = "ready";
          this.rebuildPending = true;
        })
        .catch((e) => {
          loaded.state = "failed";
          console.warn(`Sundial: could not read alpha mask from ${source.texture.name}; its casters cast opaque.`, e);
        });
    }
    return entry.state === "ready" ? { layer: entry.layer, cutoff: entry.cutoff } : undefined;
  }

  setAlphaMask(layer: number, source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap, cutoff = 0.5): void {
    this.core.setAlphaLayer(layer, source, cutoff);
  }

  /**
   * Attach the receiver to materials. Meshes must also have `receiveShadows`.
   * Materials that cannot take the plugin (other classes, GLSL) are skipped.
   */
  addReceivers(materials: Material[]): void {
    for (const m of materials) {
      if (!canReceive(m) || this.plugins.some((p) => p.target === m)) continue;
      // A material keeps its plugin for life, and Babylon rejects a second one
      // of the same name. A material that an earlier (possibly disposed)
      // instance reached is rebound to this one instead.
      const existing = m.pluginManager?.getPlugin<SundialPlugin>("Sundial");
      if (existing) {
        existing.host = this;
        existing.markAllDefinesAsDirty();
        this.plugins.push(existing);
      } else this.plugins.push(new SundialPlugin(m, this));
    }
  }

  /** Shadow darkness, as Babylon's ShadowGenerator.setDarkness: 0 = black, 1 = invisible. */
  setDarkness(darkness: number): void {
    this.core.tuning.darkness = darkness;
  }

  /** Change the world bounds of everything that casts or receives, and re-render. */
  setSceneBounds(min: Vec3, max: Vec3): void {
    this.core.setSceneBounds(min, max);
  }

  /** Upload content and start running every frame. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.core.build();
    this.observer = this.scene.onBeforeRenderObservable.add(() => this.update());
    this.afterCameraObserver = this.scene.onAfterCameraRenderObservable.add((camera) => this.captureDepth(camera));
    // A plugin must attach when its material is constructed, as Babylon's own
    // RegisterMaterialPlugin does, so content streamed in later receives too.
    this.newMaterialObserver = this.scene.onNewMaterialAddedObservable.add((m) => {
      if (this.receiveNewMaterials(m)) this.addReceivers([m]);
    });
  }

  setEnabled(on: boolean): void {
    // Things may have moved while nothing was tracking them.
    if (on && !this.enabled) this.core.invalidateAll();
    this.enabled = on;
    // Only the plugins still bound here: a newer instance may have taken some over.
    for (const p of this.plugins) if (p.host === this) p.markAllDefinesAsDirty();
  }

  /**
   * Stop, free every GPU resource and turn the receivers off (materials fall
   * back to unshadowed sun light). The instance cannot be restarted.
   */
  dispose(): void {
    this.observer?.remove();
    this.afterCameraObserver?.remove();
    this.newMaterialObserver?.remove();
    this.observer = this.afterCameraObserver = this.newMaterialObserver = null;
    this.disposed = true;
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
    const depth = this.depthOf(camera);
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

  /** The depth this camera rendered into: its own target's, else Babylon's main one. */
  private depthOf(camera: Camera): GPUTexture | undefined {
    return cameraDepth(camera, this.scene) ?? (this.scene.getEngine() as unknown as { _depthTexture?: GPUTexture })._depthTexture;
  }

  private update(): void {
    if (!this.enabled) return;
    if (this.rebuildPending) this.rebuild();
    this.updateDynamics();
    const camera = this.getCamera();
    if (!camera) return;
    const eye = camera.globalPosition;
    const dir = this.light.direction;
    const engine = this.scene.getEngine() as WebGPUEngine;
    const current = this.depthOf(camera);
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

/**
 * Plugins inject at the same point in priority order, so the shadow must come
 * after anything that REPLACES the sun's colour there. Babylon's atmosphere
 * plugin (600) assigns diffuse{k} from its transmittance LUT at
 * CUSTOM_LIGHT{k}_COLOR; at 300 the shadow was applied first and overwritten,
 * and a PBR receiver under a physical sky showed no shadow at all.
 */
const PLUGIN_PRIORITY = 700;

const DEFINES: Record<string, boolean> = { PSENABLED: false };
for (let k = 0; k < MAX_LIGHTS; k++) DEFINES[`PSLIGHT${k}`] = false;

/**
 * Receiver injection. Each light's Sundial factor is computed at
 * CUSTOM_LIGHT{k}_COLOR and folded into Babylon's per-light shadow term with
 * min(), which Babylon applies to diffuse plus specular, sheen and clear coat.
 * No samplers are added, so terrain's 16-sampler budget is untouched.
 */
class SundialPlugin extends MaterialPluginBase {
  /** The instance whose shadows this material samples; rebound when a new instance adds it. */
  host: SundialBabylon;
  readonly target: Material;

  constructor(material: Material, host: SundialBabylon) {
    super(material, "Sundial", PLUGIN_PRIORITY, { ...DEFINES });
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
// The current light's Sundial factor, folded into Babylon's own shadow term below.
var<private> psCur: f32 = 1.0;
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
psCur = psLightShadow[${k}];
// Debug mode only: tint the light by the sampled level (a no-op otherwise).
diffuse${k} = vec4f(psApply(diffuse${k}.rgb, 1.0), diffuse${k}.a);
#else
psCur = 1.0;
#endif
`;
    }
    // Every light ends its shadow step with this line, and Babylon then scales
    // diffuse, specular, sheen and clear coat by `shadow`. Folding Sundial in
    // here with min() means: with no Babylon shadow on the light (shadow = 1)
    // Sundial alone decides; with one (World keeps a small CSM for skinned
    // avatars) the darker of the two wins, so overlapping shadows never
    // darken twice; and no plugin that replaces the light colour can undo it.
    code["!aggShadow\\+=shadow;"] = "shadow=min(shadow,psCur);aggShadow+=shadow;";
    return code;
  }
}
