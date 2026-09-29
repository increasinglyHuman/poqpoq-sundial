import {
  BackSide,
  DepthTexture,
  DoubleSide,
  ExternalTexture,
  FloatType,
  FrontSide,
  InstancedMesh,
  Matrix4,
  NearestFilter,
  Node,
  RGIntegerFormat,
  StorageBufferAttribute,
  UnsignedIntType,
  Vector2,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type Camera,
  type DirectionalLight,
  type InterleavedBufferAttribute,
  type Material,
  type Mesh,
  type NodeBuilder,
  type Object3D,
  type PerspectiveCamera,
  type RenderTarget,
  type Scene,
  type SkinnedMesh,
  type Texture,
  type WebGPURenderer,
} from "three/webgpu";
import { code, vec3, faceDirection, normalWorldGeometry, positionWorld, storage, texture, uniform, wgslFn } from "three/tsl";
import { PagedShadowCore, type InstanceGroup, type PagedShadowOptions, type Vec3 } from "../core/PagedShadowCore";
import type { GeometryInput } from "../core/geometry";
import type { SkinInput } from "../core/skin";
import { COMMON_WGSL, RECEIVER_WGSL } from "../core/wgsl";
import { compact, compactSkin, contentHash } from "../core/host";

// three.js adapter (WebGPURenderer only). As with Babylon, the core owns every
// GPU resource and runs on the renderer's own GPUDevice from its own command
// encoders; three only ever samples the result. The receiver is the sun's
// `light.shadow.shadowNode`, the hook three's own CSMShadowNode uses, so every
// node material that receives shadows from that light picks it up, and three
// renders no shadow map of its own for it. Other lights keep theirs.

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

/** How three's Renderer calls a Scene's hooks (the typings give them Object3D's per-draw signature). */
type SceneHook = (renderer: WebGPURenderer, scene: Scene, camera: Camera, target: RenderTarget | null) => void;
interface SceneHooks {
  onBeforeRender: SceneHook;
  onAfterRender: SceneHook;
}

/** Collapses an instance to a point: it casts nothing. */
const ZERO_MATRIX = new Float32Array(16);

/** three's backend keeps each object's GPU resources in a side table; we fill some rows ourselves. */
interface Backend {
  isWebGPUBackend?: boolean;
  device?: GPUDevice;
  get(object: object): { buffer?: GPUBuffer; texture?: GPUTexture };
}

function backendOf(renderer: WebGPURenderer): Backend {
  return (renderer as unknown as { backend: Backend }).backend;
}

export interface CasterOptions {
  /**
   * Re-read the world matrix (and an InstancedMesh's instance matrices) every
   * frame and re-render what moved. A dynamic SkinnedMesh casts its skinned
   * pose, skinned on the GPU from its skeleton each frame. Morph targets are
   * not applied.
   */
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
   * three's rule: a material with `alphaTest > 0` cuts out through its
   * `alphaMap` (green channel) or else its `map` (alpha channel). Until the
   * mask has been read the caster casts opaque; then it rebuilds.
   */
  autoAlpha?: boolean;
  /**
   * Dynamic InstancedMesh casters: instance slots to reserve, so `count` can
   * grow up to this at runtime. Defaults to the instance buffer's capacity.
   */
  capacity?: number;
}

/** A caster for setCasters(): a mesh, or a mesh with its options. */
export type CasterEntry = Mesh | { mesh: Mesh; options?: CasterOptions };

export interface SundialThreeOptions extends PagedShadowOptions {
  /**
   * Which materials receive (default: all). Return false to leave one
   * unshadowed by this light, as `receiveShadow = false` does per mesh.
   */
  receiveMaterial?: (material: Material) => boolean;
}

interface AlphaLayer {
  layer: number;
  cutoff: number;
  state: "loading" | "ready" | "failed";
}

interface Tracked {
  mesh: Mesh;
  groups: InstanceGroup[];
  /** 16 floats per instance: the final world matrices last uploaded. */
  last: Float32Array;
  /** Scratch for the current matrices. */
  now: Float32Array;
  warnedCount?: boolean;
  /** Skinned casters: their bone matrices (posed mesh space) as last uploaded. */
  skin?: { bones: Float32Array };
}

