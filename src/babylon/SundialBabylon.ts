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
  mesh: AbstractMesh;
  group: InstanceGroup;
  last: Float32Array;
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
  private readonly invViewProj = new Matrix();
  private hasRendered = false;

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
    const world = mesh.computeWorldMatrix(true);
    let matrices: Float32Array;
    if (mesh.thinInstanceCount > 0) {
      const thin = mesh.thinInstanceGetWorldMatrices();
      matrices = new Float32Array(thin.length * 16);
      const tmp = new Matrix();
      thin.forEach((m, i) => {
        m.multiplyToRef(world, tmp);
        matrices.set(tmp.m, i * 16);
      });
    } else {
      matrices = new Float32Array(world.m);
    }
    const group = this.core.addInstances(geometry, matrices, !!opts.dynamic);
    if (opts.dynamic) this.dynamics.push({ mesh, group, last: new Float32Array(world.m) });
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
  }

  setEnabled(on: boolean): void {
    // Things may have moved while nothing was tracking them.
    if (on && !this.enabled) this.core.invalidateAll();
    this.enabled = on;
    for (const p of this.plugins) p.markAllDefinesAsDirty();
  }

  dispose(): void {
    this.observer?.remove();
  }

  private update(): void {
    if (!this.enabled) return;
    for (const d of this.dynamics) {
      const m = d.mesh.computeWorldMatrix(true).m;
      let moved = false;
      for (let i = 0; i < 16; i++) {
        if (m[i] !== d.last[i]) {
          moved = true;
          break;
        }
      }
      if (moved) {
        d.last.set(m);
        this.core.setInstanceMatrix(d.group, 0, m as unknown as Float32Array);
      }
    }
    const camera = this.scene.activeCamera as Camera;
    const eye = camera.globalPosition;
    const dir = this.light.direction;
    const engine = this.scene.getEngine() as WebGPUEngine;
    const depth = (engine as unknown as { _depthTexture?: GPUTexture })._depthTexture;
    // The depth buffer still holds the previous frame, and the scene's
    // transform is still the one it was rendered with.
    this.scene.getTransformMatrix().invertToRef(this.invViewProj);
    this.core.update({
      eye: [eye.x, eye.y, eye.z],
      lightDir: [dir.x, dir.y, dir.z],
      pixelWorldSizeAt1m: (2 * Math.tan(camera.fov / 2)) / engine.getRenderHeight(),
      depth: depth && this.hasRendered ? { texture: depth, invViewProj: this.invViewProj.m } : undefined,
    });
    this.hasRendered = true;
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
