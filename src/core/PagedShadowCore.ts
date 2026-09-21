import { buildGeometry, type BuiltGeometry, type GeometryInput } from "./geometry";
import {
  C_ALLOC,
  C_ALLOC_FAIL,
  C_ALPHA_PAIRS,
  C_DEFERRED,
  C_OPAQUE_PAIRS,
  C_RENDER,
  C_REQUESTED,
  C_RESIDENT,
  COUNTER_COUNT,
  kernelsWGSL,
  markWGSL,
  workLayout,
  type WorkLayout,
} from "./kernels";
import { rasterWGSL } from "./raster";
import { LEVELS_WORD, MAX_LEVELS, MAX_REGIONS, PARAMS_BYTES, PARAMS_HEADER_BYTES } from "./wgsl";

// Sundial: a paged, cached shadow clipmap for one directional light.
//
// Frame flow, all on the GPU after one small params upload:
//   mark (last frame's camera depth) -> update/retag -> invalidate -> allocate
//   -> render list -> cluster x page cull -> one clear draw + two caster draws
// The CPU never learns which pages are resident; it only decides when a level's
// light basis has drifted far enough to be re-rendered.

export type Vec3 = [number, number, number];

export interface PagedShadowOptions {
  /** World-space bounds of everything that can cast or receive. */
  sceneMin: Vec3;
  sceneMax: Vec3;
  /** Clipmap levels, each twice the size of the last. */
  levels?: number;
  /** Pages per side of each level's window. */
  pagesPerSide?: number;
  /** Texels per page side. */
  pageSize?: number;
  /** Physical pool texels per side. */
  poolSize?: number;
  /** World size of one level-0 page. */
  finestPageWorldSize?: number;
  /** Most pages re-rendered in one frame; the rest fall back a level for a frame. */
  renderBudget?: number;
  /** Capacity of each (cluster, page) pair list. */
  maxPairs?: number;
  /** Triangles per cluster. */
  clusterTris?: number;
  alphaTextureSize?: number;
  maxAlphaLayers?: number;
}

export interface FrameInput {
  eye: Vec3;
  /** Direction the light travels (sun -> scene), need not be normalized. */
  lightDir: Vec3;
  /** World size of one screen pixel at 1 m from the eye: 2 tan(fovY/2) / viewportHeight. */
  pixelWorldSizeAt1m: number;
  /**
   * Camera depth of the most recently rendered frame, and the clip-to-world
   * matrix it was rendered with (16 floats, column-major). Pages are requested
   * from it. Without it only the always-resident coarsest level is available.
   */
  depth?: { texture: GPUTexture; invViewProj: ArrayLike<number> };
}

export interface Tuning {
  /** Added to the chosen clipmap level; positive trades sharpness for fewer pages. */
  lodBias: number;
  /** Receiver offset along the normal, in texels of the sampled level. */
  normalOffset: number;
  /** Receiver depth bias, in texels of the sampled level. */
  depthBias: number;
  /** 0 = off, 1 = tint receivers by level. */
  debugMode: number;
  /** Sun-angle tolerance of level 0 in degrees; level k tolerates 2^k times more. */
  bandDegrees: number;
  renderBudget: number;
}

export interface Stats {
  frame: number;
  requestedPages: number;
  residentPages: number;
  renderedPages: number;
  deferredPages: number;
  allocations: number;
  allocationFailures: number;
  opaquePairs: number;
  alphaPairs: number;
  /**
   * GPU time in ms (null without timestamp-query) of page marking, page
   * management and page raster. Marking includes any wait for the previous
   * frame's depth, so it is an upper bound.
   */
  gpuMarkMs: number | null;
  gpuComputeMs: number | null;
  gpuRasterMs: number | null;
  levelRefreshes: number;
  lastRefreshedLevel: number;
}

export interface InstanceGroup {
  readonly geometry: number;
  readonly first: number; // first instance index
  readonly count: number;
  readonly dynamic: boolean;
}

interface LevelState {
  dir: Vec3;
  right: Vec3;
  up: Vec3;
  zMin: number;
  zRange: number;
  invalidate: boolean;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const STORAGE = GPUBufferUsage.STORAGE;
const COPY_DST = GPUBufferUsage.COPY_DST;
const COPY_SRC = GPUBufferUsage.COPY_SRC;

export class PagedShadowCore {
  readonly device: GPUDevice;
  readonly levelCount: number;
  readonly pagesPerSide: number;
  readonly pageSize: number;
  readonly poolSize: number;
  readonly pageCount: number;
  readonly finestPageWorldSize: number;
  readonly clusterTris: number;
  readonly maxPairs: number;
  readonly useClipDistances: boolean;
  readonly hasTimestamps: boolean;