const LOCAL = new Matrix4();
const PRODUCT = new Matrix4();
const BIND = new Matrix4();

/** Final world matrices of a mesh's instances: instance × world, or world alone. */
function casterMatrices(mesh: Mesh, out?: Float32Array, slots?: number): Float32Array {
  const world = mesh.matrixWorld;
  if ((mesh as InstancedMesh).isInstancedMesh) {
    const im = mesh as InstancedMesh;
    const n = slots ?? Math.max(im.count, 0);
    const result = out ?? new Float32Array(n * 16);
    const live = Math.min(im.count, n);
    const data = im.instanceMatrix.array as Float32Array;
    for (let i = 0; i < live; i++) {
      LOCAL.fromArray(data, i * 16);
      PRODUCT.multiplyMatrices(world, LOCAL);
      result.set(PRODUCT.elements, i * 16);
    }
    for (let i = live; i < n; i++) result.set(ZERO_MATRIX, i * 16);
    return result;
  }
  const result = out ?? new Float32Array(16);
  result.set(world.elements);
  return result;
}

/** An attribute's components as a plain array (interleaved attributes are de-interleaved). */
function readAttribute(attr: AnyAttribute): ArrayLike<number> {
  const a = attr as BufferAttribute;
  if (!(attr as InterleavedBufferAttribute).isInterleavedBufferAttribute && !a.normalized) return a.array as ArrayLike<number>;
  const n = attr.count;
  const size = attr.itemSize;
  const out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) out[i * size + k] = attr.getComponent(i, k);
  return out;
}

function isSkinned(mesh: Mesh, opts: CasterOptions): boolean {
  const s = mesh as SkinnedMesh;
  return !!opts.dynamic && !!s.isSkinnedMesh && !!s.skeleton && !!mesh.geometry.getAttribute("skinIndex") && !!mesh.geometry.getAttribute("skinWeight");
}

/** The triangles of a geometry that cast, one run per material. A missing or invisible material casts nothing. */
function castingRuns(mesh: Mesh): Map<Material, ArrayLike<number>> {
  const geometry = mesh.geometry;
  const index = geometry.index ? (geometry.index.array as ArrayLike<number>) : null;
  const count = index ? index.length : (geometry.getAttribute("position")?.count ?? 0);
  const at = (i: number) => (index ? index[i] : i);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = Array.isArray(mesh.material) && geometry.groups.length
    ? geometry.groups
    : [{ start: geometry.drawRange.start, count: Math.min(geometry.drawRange.count, count), materialIndex: 0 }];
  const ranges = new Map<Material, [number, number][]>();
  for (const g of groups) {
    const material = materials[g.materialIndex ?? 0];
    if (!material || !material.visible) continue;
    const start = Math.max(g.start, geometry.drawRange.start);
    const end = Math.min(g.start + g.count, geometry.drawRange.start + geometry.drawRange.count, count);
    if (end <= start) continue;
    let list = ranges.get(material);
    if (!list) ranges.set(material, (list = []));
    list.push([start, end - start]);
  }
  const typed = index instanceof Uint32Array || index instanceof Uint16Array ? index : null;
  const runs = new Map<Material, ArrayLike<number>>();
  for (const [material, list] of ranges) {
    let contiguous = true;
    for (let k = 1; k < list.length && contiguous; k++) contiguous = list[k][0] === list[k - 1][0] + list[k - 1][1];
    if (typed && contiguous) {
      const last = list[list.length - 1];
      runs.set(material, typed.subarray(list[0][0], last[0] + last[1]));
      continue;
    }
    let size = 0;
    for (const [, n] of list) size += n;
    const run = new Uint32Array(size);
    let w = 0;
    for (const [start, n] of list) for (let i = start; i < start + n; i++) run[w++] = at(i);
    runs.set(material, run);
  }
  return runs;
}

/** Where an alpha-tested material's coverage comes from, by three's rule. */
function alphaSource(material: Material): { texture: Texture; channel: "a" | "g"; cutoff: number } | null {
  const m = material as Material & { map?: Texture | null; alphaMap?: Texture | null };
  if (!(m.alphaTest > 0)) return null;
  if (m.alphaMap) return { texture: m.alphaMap, channel: "g", cutoff: m.alphaTest };
  if (m.map) return { texture: m.map, channel: "a", cutoff: m.alphaTest };
  return null;
}

