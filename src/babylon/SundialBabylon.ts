import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Material } from "@babylonjs/core/Materials/material";
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
}

interface DynamicCaster {
  mesh: Mesh;
  group: InstanceGroup;
  /** 16 floats per instance: the final world matrices last uploaded. */
  last: Float32Array;
  warnedCount?: boolean;
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
  private afterCameraObserver: Observer<Camera> | null = null;
  private depthSnapshot: DepthSnapshot | null = null;
  private readonly scratch = new Matrix();
  private scratchMatrices: Float32Array = new Float32Array(0);

  constructor(scene: Scene, light: DirectionalLight, options: PagedShadowOptions) {
    this.scene = scene;
    this.light = light;
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

  /** Register a mesh (and all of its thin instances) as a shadow caster. */
  addCaster(mesh: Mesh, opts: CasterOptions = {}): InstanceGroup {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices) throw new Error(`Sundial: ${mesh.name} has no geometry`);
    const uvs = opts.alphaLayer !== undefined ? mesh.getVerticesData(VertexBuffer.UVKind) ?? undefined : undefined;
    const geometry = this.core.addGeometry({
      positions: new Float32Array(positions),
      indices: indices as number[],
      uvs: uvs ? new Float32Array(uvs) : undefined,
      alpha: opts.alphaLayer !== undefined ? { layer: opts.alphaLayer, cutoff: opts.alphaCutoff ?? 0.5 } : undefined,
    });
    const matrices = casterMatrices(mesh);
    const group = this.core.addInstances(geometry, matrices, !!opts.dynamic);
    if (opts.dynamic) this.dynamics.push({ mesh, group, last: matrices.slice() });
    return group;
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

  dispose(): void {
    this.observer?.remove();
    this.afterCameraObserver?.remove();
  }

  /** Snapshot what the main camera's depth buffer was rendered with (review F1). */
  private captureDepth(camera: Camera): void {
    if (camera !== this.scene.activeCamera) return;
    const depth = (this.scene.getEngine() as unknown as { _depthTexture?: GPUTexture })._depthTexture;
    if (!depth) return;
    camera.getTransformationMatrix().invertToRef(this.scratch);
    this.depthSnapshot = { texture: depth, invViewProj: new Float32Array(this.scratch.m) };
  }

  private update(): void {
    if (!this.enabled) return;
    this.updateDynamics();
    const camera = this.scene.activeCamera as Camera;
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
   * moved. Thin-instanced casters are tracked per instance (review F2); a
   * changed thin-instance count is not supported and is reported once.
   */
  private updateDynamics(): void {
    for (const d of this.dynamics) {
      const now = casterMatrices(d.mesh, this.scratchMatrices);
      this.scratchMatrices = now;
      const count = Math.min(d.group.count, now.length / 16);
      if (now.length / 16 !== d.group.count && !d.warnedCount) {
        d.warnedCount = true;
        console.warn(`Sundial: ${d.mesh.name} changed thin-instance count (${d.group.count} → ${now.length / 16}); only the first ${count} are tracked`);
      }
      for (let i = 0; i < count; i++) {
        const o = i * 16;
        let moved = false;
        for (let k = 0; k < 16; k++) {
          if (now[o + k] !== d.last[o + k]) {
            moved = true;
            break;
          }
        }
        if (moved) {
          const m = now.subarray(o, o + 16);
          d.last.set(m, o);
          this.core.setInstanceMatrix(d.group, i, m);
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