  readonly tuning: Tuning = {
    lodBias: 0,
    normalOffset: 1.5,
    depthBias: 1.5,
    debugMode: 0,
    bandDegrees: 0.05,
    renderBudget: 96,
  };

  /** Resources receivers bind (params, page table, pool). */
  readonly paramsBuffer: GPUBuffer;
  readonly pageTableBuffer: GPUBuffer;
  readonly requestBuffer: GPUBuffer;
  readonly poolTexture: GPUTexture;

  stats: Stats = {
    frame: 0, requestedPages: 0, residentPages: 0, renderedPages: 0, deferredPages: 0, allocations: 0,
    allocationFailures: 0, opaquePairs: 0, alphaPairs: 0, gpuMarkMs: null, gpuComputeMs: null, gpuRasterMs: null,
    levelRefreshes: 0, lastRefreshedLevel: -1,
  };

  private readonly sceneMin: Vec3;
  private readonly sceneMax: Vec3;
  private readonly renderBudgetMax: number;
  private readonly slots: number;
  private readonly work: WorkLayout;
  private readonly workBuffer: GPUBuffer;
  private readonly counterBuffer: GPUBuffer;
  private readonly pairBuffer: GPUBuffer;
  private readonly alphaTexture: GPUTexture;
  private readonly alphaSize: number;
  private readonly alphaSampler: GPUSampler;
  private readonly params = new ArrayBuffer(PARAMS_BYTES);
  private readonly levels: LevelState[] = [];

  private geometries: BuiltGeometry[] = [];
  private groups: InstanceGroup[] = [];
  private instanceMatrices: number[] = []; // 12 floats (3 affine rows) per instance
  private instanceGeometry: number[] = [];
  private regions: number[] = [];
  private dirtyInstances = new Set<number>();

  private sceneBuffer: GPUBuffer | null = null;
  private clusterInstanceBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private clusterCount = 0;
  private clusterInstanceCount = 0;

  private computeLayout!: GPUBindGroupLayout;
  private rasterLayout!: GPUBindGroupLayout;
  private computeGroup: GPUBindGroup | null = null;
  private rasterGroup: GPUBindGroup | null = null;
  private kernels: Record<string, GPUComputePipeline> = {};
  private clearPipeline!: GPURenderPipeline;
  private opaquePipeline!: GPURenderPipeline;
  private alphaPipeline!: GPURenderPipeline;

  private markPipelines = new Map<boolean, GPUComputePipeline>();
  private depthBinding: { texture: GPUTexture; group: GPUBindGroup } | null = null;
  /** Depth pixels between samples when marking pages. */
  markStride = 2;

  private querySet: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private readbacks: { buffer: GPUBuffer; busy: boolean }[] = [];
  private frame = 0;
  private started = false;