/** UVs as the texture samples them: three's texture matrix (offset, repeat, rotation) applied. */
function textureUVs(geometry: BufferGeometry, tex: Texture): Float32Array | null {
  const attr = geometry.getAttribute(tex.channel ? `uv${tex.channel}` : "uv") ?? geometry.getAttribute("uv");
  if (!attr) return null;
  const uvs = new Float32Array(readAttribute(attr));
  if (tex.matrixAutoUpdate) tex.updateMatrix();
  const e = tex.matrix.elements;
  const identity = e[0] === 1 && e[1] === 0 && e[3] === 0 && e[4] === 1 && e[6] === 0 && e[7] === 0;
  if (!identity) {
    for (let i = 0; i < uvs.length; i += 2) {
      const u = uvs[i];
      const v = uvs[i + 1];
      uvs[i] = e[0] * u + e[3] * v + e[6];
      uvs[i + 1] = e[1] * u + e[4] * v + e[7];
    }
  }
  return uvs;
}

/**
 * A texture's coverage as an RGBA canvas at size², rows in the order the
 * shader samples them (v = 0 first), the chosen channel moved into alpha.
 * three uploads `flipY` textures bottom row first, so those are flipped here.
 */
async function coverageCanvas(tex: Texture, channel: "a" | "g", size: number): Promise<OffscreenCanvas> {
  const image = tex.image as CanvasImageSource & { width: number; height: number; data?: ArrayLike<number> };
  if (!image || !image.width) throw new Error("texture has no image yet");
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (image.data) {
    // DataTexture: RGBA8 rows, v = 0 first as uploaded (no flip for data textures).
    const src = new OffscreenCanvas(image.width, image.height);
    const px = new ImageData(image.width, image.height);
    px.data.set(image.data as ArrayLike<number>);
    src.getContext("2d")!.putImageData(px, 0, 0);
    ctx.drawImage(src, 0, 0, size, size);
  } else if (tex.flipY) {
    ctx.translate(0, size);
    ctx.scale(1, -1);
    ctx.drawImage(image, 0, 0, size, size);
  } else ctx.drawImage(image, 0, 0, size, size);
  if (channel === "g") {
    const px = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < px.data.length; i += 4) px.data[i + 3] = px.data[i + 1];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(px, 0, 0);
  }
  return canvas;
}

/** Longest an arrived alpha mask waits for the rest of its burst before the rebuild that brings it in. */
const ALPHA_SETTLE_MS = 1000;

/**
 * The receiver's WGSL, with its four bindings under the names three declares
 * them by. three wraps a plain storage array in a struct (`name.value`); the
 * params buffer is declared with Sundial's own struct type instead.
 */
function receiverCode(): string {
  return `${COMMON_WGSL}\n${RECEIVER_WGSL.replace(/\bpsPageTable\[/g, "psPageTable.value[")}`;
}

/**
 * A struct type three declares a storage buffer with but never defines: the
 * receiver's include defines `PsParams` itself (COMMON_WGSL).
 */
const PS_PARAMS_TYPE = {
  isStructTypeNode: true,
  getNodeType: () => "PsParams",
  getMemberType: () => "void",
  build: () => "PsParams",
};

/**
 * The shadow factor for one light, as `light.shadow.shadowNode`: an RGB
 * factor three multiplies the light's colour by. Grey in normal use; in debug
 * mode, the sampled level's colour (psApply). Specialised
 * per material at build time: opaque one-sided materials skip the lookup for
 * faces turned away from the sun.
 */
class SundialShadowNode extends Node {
  constructor(private readonly host: SundialThree) {
    super("vec3");
  }

  override setup(builder: NodeBuilder) {
    const material = builder.material as Material & { transmission?: number };
    const host = this.host;
    if (!host.receiveMaterial(material)) return vec3(1);
    const front = material.side === FrontSide && !(material.transmission! > 0);
    const normal = material.side === DoubleSide || material.side === BackSide ? normalWorldGeometry.mul(faceDirection) : normalWorldGeometry;
    return (front ? host.receiverFront : host.receiverAny)({ posW: positionWorld, normalW: normal, on: host.enabledNode });
  }
}