  constructor(device: GPUDevice, options: PagedShadowOptions) {
    this.device = device;
    this.sceneMin = options.sceneMin;
    this.sceneMax = options.sceneMax;
    this.levelCount = Math.min(MAX_LEVELS, options.levels ?? 7);
    this.pagesPerSide = options.pagesPerSide ?? 16;
    this.pageSize = options.pageSize ?? 128;
    this.poolSize = options.poolSize ?? 4096;
    this.pageCount = (this.poolSize / this.pageSize) ** 2;
    this.finestPageWorldSize = options.finestPageWorldSize ?? 1;
    this.clusterTris = options.clusterTris ?? 64;
    this.maxPairs = options.maxPairs ?? 1 << 19;
    this.renderBudgetMax = 1024;
    this.tuning.renderBudget = options.renderBudget ?? this.tuning.renderBudget;
    this.slots = this.levelCount * this.pagesPerSide * this.pagesPerSide;
    this.work = workLayout(this.slots, this.pageCount, this.renderBudgetMax);
    this.useClipDistances = device.features.has("clip-distances");
    this.hasTimestamps = device.features.has("timestamp-query");

    this.paramsBuffer = device.createBuffer({ label: "ps.params", size: PARAMS_BYTES, usage: STORAGE | COPY_DST });
    this.pageTableBuffer = device.createBuffer({ label: "ps.pageTable", size: this.slots * 8, usage: STORAGE | COPY_DST });
    this.requestBuffer = device.createBuffer({ label: "ps.requests", size: this.slots * 4, usage: STORAGE | COPY_DST });
    this.counterBuffer = device.createBuffer({ label: "ps.counters", size: COUNTER_COUNT * 4, usage: STORAGE | COPY_DST | COPY_SRC });
    this.workBuffer = device.createBuffer({
      label: "ps.work",
      size: this.work.total * 4,
      usage: STORAGE | COPY_DST | GPUBufferUsage.INDIRECT,
    });
    this.pairBuffer = device.createBuffer({ label: "ps.pairs", size: this.maxPairs * 2 * 8, usage: STORAGE });
    this.poolTexture = device.createTexture({
      label: "ps.pool",
      size: [this.poolSize, this.poolSize],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.alphaSize = options.alphaTextureSize ?? 256;
    const alphaLayers = options.maxAlphaLayers ?? 4;
    this.alphaTexture = device.createTexture({
      label: "ps.alpha",
      size: [this.alphaSize, this.alphaSize, alphaLayers],
      mipLevelCount: Math.log2(this.alphaSize) + 1,
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.alphaSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });

    // Draw-arg constants that never change: vertex counts and zero offsets.
    const ind = new Uint32Array(12);
    ind[0] = 6;
    ind[4] = this.clusterTris * 3;
    ind[8] = this.clusterTris * 3;
    device.queue.writeBuffer(this.workBuffer, this.work.indirect * 4, ind);

    if (this.hasTimestamps) {
      this.querySet = device.createQuerySet({ type: "timestamp", count: 6 });
      this.queryResolve = device.createBuffer({ size: 48, usage: GPUBufferUsage.QUERY_RESOLVE | COPY_SRC });
    }
    for (let i = 0; i < 3; i++) {
      this.readbacks.push({
        buffer: device.createBuffer({ size: COUNTER_COUNT * 4 + 48, usage: GPUBufferUsage.MAP_READ | COPY_DST }),
        busy: false,
      });
    }

    for (let l = 0; l < this.levelCount; l++) {
      this.levels.push({ dir: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1], zMin: 0, zRange: 1, invalidate: true });
    }
    this.createPipelines();
  }

  // ---- content ------------------------------------------------------------

  addGeometry(input: GeometryInput): number {
    this.geometries.push(buildGeometry(input, this.clusterTris));
    return this.geometries.length - 1;
  }

  /** `matrices` holds 16 floats per instance, column-major with translation at 12..14 (Babylon and three.js layout). */
  addInstances(geometry: number, matrices: Float32Array | number[], dynamic = false): InstanceGroup {
    const count = matrices.length / 16;
    const group: InstanceGroup = { geometry, first: this.instanceGeometry.length, count, dynamic };
    for (let i = 0; i < count; i++) {
      this.instanceMatrices.push(...affineRows(matrices, i * 16));
      this.instanceGeometry.push(geometry);
    }
    this.groups.push(group);
    return group;
  }

  /** Move one instance. Its old and new footprints are re-rendered next frame. */
  setInstanceMatrix(group: InstanceGroup, index: number, matrix: Float32Array | number[]): void {
    const inst = group.first + index;
    const before = this.instanceBounds(inst);
    this.instanceMatrices.splice(inst * 12, 12, ...affineRows(matrix, 0));
    const after = this.instanceBounds(inst);
    this.invalidateBox(
      [Math.min(before[0][0], after[0][0]), Math.min(before[0][1], after[0][1]), Math.min(before[0][2], after[0][2])],
      [Math.max(before[1][0], after[1][0]), Math.max(before[1][1], after[1][1]), Math.max(before[1][2], after[1][2])],
    );
    this.dirtyInstances.add(inst);
  }

  /** Re-render every cached page whose light-space footprint meets this world box. */
  invalidateBox(min: Vec3, max: Vec3): void {
    if (this.regions.length / 8 >= MAX_REGIONS) {
      this.invalidateAll();
      return;
    }
    this.regions.push(min[0], min[1], min[2], 0, max[0], max[1], max[2], 0);
  }

  invalidateAll(): void {
    for (const lv of this.levels) lv.invalidate = true;
  }

  /**
   * Upload an alpha mask for alpha-tested casters. Mips are built on the CPU
   * and coverage-preserving: plain downsampling averages alpha below the
   * cutoff, so leaves thin out of exactly the coarse levels that shade the
   * distance. Each mip's alpha is rescaled until the fraction of texels that
   * pass `cutoff` matches the full-resolution mask.
   */
  setAlphaLayer(layer: number, source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap, cutoff = 0.5): void {
    let size = this.alphaSize;
    let level = 0;
    let target = -1;
    const threshold = cutoff * 255;
    while (size >= 1) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(source as CanvasImageSource, 0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      const px = img.data;
      const coverage = (scale: number) => {
        let pass = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] * scale >= threshold) pass++;
        return pass / (size * size);
      };
      if (target < 0) {
        target = coverage(1);
      } else {
        let lo = 0;
        let hi = 16;
        for (let it = 0; it < 20; it++) {
          const mid = (lo + hi) / 2;
          if (coverage(mid) < target) lo = mid;
          else hi = mid;
        }
        for (let i = 3; i < px.length; i += 4) px[i] = Math.min(255, px[i] * hi);
        ctx.putImageData(img, 0, 0);
      }
      this.device.queue.copyExternalImageToTexture(
        { source: canvas },
        { texture: this.alphaTexture, mipLevel: level, origin: [0, 0, layer] },
        [size, size],
      );
      size >>= 1;
      level++;
    }
  }