export class SundialThree {
  readonly core: PagedShadowCore;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly light: DirectionalLight;
  /** The camera whose depth drives page marking and whose position picks the level. */
  camera: Camera;

  /** @internal */ readonly enabledNode = uniform(1);
  /** @internal */ readonly receiverAny;
  /** @internal */ readonly receiverFront;
  /** @internal */ readonly receiveMaterial: (material: Material) => boolean;

  private readonly shadowNode: SundialShadowNode;
  private readonly externals: { dispose(): void }[] = [];
  private entries: { mesh: Mesh; options: CasterOptions }[] = [];
  private tracked: Tracked[] = [];
  private readonly statics = new Map<Mesh, { groups: InstanceGroup[]; last: Float32Array }[]>();
  private readonly alphaLayers = new Map<string, AlphaLayer>();
  private warnedAlphaLayers = false;
  private alphaRebuildPending = false;
  private alphaReadyAt = 0;
  private rebuildPending = false;
  private running = false;
  private disposed = false;
  private pendingUpdate = true;
  private previousBefore: SceneHook | null = null;
  private previousAfter: SceneHook | null = null;
  private readonly invViewProj = new Matrix4();
  private readonly sizeScratch = new Vector2();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly frameInput: { eye: Vec3; lightDir: Vec3; pixelWorldSizeAt1m: number } = {
    eye: [0, 0, 0],
    lightDir: [0, 0, 0],
    pixelWorldSizeAt1m: 0,
  };

  /**
   * True when Sundial can run on this renderer: a WebGPURenderer on its WebGPU
   * backend, after `await renderer.init()`. On the WebGL2 fallback keep
   * three's own shadows. Importing this module is always safe.
   */
  static isSupported(renderer: WebGPURenderer): boolean {
    const backend = backendOf(renderer);
    return !!backend?.isWebGPUBackend && !!backend.device;
  }

  constructor(renderer: WebGPURenderer, scene: Scene, camera: Camera, light: DirectionalLight, options: SundialThreeOptions) {
    if (!SundialThree.isSupported(renderer)) throw new Error("Sundial needs WebGPURenderer on WebGPU, after `await renderer.init()`");
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.light = light;
    this.receiveMaterial = options.receiveMaterial ?? (() => true);
    const backend = backendOf(renderer);
    this.core = new PagedShadowCore(backend.device!, { maxAlphaLayers: 16, ...options });

    // The four bindings, backed by the core's own GPU objects. three allocates
    // a storage buffer only when its side-table row is empty, so filling the
    // row first makes three bind ours. It never writes them: their versions
    // never change. ExternalTexture is three's own route for a GPUTexture it
    // does not own; the pool needs a DepthTexture flagged the same way, so
    // three declares it texture_depth_2d.
    const paramsAttr = new StorageBufferAttribute(new Uint32Array(4), 4);
    backend.get(paramsAttr).buffer = this.core.paramsBuffer;
    const tableAttr = new StorageBufferAttribute(new Uint32Array(2), 2);
    backend.get(tableAttr).buffer = this.core.pageTableBuffer;
    const pool = new DepthTexture(this.core.poolSize, this.core.poolSize, FloatType);
    Object.assign(pool, { isExternalTexture: true, sourceTexture: this.core.poolTexture });
    pool.minFilter = pool.magFilter = NearestFilter;
    const minMax = new ExternalTexture(this.core.minMaxTexture);
    minMax.format = RGIntegerFormat;
    minMax.type = UnsignedIntType;
    minMax.minFilter = minMax.magFilter = NearestFilter;
    minMax.generateMipmaps = false;
    this.externals.push(pool, minMax);

    const bindings = code(receiverCode(), [
      storage(paramsAttr, PS_PARAMS_TYPE as never, 0).toReadOnly().setName("psParams"),
      storage(tableAttr, "uvec2", 1).toReadOnly().setName("psPageTable"),
      texture(pool).setName("psPool"),
      texture(minMax).setName("psMinMax"),
    ], "wgsl");
    this.receiverAny = wgslFn(
      `fn sundialShadow(posW: vec3f, normalW: vec3f, on: f32) -> vec3f {
  if (on < 0.5) { return vec3f(1.0); }
  return psApply(vec3f(1.0), psShadow(posW, normalW));
}`,
      [bindings],
    );
    this.receiverFront = wgslFn(
      `fn sundialShadowFront(posW: vec3f, normalW: vec3f, on: f32) -> vec3f {
  if (on < 0.5) { return vec3f(1.0); }
  return psApply(vec3f(1.0), psShadowFront(posW, normalW));
}`,
      [bindings],
    );
    this.shadowNode = new SundialShadowNode(this);
  }