  /** Pack all registered content into GPU buffers. Call once after adding content. */
  build(): void {
    const clusterRecords: { geom: number; base: number }[] = [];
    let vertexBase = 0;
    let indexBase = 0;
    const vertexData: Float32Array[] = [];
    const indexData: Uint32Array[] = [];
    const geomClusterStart: number[] = [];
    const sceneVec: number[] = [];
    for (let g = 0; g < this.geometries.length; g++) {
      const geo = this.geometries[g];
      const vcount = geo.positions.length / 3;
      const v = new Float32Array(vcount * 5);
      for (let i = 0; i < vcount; i++) {
        v[i * 5] = geo.positions[i * 3];
        v[i * 5 + 1] = geo.positions[i * 3 + 1];
        v[i * 5 + 2] = geo.positions[i * 3 + 2];
        v[i * 5 + 3] = geo.uvs[i * 2];
        v[i * 5 + 4] = geo.uvs[i * 2 + 1];
      }
      vertexData.push(v);
      const idx = new Uint32Array(geo.indices.length);
      for (let i = 0; i < idx.length; i++) idx[i] = geo.indices[i] + vertexBase;
      indexData.push(idx);
      geomClusterStart.push(clusterRecords.length);
      for (const cl of geo.clusters) {
        clusterRecords.push({ geom: g, base: indexBase });
        const f = new Float32Array(12);
        const u = new Uint32Array(f.buffer);
        f.set(cl.aabbMin, 0);
        u[3] = cl.firstIndex + indexBase;
        f.set(cl.aabbMax, 4);
        u[7] = cl.triCount;
        u[8] = cl.alphaLayer;
        f[9] = cl.alphaCutoff;
        sceneVec.push(...f);
      }
      vertexBase += vcount;
      indexBase += idx.length;
    }
    this.clusterCount = clusterRecords.length;

    // Cluster instances: every cluster of an instance's geometry.
    const ci: number[] = [];
    for (let inst = 0; inst < this.instanceGeometry.length; inst++) {
      const g = this.instanceGeometry[inst];
      const start = geomClusterStart[g];
      const n = this.geometries[g].clusters.length;
      for (let c = 0; c < n; c++) ci.push(start + c, inst);
    }
    this.clusterInstanceCount = ci.length / 2;

    const scene = new Float32Array(sceneVec.length + this.instanceMatrices.length);
    scene.set(sceneVec, 0);
    scene.set(this.instanceMatrices, sceneVec.length);

    this.sceneBuffer = this.upload("ps.scene", scene, STORAGE | COPY_DST);
    this.clusterInstanceBuffer = this.upload("ps.clusterInstances", new Uint32Array(ci), STORAGE);
    this.vertexBuffer = this.upload("ps.vertices", concatF32(vertexData), STORAGE);
    this.indexBuffer = this.upload("ps.indices", concatU32(indexData), STORAGE);
    this.dirtyInstances.clear();

    const d = this.device;
    this.computeGroup = d.createBindGroup({
      layout: this.computeLayout,
      entries: [
        this.paramsBuffer, this.pageTableBuffer, this.requestBuffer, this.counterBuffer,
        this.workBuffer, this.sceneBuffer, this.clusterInstanceBuffer, this.pairBuffer,
      ].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.rasterGroup = d.createBindGroup({
      layout: this.rasterLayout,
      entries: [
        ...[
          this.paramsBuffer, this.pageTableBuffer, this.workBuffer, this.pairBuffer,
          this.sceneBuffer, this.clusterInstanceBuffer, this.vertexBuffer, this.indexBuffer,
        ].map((buffer, binding) => ({ binding, resource: { buffer } })),
        { binding: 8, resource: this.alphaTexture.createView({ dimension: "2d-array" }) },
        { binding: 9, resource: this.alphaSampler },
      ],
    });
  }

  get contentSummary() {
    return {
      geometries: this.geometries.length,
      instances: this.instanceGeometry.length,
      clusters: this.clusterCount,
      clusterInstances: this.clusterInstanceCount,
      triangles: this.geometries.reduce((s, g) => s + g.indices.length / 3, 0),
    };
  }

  // ---- per frame ------------------------------------------------------------

  /** Run the paging pipeline for this frame. Submit before the receivers render. */
  update(input: FrameInput): void {
    if (!this.computeGroup || !this.rasterGroup) throw new Error("PagedShadowCore.build() has not run");
    const d = this.device;
    this.frame++;
    const lightDir = normalize(input.lightDir);
    this.refreshLevels(lightDir);
    this.uploadDirtyInstances();
    const regionCount = this.writeParams(input);
    const depth = input.depth ? this.bindDepth(input.depth.texture) : null;

    const enc = d.createCommandEncoder({ label: "ps.frame" });
    enc.clearBuffer(this.counterBuffer);
    enc.clearBuffer(this.requestBuffer);

    const wg = (n: number) => Math.max(1, Math.ceil(n / 64));
    const k = this.kernels;
    const timed = (begin: number) =>
      this.querySet ? { querySet: this.querySet, beginningOfPassWriteIndex: begin, endOfPassWriteIndex: begin + 1 } : undefined;
    // Marking gets its own pass: it waits on last frame's depth, and that wait
    // must not be billed to page management.
    if (depth && input.depth) {
      const tex = input.depth.texture;
      const mp = enc.beginComputePass({ label: "ps.mark", timestampWrites: timed(0) });
      mp.setBindGroup(0, this.computeGroup);
      mp.setPipeline(depth.pipeline);
      mp.setBindGroup(1, depth.group);
      mp.dispatchWorkgroups(Math.ceil(tex.width / this.markStride / 8), Math.ceil(tex.height / this.markStride / 8));
      mp.end();
    }
    const cp = enc.beginComputePass({ label: "ps.paging", timestampWrites: timed(2) });
    cp.setBindGroup(0, this.computeGroup);
    cp.setPipeline(k.updateSlots);
    cp.dispatchWorkgroups(wg(this.slots));
    if (regionCount > 0) {
      cp.setPipeline(k.invalidateRegions);
      cp.dispatchWorkgroups(wg(regionCount * this.levelCount));
    }
    cp.setPipeline(k.collectPhys);
    cp.dispatchWorkgroups(wg(this.pageCount));
    cp.setPipeline(k.allocate);
    cp.dispatchWorkgroups(wg(this.slots));
    cp.setPipeline(k.buildRenderList);
    cp.dispatchWorkgroups(wg(this.slots));
    cp.setPipeline(k.finalizeRenderList);
    cp.dispatchWorkgroups(1);
    cp.setPipeline(k.cullClusters);
    cp.dispatchWorkgroups(wg(this.clusterInstanceCount));
    cp.setPipeline(k.finalizeDraws);
    cp.dispatchWorkgroups(1);
    cp.end();

    const rp = enc.beginRenderPass({
      label: "ps.raster",
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.poolTexture.createView(),
        depthLoadOp: this.started ? "load" : "clear",
        depthClearValue: 1,
        depthStoreOp: "store",
      },
      timestampWrites: timed(4),
    });
    rp.setBindGroup(0, this.rasterGroup);
    const indirect = this.work.indirect * 4;
    rp.setPipeline(this.clearPipeline);
    rp.drawIndirect(this.workBuffer, indirect);
    rp.setPipeline(this.opaquePipeline);
    rp.drawIndirect(this.workBuffer, indirect + 16);
    rp.setPipeline(this.alphaPipeline);
    rp.drawIndirect(this.workBuffer, indirect + 32);
    rp.end();
    this.started = true;

    const rb = this.readbacks.find((r) => !r.busy);
    if (rb) {
      enc.copyBufferToBuffer(this.counterBuffer, 0, rb.buffer, 0, COUNTER_COUNT * 4);
      if (this.querySet && this.queryResolve) {
        enc.resolveQuerySet(this.querySet, 0, 6, this.queryResolve, 0);
        enc.copyBufferToBuffer(this.queryResolve, 0, rb.buffer, COUNTER_COUNT * 4, 48);
      }
    }
    d.queue.submit([enc.finish()]);
    if (rb) this.readStats(rb, this.frame);
  }

  // ---- internals --------------------------------------------------------------

  /**
   * Each level keeps the light basis it was last rendered with and is
   * re-rendered only when the sun has drifted past its band. Coarser levels
   * have coarser texels and so tolerate proportionally more drift. At most one
   * level refreshes per frame, so refresh cost never stacks.
   */
  private refreshLevels(dir: Vec3): void {
    let worst = -1;
    let worstRatio = 1;
    for (let l = 0; l < this.levelCount; l++) {
      const lv = this.levels[l];
      if (lv.invalidate) {
        this.setLevelBasis(l, dir);
        continue;
      }
      const angle = (Math.acos(Math.min(1, Math.max(-1, dot(lv.dir, dir)))) * 180) / Math.PI;
      const ratio = angle / (this.tuning.bandDegrees * 2 ** l);
      if (ratio >= worstRatio) {
        worstRatio = ratio;
        worst = l;
      }
    }
    if (worst >= 0) {
      this.setLevelBasis(worst, dir);
      this.levels[worst].invalidate = true;
      this.stats.levelRefreshes++;
      this.stats.lastRefreshedLevel = worst;
    }
  }

  private setLevelBasis(l: number, dir: Vec3): void {
    const lv = this.levels[l];
    const ref: Vec3 = Math.abs(dir[1]) < 0.999 ? [0, 1, 0] : [0, 0, 1];
    lv.dir = dir;
    lv.right = normalize(cross(ref, dir));
    lv.up = cross(dir, lv.right);
    const c: Vec3 = [
      (this.sceneMin[0] + this.sceneMax[0]) / 2,
      (this.sceneMin[1] + this.sceneMax[1]) / 2,
      (this.sceneMin[2] + this.sceneMax[2]) / 2,
    ];
    const r = Math.hypot(this.sceneMax[0] - c[0], this.sceneMax[1] - c[1], this.sceneMax[2] - c[2]) + 1;
    lv.zMin = dot(c, dir) - r;
    lv.zRange = 2 * r;
    lv.invalidate = true;
  }

  private writeParams(input: FrameInput): number {
    const f = new Float32Array(this.params);
    const i = new Int32Array(this.params);
    const u = new Uint32Array(this.params);
    const t = this.tuning;
    f.set([input.eye[0], input.eye[1], input.eye[2], input.pixelWorldSizeAt1m], 0);
    f.set([t.lodBias, t.normalOffset, t.depthBias, t.debugMode], 4);
    u.set([this.poolSize, this.poolSize / this.pageSize, this.pageSize, this.pageCount], 8);
    u.set([this.levelCount, this.pagesPerSide, this.frame, Math.min(t.renderBudget, this.renderBudgetMax)], 12);
    const regionCount = Math.min(MAX_REGIONS, this.regions.length / 8);
    u.set([regionCount, this.clusterInstanceCount, this.maxPairs, this.clusterCount], 16);
    if (input.depth) {
      f.set(Array.from(input.depth.invViewProj).slice(0, 16), 20);
      f.set([input.depth.texture.width, input.depth.texture.height, this.markStride, 1], 36);
    } else {
      f.set([0, 0, this.markStride, 0], 36);
    }

    const corners: Vec3[] = [];
    for (let k = 0; k < 8; k++) {
      corners.push([
        k & 1 ? this.sceneMax[0] : this.sceneMin[0],
        k & 2 ? this.sceneMax[1] : this.sceneMin[1],
        k & 4 ? this.sceneMax[2] : this.sceneMin[2],
      ]);
    }
    const half = this.pagesPerSide / 2;
    for (let l = 0; l < this.levelCount; l++) {
      const lv = this.levels[l];
      const pageWorld = this.finestPageWorldSize * 2 ** l;
      const base = LEVELS_WORD + l * 28;
      f.set([...lv.right, pageWorld], base);
      f.set([...lv.up, 1 / pageWorld], base + 4);
      f.set([...lv.dir, pageWorld / this.pageSize], base + 8);
      f.set([lv.zMin, 1 / lv.zRange, lv.zRange, 0], base + 12);
      const cx = Math.floor(dot(input.eye, lv.right) / pageWorld);
      const cy = Math.floor(dot(input.eye, lv.up) / pageWorld);
      i.set([cx - half, cy - half, 0, 0], base + 16);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of corners) {
        const x = Math.floor(dot(c, lv.right) / pageWorld);
        const y = Math.floor(dot(c, lv.up) / pageWorld);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      i.set([x0, y0, x1, y1], base + 20);
      u.set([lv.invalidate ? 1 : 0, 0, 0, 0], base + 24);
      lv.invalidate = false;
    }
    f.set(this.regions.slice(0, regionCount * 8), PARAMS_HEADER_BYTES / 4);
    this.regions.length = 0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params, 0, PARAMS_HEADER_BYTES + regionCount * 32);
    return regionCount;
  }

  private bindDepth(texture: GPUTexture): { pipeline: GPUComputePipeline; group: GPUBindGroup } {
    const ms = texture.sampleCount > 1;
    let pipeline = this.markPipelines.get(ms);
    if (!pipeline) {
      const layout = this.device.createBindGroupLayout({
        label: `ps.depthLayout${ms ? ".ms" : ""}`,
        entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth", multisampled: ms } }],
      });
      pipeline = this.device.createComputePipeline({
        label: "ps.markPages",
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.computeLayout, layout] }),
        compute: { module: this.device.createShaderModule({ label: "ps.mark", code: markWGSL(ms) }), entryPoint: "markPages" },
      });
      this.markPipelines.set(ms, pipeline);
    }
    if (this.depthBinding?.texture !== texture) {
      this.depthBinding = {
        texture,
        group: this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(1),
          entries: [{ binding: 0, resource: texture.createView({ aspect: "depth-only" }) }],
        }),
      };
    }
    return { pipeline, group: this.depthBinding.group };
  }

  private uploadDirtyInstances(): void {
    if (!this.sceneBuffer || this.dirtyInstances.size === 0) return;
    const base = this.clusterCount * 48;
    for (const inst of this.dirtyInstances) {
      const rows = new Float32Array(this.instanceMatrices.slice(inst * 12, inst * 12 + 12));
      this.device.queue.writeBuffer(this.sceneBuffer, base + inst * 48, rows);
    }
    this.dirtyInstances.clear();
  }

  private instanceBounds(inst: number): [Vec3, Vec3] {
    const g = this.geometries[this.instanceGeometry[inst]];
    const m = this.instanceMatrices.slice(inst * 12, inst * 12 + 12);
    const c: Vec3 = [0, 0, 0];
    const e: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      c[k] = (g.aabbMin[k] + g.aabbMax[k]) / 2;
      e[k] = (g.aabbMax[k] - g.aabbMin[k]) / 2;
    }
    const wc: Vec3 = [0, 0, 0];
    const we: Vec3 = [0, 0, 0];
    for (let r = 0; r < 3; r++) {
      wc[r] = m[r * 4] * c[0] + m[r * 4 + 1] * c[1] + m[r * 4 + 2] * c[2] + m[r * 4 + 3];
      we[r] = Math.abs(m[r * 4]) * e[0] + Math.abs(m[r * 4 + 1]) * e[1] + Math.abs(m[r * 4 + 2]) * e[2];
    }
    return [
      [wc[0] - we[0], wc[1] - we[1], wc[2] - we[2]],
      [wc[0] + we[0], wc[1] + we[1], wc[2] + we[2]],
    ];
  }

  private readStats(rb: { buffer: GPUBuffer; busy: boolean }, frame: number): void {
    rb.busy = true;
    rb.buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const data = rb.buffer.getMappedRange();
        const c = new Uint32Array(data, 0, COUNTER_COUNT);
        const s = this.stats;
        s.frame = frame;
        s.requestedPages = c[C_REQUESTED];
        s.residentPages = c[C_RESIDENT];
        s.renderedPages = Math.min(c[C_RENDER], this.tuning.renderBudget);
        s.deferredPages = c[C_DEFERRED];
        s.allocations = c[C_ALLOC];
        s.allocationFailures = c[C_ALLOC_FAIL];
        s.opaquePairs = c[C_OPAQUE_PAIRS];
        s.alphaPairs = c[C_ALPHA_PAIRS];
        if (this.querySet) {
          const ts = new BigUint64Array(data, COUNTER_COUNT * 4, 6);
          const ms = (a: bigint, b: bigint) => (b > a ? Number(b - a) / 1e6 : 0);
          s.gpuMarkMs = ms(ts[0], ts[1]);
          s.gpuComputeMs = ms(ts[2], ts[3]);
          s.gpuRasterMs = ms(ts[4], ts[5]);
        }
        rb.buffer.unmap();
        rb.busy = false;
      })
      .catch(() => {
        rb.busy = false;
      });
  }

  private upload(label: string, data: Float32Array | Uint32Array, usage: number): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size: Math.max(16, data.byteLength), usage, mappedAtCreation: true });
    const Ctor = data instanceof Float32Array ? Float32Array : Uint32Array;
    new Ctor(buffer.getMappedRange(0, data.byteLength)).set(data);
    buffer.unmap();
    return buffer;
  }

  private createPipelines(): void {
    const d = this.device;
    const storage = (type: GPUBufferBindingType, visibility: number) =>
      ({ buffer: { type }, visibility }) as const;
    const C = GPUShaderStage.COMPUTE;
    const types: GPUBufferBindingType[] = [
      "read-only-storage", "storage", "storage", "storage", "storage", "read-only-storage", "read-only-storage", "storage",
    ];
    this.computeLayout = d.createBindGroupLayout({
      label: "ps.computeLayout",
      entries: types.map((t, binding) => ({ binding, ...storage(t, C) })),
    });
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    this.rasterLayout = d.createBindGroupLayout({
      label: "ps.rasterLayout",
      entries: [
        ...Array.from({ length: 8 }, (_, binding) => ({ binding, ...storage("read-only-storage", V) })),
        { binding: 8, visibility: F, texture: { viewDimension: "2d-array", sampleType: "float" } },
        { binding: 9, visibility: F, sampler: { type: "filtering" } },
      ],
    });

    const kernelModule = d.createShaderModule({ label: "ps.kernels", code: kernelsWGSL(this.work, this.maxPairs) });
    const computePL = d.createPipelineLayout({ bindGroupLayouts: [this.computeLayout] });
    for (const entryPoint of [
      "updateSlots", "invalidateRegions", "collectPhys", "allocate",
      "buildRenderList", "finalizeRenderList", "cullClusters", "finalizeDraws",
    ]) {
      this.kernels[entryPoint] = d.createComputePipeline({
        label: `ps.${entryPoint}`,
        layout: computePL,
        compute: { module: kernelModule, entryPoint },
      });
    }

    const rasterModule = d.createShaderModule({
      label: "ps.raster",
      code: rasterWGSL(this.work, this.maxPairs, this.useClipDistances),
    });
    const rasterPL = d.createPipelineLayout({ bindGroupLayouts: [this.rasterLayout] });
    const depth = (compare: GPUCompareFunction, bias: boolean): GPUDepthStencilState => ({
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: compare,
      depthBias: bias ? 1 : 0,
      depthBiasSlopeScale: bias ? 1.5 : 0,
    });
    this.clearPipeline = d.createRenderPipeline({
      label: "ps.clear",
      layout: rasterPL,
      vertex: { module: rasterModule, entryPoint: "clearVS" },
      primitive: { topology: "triangle-list" },
      depthStencil: depth("always", false),
    });
    this.opaquePipeline = d.createRenderPipeline({
      label: "ps.opaque",
      layout: rasterPL,
      vertex: { module: rasterModule, entryPoint: "opaqueVS" },
      fragment: this.useClipDistances ? undefined : { module: rasterModule, entryPoint: "opaqueFS", targets: [] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depth("less", true),
    });
    this.alphaPipeline = d.createRenderPipeline({
      label: "ps.alpha",
      layout: rasterPL,
      vertex: { module: rasterModule, entryPoint: "alphaVS" },
      fragment: { module: rasterModule, entryPoint: "alphaFS", targets: [] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depth("less", true),
    });
  }
}

function affineRows(m: Float32Array | number[], o: number): number[] {
  return [
    m[o], m[o + 4], m[o + 8], m[o + 12],
    m[o + 1], m[o + 5], m[o + 9], m[o + 13],
    m[o + 2], m[o + 6], m[o + 10], m[o + 14],
  ];
}

function concatF32(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function concatU32(parts: Uint32Array[]): Uint32Array {
  const out = new Uint32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