  /**
   * Register a mesh (an InstancedMesh casts every instance) as a caster, one
   * group per material it draws with. Geometry groups whose material is
   * missing or invisible do not cast. After start() it is built in at the next frame.
   */
  addCaster(mesh: Mesh, options: CasterOptions = {}): InstanceGroup[] {
    this.entries.push({ mesh, options });
    if (this.running) this.rebuildPending = true;
    return this.register(mesh, options);
  }

  /** Replace every caster and rebuild. Returns each entry's groups, in order. */
  setCasters(entries: CasterEntry[]): InstanceGroup[][] {
    this.entries = entries.map((e) => ("isMesh" in e ? { mesh: e as Mesh, options: {} } : { mesh: e.mesh, options: e.options ?? {} }));
    return this.rebuild();
  }

  /**
   * Every visible mesh under `root` with `castShadow`, as static casters
   * (SkinnedMeshes as dynamic, so they cast their pose). A convenience for
   * scenes that already mark their casters the three.js way.
   */
  static castersIn(root: Object3D): CasterEntry[] {
    const out: CasterEntry[] = [];
    root.traverseVisible((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.castShadow) out.push((m as SkinnedMesh).isSkinnedMesh ? { mesh: m, options: { dynamic: true } } : m);
    });
    return out;
  }

  /**
   * Move a registered STATIC caster without a rebuild: re-reads its world
   * matrix (and instance matrices) and re-renders only what moved. Returns
   * false when the mesh is not a static caster or its instance count changed.
   */
  updateCaster(mesh: Mesh): boolean {
    const records = this.statics.get(mesh);
    if (!records?.length) return false;
    mesh.updateWorldMatrix(true, false);
    const now = casterMatrices(mesh);
    if (records.some((r) => r.last.length !== now.length)) return false;
    for (const r of records) {
      for (let i = 0, n = now.length / 16; i < n; i++) {
        const o = i * 16;
        let moved = false;
        for (let k = 0; k < 16 && !moved; k++) moved = now[o + k] !== r.last[o + k];
        if (!moved) continue;
        r.last.set(now.subarray(o, o + 16), o);
        for (const g of r.groups) this.core.setInstanceMatrix(g, i, now, o);
      }
    }
    return true;
  }

  setAlphaMask(layer: number, source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap, cutoff = 0.5): void {
    this.core.setAlphaLayer(layer, source, cutoff);
  }

  /** Shadow darkness, as Babylon's setDarkness: 0 = black, 1 = invisible. */
  setDarkness(darkness: number): void {
    this.core.tuning.darkness = darkness;
  }

  setSceneBounds(min: Vec3, max: Vec3): void {
    this.core.setSceneBounds(min, max);
  }

  get enabled(): boolean {
    return this.enabledNode.value === 1;
  }

  /** Off: receivers fall back to plain unshadowed sun light (for A/B). No shader recompiles either way. */
  setEnabled(on: boolean): void {
    if (on && !this.enabled) this.core.invalidateAll();
    this.enabledNode.value = on ? 1 : 0;
  }

  /** Upload content, attach the receiver to the light, and start running every frame. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.core.build();
    // Receivers need three's shadow path on for this light: it is where the
    // shadow node is read. Nothing renders a shadow map for it.
    this.renderer.shadowMap.enabled = true;
    this.light.castShadow = true;
    (this.light.shadow as unknown as { shadowNode: Node }).shadowNode = this.shadowNode;
    const hooks = this.scene as unknown as SceneHooks;
    const before = (this.previousBefore = hooks.onBeforeRender);
    const after = (this.previousAfter = hooks.onAfterRender);
    hooks.onBeforeRender = (renderer, scene, camera, target) => {
      before.call(scene, renderer, scene, camera, target);
      if (camera === this.camera) this.update();
    };
    hooks.onAfterRender = (renderer, scene, camera, target) => {
      after.call(scene, renderer, scene, camera, target);
      if (camera === this.camera) this.mark(target);
    };
  }

  /** Stop, free every GPU resource and detach from the light. The instance cannot be restarted. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.running) {
      const hooks = this.scene as unknown as SceneHooks;
      if (this.previousBefore) hooks.onBeforeRender = this.previousBefore;
      if (this.previousAfter) hooks.onAfterRender = this.previousAfter;
      const shadow = this.light.shadow as unknown as { shadowNode?: Node };
      if (shadow.shadowNode === this.shadowNode) delete shadow.shadowNode;
      this.light.castShadow = false;
    }
    this.running = false;
    for (const t of this.externals) t.dispose();
    this.core.dispose();
  }

  // ---- internals --------------------------------------------------------------

  private rebuild(internal = false): InstanceGroup[][] {
    this.rebuildPending = false;
    this.alphaRebuildPending = false;
    this.tracked = [];
    this.statics.clear();
    this.core.clearContent();
    const groups = this.entries.map((e) => this.register(e.mesh, e.options));
    if (this.running) this.core.build({ internal });
    return groups;
  }

  private register(mesh: Mesh, opts: CasterOptions): InstanceGroup[] {
    mesh.updateWorldMatrix(true, false);
    const runs = this.readRuns(mesh, opts);
    const instanced = (mesh as InstancedMesh).isInstancedMesh;
    const slots = instanced
      ? opts.dynamic
        ? Math.max(opts.capacity ?? 0, (mesh as InstancedMesh).instanceMatrix.count)
        : (mesh as InstancedMesh).count
      : 1;
    const matrices = casterMatrices(mesh, undefined, slots);
    const groups: InstanceGroup[] = [];
    for (const run of runs) groups.push(this.core.addInstances(this.core.addGeometry(run.input, run.key), matrices, !!opts.dynamic));
    if (!groups.length) return groups;
    if (opts.dynamic) {
      this.tracked.push({
        mesh,
        groups,
        last: matrices.slice(),
        now: new Float32Array(matrices.length),
        // NaN: the first update always uploads the pose.
        skin: isSkinned(mesh, opts) ? { bones: new Float32Array((mesh as SkinnedMesh).skeleton.bones.length * 16).fill(NaN) } : undefined,
      });
    } else {
      let list = this.statics.get(mesh);
      if (!list) this.statics.set(mesh, (list = []));
      list.push({ groups, last: matrices.slice() });
    }
    return groups;
  }

  /** Each casting run's content key, and how to build its geometry on a cache miss. */
  private readRuns(mesh: Mesh, opts: CasterOptions): { key: string; input: () => GeometryInput }[] {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (!position) return [];
    const positions = readAttribute(position);
    const skinned = isSkinned(mesh, opts);
    const skin: SkinInput | null = skinned
      ? {
          boneCount: (mesh as SkinnedMesh).skeleton.bones.length,
          indices: readAttribute(geometry.getAttribute("skinIndex")),
          weights: readAttribute(geometry.getAttribute("skinWeight")),
        }
      : null;
    const skinKey = skin ? `:skin${skin.boneCount}:${contentHash(skin.indices, skin.weights)}` : "";
    const scope = `${positions.length}:${contentHash(positions)}${skinKey}`;
    const explicit = opts.alphaLayer !== undefined ? { layer: opts.alphaLayer, cutoff: opts.alphaCutoff ?? 0.5 } : undefined;
    const out: { key: string; input: () => GeometryInput }[] = [];
    for (const [material, run] of castingRuns(mesh)) {
      if (run.length < 3) continue;
      let alpha = explicit;
      let uvs: Float32Array | null = null;
      if (explicit) {
        const attr = geometry.getAttribute("uv");
        uvs = attr ? new Float32Array(readAttribute(attr)) : null;
      } else if (opts.autoAlpha !== false) {
        const source = alphaSource(material);
        uvs = source ? textureUVs(geometry, source.texture) : null;
        alpha = source && uvs ? this.alphaLayerFor(source) : undefined;
      }
      if (!alpha) uvs = null;
      const key = `${scope}:${contentHash(run)}:${alpha ? `${alpha.layer}/${alpha.cutoff}:${contentHash(uvs!)}` : "opaque"}`;
      out.push({ key, input: () => ({ ...compact(run, positions, uvs), alpha, skin: skin ? compactSkin(skin, run) : undefined }) });
    }
    return out;
  }

  /**
   * The alpha layer holding this source's coverage, or undefined while it is
   * being read (the caster casts opaque meanwhile, and a rebuild follows).
   * Layers are shared by texture, channel and cutoff, allocated from the top down.
   */
  private alphaLayerFor(source: { texture: Texture; channel: "a" | "g"; cutoff: number }): { layer: number; cutoff: number } | undefined {
    const key = `${source.texture.uuid}:${source.channel}:${source.cutoff}`;
    let entry = this.alphaLayers.get(key);
    if (!entry) {
      const layer = this.core.alphaLayerCount - 1 - this.alphaLayers.size;
      if (layer < 0) {
        if (!this.warnedAlphaLayers) console.warn(`Sundial: out of alpha layers (${this.core.alphaLayerCount}); further alpha-tested casters cast opaque. Raise maxAlphaLayers.`);
        this.warnedAlphaLayers = true;
        return undefined;
      }
      const loaded: AlphaLayer = { layer, cutoff: source.cutoff, state: "loading" };
      this.alphaLayers.set(key, (entry = loaded));
      const read = async () => {
        // An image still loading: wait for it (TextureLoader fills image before onLoad).
        for (let tries = 0; !(source.texture.image as { width?: number } | null)?.width; tries++) {
          if (tries > 600 || this.disposed) throw new Error("texture image never arrived");
          await new Promise((r) => setTimeout(r, 100));
        }
        return coverageCanvas(source.texture, source.channel, this.core.alphaSize);
      };
      read()
        .then((canvas) => {
          if (this.disposed) return;
          this.core.setAlphaLayer(loaded.layer, canvas, loaded.cutoff);
          loaded.state = "ready";
          if (!this.alphaRebuildPending) this.alphaReadyAt = performance.now();
          this.alphaRebuildPending = true;
        })
        .catch((e) => {
          loaded.state = "failed";
          console.warn(`Sundial: could not read an alpha mask from ${source.texture.name || source.texture.uuid}; its casters cast opaque.`, e);
        });
    }
    return entry.state === "ready" ? { layer: entry.layer, cutoff: entry.cutoff } : undefined;
  }

  /** Before the main camera renders: bring in pending content, track movers, and page. */
  private update(): void {
    // One update per marked frame: other renders of the scene with this camera
    // (a second pass, a reflection) must not page twice.
    if (!this.pendingUpdate || !this.enabled) return;
    this.pendingUpdate = false;
    if (
      this.alphaRebuildPending &&
      (performance.now() - this.alphaReadyAt > ALPHA_SETTLE_MS || ![...this.alphaLayers.values()].some((l) => l.state === "loading"))
    )
      this.rebuildPending = true;
    if (this.rebuildPending) this.rebuild(true);
    this.updateDynamics();
    const camera = this.camera;
    const input = this.frameInput;
    camera.getWorldPosition(this.v1);
    input.eye[0] = this.v1.x;
    input.eye[1] = this.v1.y;
    input.eye[2] = this.v1.z;
    this.light.updateWorldMatrix(true, false);
    this.light.target.updateWorldMatrix(true, false);
    this.light.getWorldPosition(this.v1);
    this.light.target.getWorldPosition(this.v2);
    input.lightDir[0] = this.v2.x - this.v1.x;
    input.lightDir[1] = this.v2.y - this.v1.y;
    input.lightDir[2] = this.v2.z - this.v1.z;
    const height = this.renderer.getDrawingBufferSize(this.sizeScratch).y || 1;
    const persp = camera as PerspectiveCamera;
    input.pixelWorldSizeAt1m = persp.isPerspectiveCamera
      ? (2 * Math.tan(((persp.fov * Math.PI) / 180) / 2)) / (persp.zoom || 1) / height
      : 1 / height;
    this.core.update(input);
  }

  /**
   * After the main camera renders: request pages from the depth it just wrote.
   * three has already submitted that frame's commands, so a submit here runs
   * after them, in queue order.
   */
  private mark(target: RenderTarget | null): void {
    if (!this.enabled) return;
    this.pendingUpdate = true;
    const depthTexture = this.depthOf(target);
    if (!depthTexture) return;
    const gpu = backendOf(this.renderer).get(depthTexture).texture;
    if (!gpu || !(gpu.usage & GPUTextureUsage.TEXTURE_BINDING)) return;
    const camera = this.camera;
    this.invViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    const encoder = this.core.device.createCommandEncoder({ label: "ps.markThree" });
    this.core.markInto(encoder, { texture: gpu, invViewProj: this.invViewProj.elements });
    this.core.device.queue.submit([encoder.finish()]);
  }

  /**
   * The depth texture a render into `target` wrote. The canvas has its own;
   * a render target either names one (`depthTexture`) or has one three made
   * for it internally, kept in the renderer's texture records. WebGPURenderer
   * renders the scene through such an internal target whenever tone mapping
   * or an output colour-space conversion is on, which is the default.
   */
  private depthOf(target: RenderTarget | null): DepthTexture | null {
    const r = this.renderer as unknown as {
      getCanvasTarget(): { depthTexture: DepthTexture };
      _textures: { get(target: RenderTarget): { depthTexture?: DepthTexture | null } };
    };
    if (!target) return r.getCanvasTarget().depthTexture ?? null;
    return (target.depthTexture as DepthTexture | null) ?? r._textures.get(target).depthTexture ?? null;
  }

  /** Re-read every dynamic caster and upload what moved. Allocates nothing. */
  private updateDynamics(): void {
    for (const t of this.tracked) {
      const mesh = t.mesh;
      const slots = t.groups[0].count;
      const instanced = (mesh as InstancedMesh).isInstancedMesh;
      if (instanced && (mesh as InstancedMesh).count > slots && !t.warnedCount) {
        t.warnedCount = true;
        console.warn(`Sundial: ${mesh.name || mesh.uuid} has ${(mesh as InstancedMesh).count} instances but ${slots} registered slots; the extra instances do not cast. Pass { capacity } to addCaster.`);
      }
      casterMatrices(mesh, t.now, slots);
      let posed = false;
      let bones: Float32Array | null = null;
      if (t.skin) {
        bones = this.posedBones(mesh as SkinnedMesh, t.skin.bones);
        posed = bones !== null;
        bones = t.skin.bones;
      }
      for (let i = 0; i < slots; i++) {
        const o = i * 16;
        let moved = posed;
        for (let k = 0; k < 16 && !moved; k++) moved = t.now[o + k] !== t.last[o + k];
        if (!moved) continue;
        t.last.set(t.now.subarray(o, o + 16), o);
        for (const g of t.groups) {
          if (bones) this.core.setSkinPose(g, i, t.now, o, bones, 0);
          else this.core.setInstanceMatrix(g, i, t.now, o);
        }
      }
    }
  }

  /**
   * A skinned mesh's bone matrices in posed mesh space (bind-pose mesh space
   * to posed mesh space, what the core expects), written into `last` when
   * they changed. Returns null when the pose is unchanged.
   * three skins as bindMatrixInverse · Σ w · boneMatrix · bindMatrix.
   */
  private posedBones(mesh: SkinnedMesh, last: Float32Array): Float32Array | null {
    const skeleton = mesh.skeleton;
    skeleton.update();
    const src = skeleton.boneMatrices as Float32Array;
    let changed = false;
    for (let b = 0, n = skeleton.bones.length; b < n; b++) {
      LOCAL.fromArray(src, b * 16);
      PRODUCT.multiplyMatrices(mesh.bindMatrixInverse, LOCAL);
      BIND.multiplyMatrices(PRODUCT, mesh.bindMatrix);
      const e = BIND.elements;
      for (let k = 0; k < 16; k++) {
        if (last[b * 16 + k] !== e[k]) {
          changed = true;
          last[b * 16 + k] = e[k];
        }
      }
    }
    return changed ? last : null;
  }
}
