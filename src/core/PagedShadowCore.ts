import { buildGeometry, type BuiltGeometry, type GeometryInput } from "./geometry";
import {
  C_ALLOC,
  C_ALLOC_FAIL,
  C_ALPHA_PAIRS,
  C_DEFERRED,
  C_DYN_ALPHA_PAIRS,
  C_DYN_DEFERRED,
  C_DYN_OPAQUE_PAIRS,
  C_DYN_PAGES,
  C_OPAQUE_PAIRS,
  C_RENDER,
  C_REQUESTED,
  C_RESIDENT,
  COUNTER_COUNT,
  COUNTER_WORDS,
  kernelsWGSL,
  markWGSL,
  workLayout,
  type WorkLayout,
} from "./kernels";
import { minMaxWGSL } from "./minmax";
import { writeSkinRows } from "./skin";
import { rasterWGSL } from "./raster";
import { LEVELS_WORD, MAX_LEVELS, MAX_REGIONS, MINMAX_TILE, PARAMS_BYTES, PARAMS_HEADER_BYTES, SHADE_WORD } from "./wgsl";

// Sundial: a paged, cached shadow clipmap for one directional light.
//
// Frame flow, all on the GPU after one small params upload:
//   mark (last frame's camera depth) -> update/retag -> invalidate -> allocate
//   -> render list -> cluster x page cull -> one clear draw + two caster draws
// The CPU never learns which pages are resident; it only decides when a level's
// light basis has drifted far enough to be re-rendered.
//
// With the static cache (the default), static casters render into a second
// pool, staticPool, and the pool receivers read is composed per page: the
// page's static depth copied in, then the dynamic casters drawn over it. A
// moving dynamic caster only marks the pages it crossed stale; those are
// re-composed from staticPool (a quad per page) and get the few dynamic
// casters redrawn, instead of re-rendering every static caster on them:
//   ... -> mark stale -> invalidate -> allocate -> static list -> dynamic list
//   -> dynamic cull -> static cull
//   -> [staticPool] clear + static casters -> [pool] composite + dynamic casters

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
  /**
   * Keep each page's static-only depth in a second pool (default true), so
   * that dynamic casters (addInstances(..., dynamic = true)) moving re-draw
   * only themselves over a copy of it, not every static caster on the pages
   * they cross. Costs a second pool texture (poolSize² × 4 bytes: 64 MiB at
   * 4096). false: one pool, and a moving dynamic caster re-renders every page
   * its old and new bounds touch, as a static edit does.
   */
  staticCache?: boolean;
  /**
   * With the static cache: most pages re-composed for dynamic casters in one
   * frame (default 64); the rest fall back a level for a frame.
   */
  dynamicBudget?: number;
  /** Capacity of each (cluster, page) pair list. */
  maxPairs?: number;
  /** Triangles per cluster. */
  clusterTris?: number;
  alphaTextureSize?: number;
  maxAlphaLayers?: number;
  /**
   * Clip triangles to their page with the `clip-distances` feature (default:
   * when the device has it). false forces the fragment-discard fallback, which
   * is what runs on a device created without that feature.
   */
  clipDistances?: boolean;
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
  /** Static page renders per frame (every page, without the static cache). */
  renderBudget: number;
  /** Static cache only: pages re-composed for dynamic casters per frame. */
  dynamicBudget: number;
  /**
   * Light left in full shadow: 0 = black, 1 = no visible shadow. Same meaning
   * as Babylon's ShadowGenerator.setDarkness, so a host can feed it the value
   * it already computes (fill, dusk fade).
   */
  darkness: number;
  /**
   * Receivers skip PCF where the per-page min/max depth atlas shows the whole
   * filter footprint lit or shadowed (identical output, fewer texel loads).
   * false stops building the atlas too; turning it back on re-renders every
   * page so the atlas is complete again. For A/B measurement.
   */
  minMaxEarlyOut: boolean;
}

export interface Stats {
  /** The frame the counters below were read back from (every `statsInterval` frames unless profiling). */
  frame: number;
  requestedPages: number;
  residentPages: number;
  /** Pages rendered from scratch this frame: with the static cache, the static casters into staticPool. */
  renderedPages: number;
  /** Pages the render budget pushed to a later frame. */
  deferredPages: number;
  /**
   * Static cache: pages re-composed for dynamic casters only (their static
   * depth copied back, the dynamic casters redrawn), and the ones
   * dynamicBudget pushed to a later frame. 0 without the cache.
   */
  dynamicPages: number;
  dynamicDeferred: number;
  /** Static cache: pages composited into the live pool (renderedPages + dynamicPages). 0 without the cache. */
  compositedPages: number;
  /** Static cache: (dynamic cluster, page) pairs drawn, opaque and alpha together. */
  dynamicPairs: number;
  allocations: number;
  allocationFailures: number;
  opaquePairs: number;
  alphaPairs: number;
  /**
   * (cluster, page) pairs that did not fit in the pair lists (maxPairs each).
   * The pages that lost them are not kept: they fall back a level and are
   * rendered again the next frame. Non-zero every frame means maxPairs is too
   * small for the scene.
   */
  droppedPairs: number;
  /**
   * GPU time in ms of page marking, page management and page raster, while
   * `PagedShadowCore.profiling` is on; null while it is off, and without
   * timestamp-query. Marking includes any wait for the previous frame's
   * depth, so it is an upper bound.
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
  /**
   * Instance rows each instance occupies: 1, or for skinned geometry 1 + its
   * bone count (the bounds row, then one row per bone). Absent means 1.
   */
  readonly rowsPerInstance?: number;
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

// GPUBufferUsage values from the WebGPU spec, as literals: reading the
// GPUBufferUsage global at module load would throw in any browser without
// WebGPU, and World imports this package on every backend.
const STORAGE = 0x0080;
const COPY_DST = 0x0008;
const COPY_SRC = 0x0004;

/** Builds an unused geometry stays cached for: content back within this many rebuilds is not re-clustered. */
const CACHE_GRACE_BUILDS = 4;

/** Darkness at or above which shadows are invisible: receivers skip the lookup and the core stops working. Mirrored in RECEIVER_WGSL. */
export const INVISIBLE_DARKNESS = 0.999;

/** Dirty instances at most this many apart are uploaded in one write (the clean rows between re-sent). */
const UPLOAD_GAP = 16;
const ascending = (a: number, b: number) => a - b;

/** The depth range covers the scene's bounding sphere times this (plus 16 m), so growing content rarely escapes it. */
const DEPTH_HEADROOM = 1.25;

function boundingSphere(min: Vec3, max: Vec3): [Vec3, number] {
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return [c, Math.hypot(max[0] - c[0], max[1] - c[1], max[2] - c[2])];
}

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
  /** Static casters are cached in staticPool (see PagedShadowOptions.staticCache). */
  readonly staticCache: boolean;

  readonly tuning: Tuning = {
    lodBias: 0,
    normalOffset: 1.5,
    depthBias: 1.5,
    debugMode: 0,
    bandDegrees: 0.05,
    renderBudget: 96,
    dynamicBudget: 64,
    darkness: 0,
    minMaxEarlyOut: true,
  };

  /** Resources receivers bind (params, page table, pool). */
  readonly paramsBuffer: GPUBuffer;
  readonly pageTableBuffer: GPUBuffer;
  readonly requestBuffer: GPUBuffer;
  readonly poolTexture: GPUTexture;
  /**
   * Per-page min/max depth over the pool (see minmax.ts), rg32uint holding f32
   * bits at 1/MINMAX_TILE of the pool's resolution. Receivers bind it next to
   * the pool; it is 1x1 and unused when the page size is not a multiple of
   * MINMAX_TILE.
   */
  readonly minMaxTexture: GPUTexture;

  stats: Stats = {
    frame: 0, requestedPages: 0, residentPages: 0, renderedPages: 0, deferredPages: 0,
    dynamicPages: 0, dynamicDeferred: 0, compositedPages: 0, dynamicPairs: 0, allocations: 0,
    allocationFailures: 0, opaquePairs: 0, alphaPairs: 0, droppedPairs: 0, gpuMarkMs: null, gpuComputeMs: null, gpuRasterMs: null,
    levelRefreshes: 0, lastRefreshedLevel: -1,
  };

  private sceneMin: Vec3;
  private sceneMax: Vec3;
  /**
   * The sphere every level's depth range is fitted to: the scene bounds with
   * headroom, so content streaming in (which grows the bounds a little at a
   * time) does not re-render every page. 32-bit depth over the padded range
   * still resolves far below a texel.
   */
  private depthCentre: Vec3 = [0, 0, 0];
  private depthRadius = 0;
  private readonly renderBudgetMax: number;
  /** Most dynamic-list entries (0 without the static cache): the render list holds both lists. */
  private readonly dynamicBudgetMax: number;
  /** Static-only depth of every page, laid out as the pool; null without the static cache. */
  private readonly staticPool: GPUTexture | null = null;
  private readonly staticView: GPUTextureView | null = null;
  /** The composite's staticPool binding (group 1 of the live-pool pass). */
  private compositeGroup: GPUBindGroup | null = null;
  private compositePipeline: GPURenderPipeline | null = null;
  private opaqueDynamicPipeline: GPURenderPipeline | null = null;
  private alphaDynamicPipeline: GPURenderPipeline | null = null;
  /**
   * The first dynamic cluster instance: with the static cache, build() puts
   * the cluster instances of dynamic groups last. Equal to the cluster
   * instance count without the cache or without dynamic casters.
   */
  private dynamicFirst = 0;
  private readonly slots: number;
  private readonly work: WorkLayout;
  private readonly workBuffer: GPUBuffer;
  private readonly counterBuffer: GPUBuffer;
  private readonly pairBuffer: GPUBuffer;
  /** The cull's indirect dispatch args, copied out of the work buffer (see WorkLayout.dispatch). */
  private readonly dispatchBuffer: GPUBuffer;
  private readonly alphaTexture: GPUTexture;
  /** Texels per side of each alpha layer. */
  readonly alphaSize: number;
  readonly alphaLayerCount: number;
  private readonly alphaSampler: GPUSampler;
  /** The page size allows a min/max atlas at all. */
  private readonly minMaxSupported: boolean;
  /**
   * The atlas matches the pool for every valid page. True from the start (no
   * page is valid yet); false while tuning.minMaxEarlyOut is off, since pages
   * rendered then get no min/max.
   */
  private minMaxLive = true;
  private minMaxPipeline!: GPUComputePipeline;
  private minMaxGroup!: GPUBindGroup;
  private readonly params = new ArrayBuffer(PARAMS_BYTES);
  // Persistent views of `params` and of the mark block: writeParams and
  // markInto run every frame and must not allocate (a GC pause is a hitch).
  private readonly paramsF32 = new Float32Array(this.params);
  private readonly paramsI32 = new Int32Array(this.params);
  private readonly paramsU32 = new Uint32Array(this.params);
  private readonly markBlock = new Float32Array(20);
  private readonly levels: LevelState[] = [];

  private geometries: BuiltGeometry[] = [];
  /**
   * Clustered geometry by caller key, kept across rebuilds. An entry the last
   * builds did not use survives CACHE_GRACE_BUILDS more of them: content that
   * drops out for one rebuild (hidden while it loads, culled, re-created) comes
   * back without being clustered again, which is a first build's whole cost.
   */
  private geometryCache = new Map<string, { geometry: BuiltGeometry; lastBuild: number }>();
  private buildCount = 0;
  /** Keys registered since the last clearContent(), and the geometry index each got. */
  private geometryKeys = new Map<string, number>();
  private cacheHits = 0;
  /** Each registered geometry's key, in order (null = registered without one). */
  private geometryKeyOrder: (string | null)[] = [];
  /**
   * The packed geometry of the last build: vertex and index buffers, and the
   * cluster half of the scene buffer. Reused as-is while the ordered geometry
   * keys are unchanged, so a rebuild that only moves, adds or drops instances
   * re-packs nothing.
   */
  private packed: {
    keys: string;
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    clusterVec: Float32Array;
    geomClusterStart: number[];
    clusterCount: number;
  } | null = null;
  /**
   * The previous content, snapshot by clearContent() while it was live: each
   * instance's signature (geometry key + matrix) with its world bounds. The next
   * build() re-renders only the pages under instances that appeared or went.
   */
  private previousInstances: InstanceSnapshot | null = null;
  /**
   * What the last build() did, for hosts to report. `internal`: the build was
   * the adapter's own (an alpha mask arriving, addCaster after start), not a
   * host call, so a host's rebuild log would not show it.
   */
  lastBuild = { reusedGeometry: false, invalidated: "all" as "all" | number, internal: false };
  /** Builds so far, and how many of them were internal (see lastBuild.internal). */
  private builds = 0;
  private internalBuilds = 0;
  /** True while shadows are fully faded and update() is skipping all GPU work. */
  dormant = false;
  private groups: InstanceGroup[] = [];
  /**
   * 12 floats (3 affine rows) per instance, for instanceGeometry.length
   * instances; grown by doubling. A typed array, not number[] grown with
   * push(...rows): that spread allocated an array per instance, and the scene
   * upload copies these floats as they are.
   */
  private instanceMatrices = new Float32Array(12 * 256);
  private instanceGeometry: number[] = [];
  private regions: number[] = [];
  /**
   * Static cache: the old and new bounds of dynamic instances that moved.
   * They mark pages stale (re-composed, dynamic casters redrawn), not invalid.
   * Uploaded after `regions`; each list gets half of MAX_REGIONS.
   */
  private dynamicRegions: number[] = [];
  /** Dynamic regions uploaded by this frame's writeParams. */
  private frameDynamicRegions = 0;
  private dirtyInstances = new Set<number>();
  /** Scratch for uploadDirtyInstances: the dirty instances in order, and their rows as f32. */
  private readonly dirtyOrder: number[] = [];
  private uploadRows = new Float32Array(0);
  /** Scratch world boxes (min xyz, max xyz) for setInstanceMatrix. */
  private readonly boxBefore = new Float64Array(6);
  private readonly boxAfter = new Float64Array(6);

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
  /**
   * Rotate each marking sample through its markStride x markStride cell, one
   * pixel per frame, so a sparser stride (3 or 4, cheaper on integrated GPUs)
   * still reaches every pixel over a few frames. Pages stay resident between
   * requests, but a page seen only by a few pixels may be requested only every
   * few frames, and an invalidated page is re-rendered only on a frame that
   * requests it (a coarser level stands in until then).
   */
  markRotate = false;

  /**
   * GPU pass timing. Off by default: with it on, every pass writes timestamps
   * and every frame resolves them and maps a readback buffer, which is real
   * per-frame work (a query resolve, a copy, a mapAsync and its promise) that
   * only a profiler wants. While off, the page counters are still read back,
   * every `statsInterval` frames, and the GPU ms fields of `stats` are null.
   * Turn it on to measure (a host's status panel, the benchmark lab); it takes
   * effect on the next frame.
   */
  profiling = false;
  /** Frames between stats readbacks while not profiling (profiling reads every frame). */
  statsInterval = 10;

  private querySet: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  /** Timestamp writes for the mark, paging and raster passes, built once. */
  private passTimestamps: GPUComputePassTimestampWrites[] = [];
  private readbacks: { buffer: GPUBuffer; busy: boolean; timed: boolean }[] = [];
  /** The pool's depth view, made once: the raster pass renders into it every frame. */
  private readonly poolView: GPUTextureView;
  private frame = 0;
  private started = false;

  constructor(device: GPUDevice, options: PagedShadowOptions) {
    this.device = device;
    this.sceneMin = options.sceneMin;
    this.sceneMax = options.sceneMax;
    this.fitDepth();
    this.levelCount = Math.min(MAX_LEVELS, options.levels ?? 7);
    this.pagesPerSide = options.pagesPerSide ?? 16;
    this.pageSize = options.pageSize ?? 128;
    this.poolSize = options.poolSize ?? 4096;
    this.pageCount = (this.poolSize / this.pageSize) ** 2;
    this.finestPageWorldSize = options.finestPageWorldSize ?? 1;
    this.clusterTris = options.clusterTris ?? 64;
    this.maxPairs = options.maxPairs ?? 1 << 19;
    this.renderBudgetMax = 1024;
    this.staticCache = options.staticCache !== false;
    this.dynamicBudgetMax = this.staticCache ? 1024 : 0;
    this.tuning.renderBudget = options.renderBudget ?? this.tuning.renderBudget;
    this.tuning.dynamicBudget = options.dynamicBudget ?? this.tuning.dynamicBudget;
    this.slots = this.levelCount * this.pagesPerSide * this.pagesPerSide;
    this.work = workLayout(this.slots, this.pageCount, this.renderBudgetMax + this.dynamicBudgetMax);
    this.useClipDistances = device.features.has("clip-distances") && options.clipDistances !== false;
    this.hasTimestamps = device.features.has("timestamp-query");

    // COPY_SRC on the two buffers receivers read, so a host can inspect them (diagnostics).
    this.paramsBuffer = device.createBuffer({ label: "ps.params", size: PARAMS_BYTES, usage: STORAGE | COPY_DST | COPY_SRC });
    this.pageTableBuffer = device.createBuffer({ label: "ps.pageTable", size: this.slots * 8, usage: STORAGE | COPY_DST | COPY_SRC });
    this.requestBuffer = device.createBuffer({ label: "ps.requests", size: this.slots * 4, usage: STORAGE | COPY_DST });
    this.counterBuffer = device.createBuffer({ label: "ps.counters", size: COUNTER_WORDS * 4, usage: STORAGE | COPY_DST | COPY_SRC });
    this.workBuffer = device.createBuffer({
      label: "ps.work",
      size: this.work.total * 4,
      usage: STORAGE | COPY_DST | COPY_SRC | GPUBufferUsage.INDIRECT,
    });
    this.dispatchBuffer = device.createBuffer({ label: "ps.dispatch", size: 16, usage: GPUBufferUsage.INDIRECT | COPY_DST });
    this.pairBuffer = device.createBuffer({ label: "ps.pairs", size: this.maxPairs * 2 * 8, usage: STORAGE });
    this.poolTexture = device.createTexture({
      label: "ps.pool",
      size: [this.poolSize, this.poolSize],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.poolView = this.poolTexture.createView();
    if (this.staticCache) {
      this.staticPool = device.createTexture({
        label: "ps.staticPool",
        size: [this.poolSize, this.poolSize],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.staticView = this.staticPool.createView();
    }
    this.minMaxSupported = this.pageSize % MINMAX_TILE === 0;
    const mm = this.minMaxSupported ? this.poolSize / MINMAX_TILE : 1;
    this.minMaxTexture = device.createTexture({
      label: "ps.minMax",
      size: [mm, mm],
      format: "rg32uint",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.alphaSize = options.alphaTextureSize ?? 256;
    const alphaLayers = (this.alphaLayerCount = options.maxAlphaLayers ?? 4);
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

    // Draw-arg constants that never change: vertex counts and zero offsets
    // (see WorkLayout.indirect for the six draws).
    const ind = new Uint32Array(24);
    ind[0] = ind[12] = 6;
    ind[4] = ind[8] = ind[16] = ind[20] = this.clusterTris * 3;
    device.queue.writeBuffer(this.workBuffer, this.work.indirect * 4, ind);

    if (this.hasTimestamps) {
      this.querySet = device.createQuerySet({ type: "timestamp", count: 6 });
      this.queryResolve = device.createBuffer({ size: 48, usage: GPUBufferUsage.QUERY_RESOLVE | COPY_SRC });
      // Mark, paging, raster, and the end of the cull pass: paging spans two
      // passes (see update), so it starts in one and ends in the other. With
      // the static cache the raster is two passes too (the start of the
      // static one, the end of the live one).
      const q = this.querySet;
      this.passTimestamps.push(
        { querySet: q, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
        { querySet: q, beginningOfPassWriteIndex: 2 },
        { querySet: q, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 },
        { querySet: q, endOfPassWriteIndex: 3 },
        { querySet: q, beginningOfPassWriteIndex: 4 },
        { querySet: q, endOfPassWriteIndex: 5 },
      );
    }
    for (let i = 0; i < 3; i++) {
      this.readbacks.push({
        buffer: device.createBuffer({ size: COUNTER_COUNT * 4 + 48, usage: GPUBufferUsage.MAP_READ | COPY_DST }),
        busy: false,
        timed: false,
      });
    }

    for (let l = 0; l < this.levelCount; l++) {
      this.levels.push({ dir: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1], zMin: 0, zRange: 1, invalidate: true });
    }
    this.createPipelines();
  }

  // ---- content ------------------------------------------------------------

  /**
   * Register a geometry. With a `key`, geometry registered again under the
   * same key reuses its clusters: within one build it is the same geometry
   * (instances share it), and across rebuilds the clustering is not redone.
   * The key must change whenever the input does. `input` may be a function:
   * it is then called only when the key is not cached, so a host can skip
   * preparing geometry that will not be used.
   */
  /**
   * Whether geometry registered under `key` would reuse clusters (registered
   * since clearContent(), or still cached) instead of calling its input. A
   * host that skips preparing an input for a known key must check this: a key
   * unused for CACHE_GRACE_BUILDS builds is evicted.
   */
  hasGeometry(key: string): boolean {
    return this.geometryKeys.has(key) || this.geometryCache.has(key);
  }

  addGeometry(input: GeometryInput | (() => GeometryInput), key?: string): number {
    const resolve = () => (typeof input === "function" ? input() : input);
    if (key !== undefined) {
      const known = this.geometryKeys.get(key);
      if (known !== undefined) return known;
      let built = this.geometryCache.get(key)?.geometry;
      if (built) this.cacheHits++;
      else {
        built = buildGeometry(resolve(), this.clusterTris);
        this.geometryCache.set(key, { geometry: built, lastBuild: this.buildCount });
      }
      this.geometries.push(built);
      this.geometryKeyOrder.push(key);
      this.geometryKeys.set(key, this.geometries.length - 1);
      return this.geometries.length - 1;
    }
    this.geometries.push(buildGeometry(resolve(), this.clusterTris));
    this.geometryKeyOrder.push(null);
    return this.geometries.length - 1;
  }

  /**
   * Forget every registered geometry and instance, ready to register the
   * content again and build(). Clustered geometry stays cached by key.
   */
  clearContent(): void {
    // Only live content can be diffed against: before the first build there are
    // no cached pages to spare, and an unkeyed geometry has no stable identity.
    this.previousInstances =
      this.started && this.sceneBuffer && !this.geometryKeyOrder.includes(null) ? this.instanceSignatures() : null;
    this.geometries = [];
    this.geometryKeyOrder = [];
    this.geometryKeys.clear();
    this.cacheHits = 0;
    this.groups = [];
    // Fresh arrays, not cleared ones: the snapshot above still reads the old ones.
    this.instanceMatrices = new Float32Array(this.instanceMatrices.length);
    this.instanceGeometry = [];
    this.dirtyInstances.clear();
  }

  /** `matrices` holds 16 floats per instance, column-major with translation at 12..14 (Babylon and three.js layout). */
  addInstances(geometry: number, matrices: Float32Array | number[], dynamic = false): InstanceGroup {
    if (this.geometries[geometry]?.skin) return this.addSkinnedInstances(geometry, matrices, dynamic);
    const count = matrices.length / 16;
    const first = this.instanceGeometry.length;
    const group: InstanceGroup = { geometry, first, count, dynamic };
    const need = (first + count) * 12;
    if (need > this.instanceMatrices.length) {
      const grown = new Float32Array(Math.max(need, this.instanceMatrices.length * 2));
      grown.set(this.instanceMatrices.subarray(0, first * 12));
      this.instanceMatrices = grown;
    }
    for (let i = 0; i < count; i++) {
      writeAffineRows(this.instanceMatrices, (first + i) * 12, matrices, i * 16);
      this.instanceGeometry.push(geometry);
    }
    this.groups.push(group);
    return group;
  }

  /**
   * Move one instance. Its old and new footprints are re-rendered next frame.
   * `offset` is where the 16 floats start in `matrix`, so a host tracking many
   * instances in one array passes it without slicing. Dynamic casters call
   * this for every instance that moved, every frame: it allocates nothing.
   */
  setInstanceMatrix(group: InstanceGroup, index: number, matrix: Float32Array | number[], offset = 0): void {
    if (group.rowsPerInstance && group.rowsPerInstance > 1) {
      this.setSkinPose(group, index, matrix, offset, null, 0);
      return;
    }
    const inst = group.first + index;
    const before = this.boxBefore;
    const after = this.boxAfter;
    const hadBefore = this.instanceBoundsInto(inst, before);
    const m = this.instanceMatrices;
    const o = inst * 12;
    // affineRows, in place: 3 rows of a column-major 4x4.
    m[o] = matrix[offset]; m[o + 1] = matrix[offset + 4]; m[o + 2] = matrix[offset + 8]; m[o + 3] = matrix[offset + 12];
    m[o + 4] = matrix[offset + 1]; m[o + 5] = matrix[offset + 5]; m[o + 6] = matrix[offset + 9]; m[o + 7] = matrix[offset + 13];
    m[o + 8] = matrix[offset + 2]; m[o + 9] = matrix[offset + 6]; m[o + 10] = matrix[offset + 10]; m[o + 11] = matrix[offset + 14];
    const hasAfter = this.instanceBoundsInto(inst, after);
    // A collapsed (zero-scale) instance casts nothing and has no footprint. Its
    // translation is meaningless (usually the origin), so it must not stretch
    // the box: an instance going away or coming back re-renders only where it
    // was or will be, not everything between it and the world origin.
    if (hadBefore && hasAfter) {
      for (let k = 0; k < 3; k++) {
        before[k] = Math.min(before[k], after[k]);
        before[k + 3] = Math.max(before[k + 3], after[k + 3]);
      }
    }
    const box = hadBefore ? before : hasAfter ? after : null;
    if (box) {
      // With the static cache a dynamic caster's motion leaves the static
      // depth under it good: its pages are re-composed, not re-rendered.
      if (group.dynamic && this.staticCache) {
        this.queueRegion(this.dynamicRegions, MAX_REGIONS / 2, box[0], box[1], box[2], box[3], box[4], box[5]);
      } else this.invalidateRange(box[0], box[1], box[2], box[3], box[4], box[5]);
    }
    this.dirtyInstances.add(inst);
  }

  /**
   * Skinned geometry: every instance takes 1 + boneCount rows (the bounds row,
   * then its bones; see skin.ts), initially in the bind pose. Bone rows carry
   * geometry -1: no cluster instances, no signature, no bounds of their own.
   */
  private addSkinnedInstances(geometry: number, matrices: Float32Array | number[], dynamic: boolean): InstanceGroup {
    const skin = this.geometries[geometry].skin!;
    const rows = 1 + skin.boneCount;
    const count = matrices.length / 16;
    const first = this.instanceGeometry.length;
    const group: InstanceGroup = { geometry, first, count, dynamic, rowsPerInstance: rows };
    const need = (first + count * rows) * 12;
    if (need > this.instanceMatrices.length) {
      const grown = new Float32Array(Math.max(need, this.instanceMatrices.length * 2));
      grown.set(this.instanceMatrices.subarray(0, first * 12));
      this.instanceMatrices = grown;
    }
    for (let i = 0; i < count; i++) {
      writeSkinRows(this.instanceMatrices, (first + i * rows) * 12, skin, matrices, i * 16, null, 0);
      this.instanceGeometry.push(geometry);
      for (let b = 1; b < rows; b++) this.instanceGeometry.push(-1);
    }
    this.groups.push(group);
    return group;
  }

  /**
   * Pose one instance of a skinned group: its world matrix (16 floats at
   * `offset`) and its bones' skinning matrices (16 floats each, boneCount of
   * them from `bonesOffset`, bind-pose mesh space to posed mesh space: what
   * Babylon's skeleton.getTransformMatrices returns). `bones` null is the bind
   * pose. The old and new pose boxes are re-rendered next frame, like a move.
   * Called per frame per animated instance: it allocates nothing.
   */
  setSkinPose(
    group: InstanceGroup,
    index: number,
    matrix: Float32Array | number[],
    offset: number,
    bones: Float32Array | number[] | null,
    bonesOffset = 0,
  ): void {
    const skin = this.geometries[group.geometry].skin;
    if (!skin || !group.rowsPerInstance) throw new Error("Sundial: setSkinPose needs a skinned instance group");
    const inst = group.first + index * group.rowsPerInstance;
    const before = this.boxBefore;
    const after = this.boxAfter;
    const hadBefore = this.instanceBoundsInto(inst, before);
    writeSkinRows(this.instanceMatrices, inst * 12, skin, matrix, offset, bones, bonesOffset);
    const hasAfter = this.instanceBoundsInto(inst, after);
    if (hadBefore && hasAfter) {
      for (let k = 0; k < 3; k++) {
        before[k] = Math.min(before[k], after[k]);
        before[k + 3] = Math.max(before[k + 3], after[k + 3]);
      }
    }
    const box = hadBefore ? before : hasAfter ? after : null;
    if (box) {
      // As setInstanceMatrix: with the static cache, a dynamic skinned caster
      // only re-composes the pages it crossed.
      if (group.dynamic && this.staticCache) {
        this.queueRegion(this.dynamicRegions, MAX_REGIONS / 2, box[0], box[1], box[2], box[3], box[4], box[5]);
      } else this.invalidateRange(box[0], box[1], box[2], box[3], box[4], box[5]);
    }
    for (let r = 0; r < group.rowsPerInstance; r++) this.dirtyInstances.add(inst + r);
  }

  /** Re-render every cached page whose light-space footprint meets this world box. */
  invalidateBox(min: Vec3, max: Vec3): void {
    this.invalidateRange(min[0], min[1], min[2], max[0], max[1], max[2]);
  }

  /** invalidateBox on six numbers, so per-frame callers need no arrays. */
  private invalidateRange(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    // With the static cache the dynamic regions get the other half of the params' region array.
    this.queueRegion(this.regions, this.staticCache ? MAX_REGIONS / 2 : MAX_REGIONS, x0, y0, z0, x1, y1, z1);
  }

  /** Queue a world box on a region list of at most `cap` boxes. */
  private queueRegion(r: number[], cap: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const n = r.length / 8;
    if (n >= cap) {
      // Full: grow the queued box this one enlarges least, instead of
      // re-rendering every page. Many movers in one frame are usually close
      // together (a linkset, a vehicle), so the merged boxes stay local.
      let best = 0;
      let bestGrowth = Infinity;
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        // Sum of extents, not volume: flat boxes (a floor, a wall) have none.
        const before = r[o + 4] - r[o] + (r[o + 5] - r[o + 1]) + (r[o + 6] - r[o + 2]);
        const after =
          Math.max(r[o + 4], x1) - Math.min(r[o], x0) +
          (Math.max(r[o + 5], y1) - Math.min(r[o + 1], y0)) +
          (Math.max(r[o + 6], z1) - Math.min(r[o + 2], z0));
        if (after - before < bestGrowth) {
          bestGrowth = after - before;
          best = o;
        }
      }
      r[best] = Math.min(r[best], x0);
      r[best + 1] = Math.min(r[best + 1], y0);
      r[best + 2] = Math.min(r[best + 2], z0);
      r[best + 4] = Math.max(r[best + 4], x1);
      r[best + 5] = Math.max(r[best + 5], y1);
      r[best + 6] = Math.max(r[best + 6], z1);
      return;
    }
    r.push(x0, y0, z0, 0, x1, y1, z1, 0);
  }

  invalidateAll(): void {
    for (const lv of this.levels) lv.invalidate = true;
  }

  /**
   * Change the world bounds of everything that casts or receives (a region
   * or sim change). Every level is re-fitted and re-rendered.
   */
  setSceneBounds(min: Vec3, max: Vec3): void {
    this.sceneMin = [...min];
    this.sceneMax = [...max];
    // The coarsest level's resident rect follows the bounds every frame on its
    // own. Only content escaping the depth range needs new bases, and those
    // re-render everything.
    const [c, r] = boundingSphere(this.sceneMin, this.sceneMax);
    const d = Math.hypot(c[0] - this.depthCentre[0], c[1] - this.depthCentre[1], c[2] - this.depthCentre[2]);
    if (d + r > this.depthRadius) {
      this.fitDepth();
      this.invalidateAll();
    }
  }

  private fitDepth(): void {
    const [c, r] = boundingSphere(this.sceneMin, this.sceneMax);
    this.depthCentre = c;
    this.depthRadius = r * DEPTH_HEADROOM + 16;
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

  /**
   * Pack all registered content into GPU buffers. Call after adding content;
   * call again after clearContent() and re-registering to replace it. A rebuild
   * reuses the packed geometry when the ordered geometry keys are unchanged,
   * and re-renders only the pages under instances that appeared, went or moved
   * (every page when that cannot be told, or when too much changed).
   */
  build(options: { internal?: boolean } = {}): void {
    const internal = !!options.internal;
    this.builds++;
    if (internal) this.internalBuilds++;
    const keys = this.geometryKeyOrder.includes(null) ? null : this.geometryKeyOrder.join("\n");
    const reuse = keys !== null && this.packed?.keys === keys;
    this.destroyContentBuffers(reuse);
    this.buildCount++;
    for (const [key, entry] of this.geometryCache) {
      if (this.geometryKeys.has(key)) entry.lastBuild = this.buildCount;
      else if (this.buildCount - entry.lastBuild > CACHE_GRACE_BUILDS) this.geometryCache.delete(key);
    }

    if (!reuse) {
      // Each geometry's vertices are interleaved and its indices are local, so
      // packing is one copy per geometry straight into the mapped buffers; the
      // cluster record carries the geometry's vertex base for the vertex stage.
      let vertexFloats = 0;
      let indexCount = 0;
      let clusterCount = 0;
      for (const geo of this.geometries) {
        vertexFloats += geo.vertices.length;
        indexCount += geo.indices.length;
        clusterCount += geo.clusters.length;
      }
      // Skin words ride after all indices (see skin.ts): the raster stage has no free storage binding.
      let skinWords = 0;
      for (const geo of this.geometries) if (geo.skin) skinWords += geo.skin.words.length;
      const indexWords = indexCount;
      indexCount += skinWords;
      const d = this.device;
      const vertexBuffer = d.createBuffer({ label: "ps.vertices", size: Math.max(16, vertexFloats * 4), usage: STORAGE, mappedAtCreation: true });
      const indexBuffer = d.createBuffer({ label: "ps.indices", size: Math.max(16, indexCount * 4), usage: STORAGE, mappedAtCreation: true });
      const vertexView = new Float32Array(vertexBuffer.getMappedRange(0, vertexFloats * 4));
      const indexView = new Uint32Array(indexBuffer.getMappedRange(0, indexCount * 4));
      const geomClusterStart: number[] = [];
      const clusterVec = new Float32Array(clusterCount * 12);
      const clusterU = new Uint32Array(clusterVec.buffer);
      let vertexBase = 0;
      let indexBase = 0;
      let skinBase = indexWords;
      let c = 0;
      for (const geo of this.geometries) {
        // Cluster word 11 (c.w): 0 for rigid geometry, else skin base + 1, bit 31 set for 8 influences.
        let skinWord = 0;
        if (geo.skin) {
          indexView.set(geo.skin.words, skinBase);
          skinWord = ((skinBase + 1) | (geo.skin.stride === 6 ? 0x80000000 : 0)) >>> 0;
          skinBase += geo.skin.words.length;
        }
        vertexView.set(geo.vertices, vertexBase * 5);
        indexView.set(geo.indices, indexBase);
        geomClusterStart.push(c);
        for (const cl of geo.clusters) {
          const o = c * 12;
          clusterVec.set(cl.aabbMin, o);
          clusterU[o + 3] = cl.firstIndex + indexBase;
          clusterVec.set(cl.aabbMax, o + 4);
          clusterU[o + 7] = cl.triCount;
          clusterU[o + 8] = cl.alphaLayer;
          clusterVec[o + 9] = cl.alphaCutoff;
          clusterU[o + 10] = vertexBase;
          clusterU[o + 11] = skinWord;
          c++;
        }
        vertexBase += geo.vertexCount;
        indexBase += geo.indices.length;
      }
      vertexBuffer.unmap();
      indexBuffer.unmap();
      // Unkeyed geometry has no identity to compare next time: a key no rebuild can match.
      this.packed = { keys: keys ?? "\u0000unkeyed", vertexBuffer, indexBuffer, clusterVec, geomClusterStart, clusterCount };
    }
    const { clusterVec, geomClusterStart, clusterCount, vertexBuffer, indexBuffer } = this.packed!;
    this.clusterCount = clusterCount;
    this.vertexBuffer = vertexBuffer;
    this.indexBuffer = indexBuffer;

    // Cluster instances: every cluster of an instance's geometry. With the
    // static cache, dynamic groups' come last, so the static and dynamic culls
    // each run over a contiguous range.
    let pairs = 0;
    for (let inst = 0; inst < this.instanceGeometry.length; inst++) {
      const g = this.instanceGeometry[inst];
      if (g >= 0) pairs += this.geometries[g].clusters.length;
    }
    const ci = new Uint32Array(pairs * 2);
    let w = 0;
    const emit = (group: InstanceGroup) => {
      const start = geomClusterStart[group.geometry];
      const n = this.geometries[group.geometry].clusters.length;
      // A skinned instance spans 1 + boneCount rows: only its bounds row (the
      // first) has cluster instances; the bone rows follow it.
      const rows = group.rowsPerInstance ?? 1;
      for (let i = 0; i < group.count; i++) {
        const inst = group.first + i * rows;
        for (let k = 0; k < n; k++) {
          ci[w++] = start + k;
          ci[w++] = inst;
        }
      }
    };
    if (this.staticCache) {
      for (const g of this.groups) if (!g.dynamic) emit(g);
      this.dynamicFirst = w / 2;
      for (const g of this.groups) if (g.dynamic) emit(g);
    } else {
      // Groups are registered in instance order, so this is instance order.
      for (const g of this.groups) emit(g);
      this.dynamicFirst = pairs;
    }
    this.clusterInstanceCount = pairs;

    const instanceFloats = this.instanceGeometry.length * 12;
    const scene = new Float32Array(clusterVec.length + instanceFloats);
    scene.set(clusterVec, 0);
    scene.set(this.instanceMatrices.subarray(0, instanceFloats), clusterVec.length);

    this.sceneBuffer = this.upload("ps.scene", scene, STORAGE | COPY_DST);
    this.clusterInstanceBuffer = this.upload("ps.clusterInstances", ci, STORAGE);
    this.dirtyInstances.clear();
    this.lastBuild = { reusedGeometry: reuse, invalidated: this.started ? this.invalidateChanged() : 0, internal };

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

  /** Free every GPU resource. The core cannot be used afterwards. */
  dispose(): void {
    this.destroyContentBuffers(false);
    for (const b of [this.paramsBuffer, this.pageTableBuffer, this.requestBuffer, this.counterBuffer, this.workBuffer, this.pairBuffer, this.dispatchBuffer]) b.destroy();
    for (const rb of this.readbacks) rb.buffer.destroy();
    this.queryResolve?.destroy();
    this.querySet?.destroy();
    this.poolTexture.destroy();
    this.staticPool?.destroy();
    this.minMaxTexture.destroy();
    this.alphaTexture.destroy();
    this.geometryCache.clear();
    this.depthBinding = null;
  }

  /** Free the content buffers; with `keepGeometry`, keep the packed vertex and index buffers. */
  private destroyContentBuffers(keepGeometry = false): void {
    for (const b of [this.sceneBuffer, this.clusterInstanceBuffer]) b?.destroy();
    if (!keepGeometry) {
      this.packed?.vertexBuffer.destroy();
      this.packed?.indexBuffer.destroy();
      this.packed = null;
    }
    this.sceneBuffer = this.clusterInstanceBuffer = this.vertexBuffer = this.indexBuffer = null;
    this.computeGroup = this.rasterGroup = null;
  }

  /**
   * Every live instance's signature (geometry key + matrix) with its world
   * bounds, bucketed by a numeric hash of that signature. Equality is then
   * confirmed exactly (sameSignature), so a hash collision costs a compare,
   * never a wrong diff. This used to build a 12-number string per instance,
   * twice per rebuild (~2 us each: ~16 ms over a comm sim's 3,943 instances).
   */
  private instanceSignatures(): InstanceSnapshot {
    const n = this.instanceGeometry.length;
    const m = this.instanceMatrices;
    // One string hash per geometry, not per instance.
    const keyHash = this.geometryKeyOrder.map((k) => (k === null ? 0 : hashString(k)));
    const bounds = new Float64Array(n * 6);
    const buckets = new Map<number, number[]>();
    const b = this.boxBefore;
    for (let inst = 0; inst < n; inst++) {
      if (this.instanceGeometry[inst] < 0) continue; // a skinned instance's bone row: its bounds row speaks for it
      if (!this.instanceBoundsInto(inst, b)) continue; // collapsed: casts nothing, so neither its going nor its coming changes a page
      bounds.set(b, inst * 6);
      let h = keyHash[this.instanceGeometry[inst]];
      const o = inst * 12;
      for (let k = 0; k < 12; k++) {
        // +0 folds -0 into 0: they compare equal (sameSignature uses ===), so must hash alike.
        F32[0] = m[o + k] + 0;
        h = Math.imul(h ^ U32[0], 0x01000193) ^ (h >>> 13);
      }
      const list = buckets.get(h);
      if (list) list.push(inst);
      else buckets.set(h, [inst]);
    }
    return { matrices: m, geometry: this.instanceGeometry, keys: this.geometryKeyOrder, bounds, buckets };
  }

  /**
   * Re-render the pages under instances that differ from the snapshot taken by
   * clearContent(): the ones that went (at their old bounds) and the ones that
   * came (at their new bounds); an instance that moved is both. Returns how
   * many boxes were invalidated, or "all" when the difference was unknown or too
   * large for per-box invalidation.
   */
  private invalidateChanged(): "all" | number {
    const before = this.previousInstances;
    this.previousInstances = null;
    if (!before || this.geometryKeyOrder.includes(null)) {
      this.invalidateAll();
      return "all";
    }
    const after = this.instanceSignatures();
    const boxes: [Vec3, Vec3][] = [];
    const box = (snap: InstanceSnapshot, inst: number): [Vec3, Vec3] => {
      const o = inst * 6;
      const b = snap.bounds;
      return [[b[o], b[o + 1], b[o + 2]], [b[o + 3], b[o + 4], b[o + 5]]];
    };
    // A multiset difference per hash bucket: each old instance consumes one
    // equal new one, and whatever is left on either side went or came. `from`
    // skips the consumed new instances at the front, so a bucket of many
    // identical instances matches in linear time.
    for (const [h, olds] of before.buckets) {
      const news = after.buckets.get(h);
      if (!news) {
        for (const i of olds) boxes.push(box(before, i));
        continue;
      }
      const used = new Uint8Array(news.length);
      let from = 0;
      for (const i of olds) {
        let hit = -1;
        for (let j = from; j < news.length; j++) {
          if (!used[j] && sameSignature(before, i, after, news[j])) {
            hit = j;
            break;
          }
        }
        if (hit < 0) boxes.push(box(before, i));
        else {
          used[hit] = 1;
          while (from < news.length && used[from]) from++;
        }
      }
      for (let j = 0; j < news.length; j++) if (!used[j]) boxes.push(box(after, news[j]));
      after.buckets.delete(h);
    }
    for (const news of after.buckets.values()) for (const j of news) boxes.push(box(after, j));
    // Past the region budget boxes merge (invalidateBox); only a change far
    // too large to be worth diffing re-renders everything.
    if (boxes.length > MAX_REGIONS * 8) {
      this.invalidateAll();
      return "all";
    }
    for (const [min, max] of boxes) this.invalidateBox(min, max);
    return boxes.length;
  }

  get contentSummary() {
    return {
      /** Geometries registered since clearContent() that reused cached clusters. */
      cachedGeometries: this.cacheHits,
      /** The last build kept the packed geometry, and how much it re-rendered ("all" or boxes). */
      lastBuild: { ...this.lastBuild },
      /** build() calls so far, and how many were the adapter's own (not a host call; see lastBuild.internal). */
      builds: this.builds,
      internalBuilds: this.internalBuilds,
      geometries: this.geometries.length,
      /** Clusters that cast through an alpha mask. */
      alphaClusters: this.geometries.reduce((s, g) => s + g.clusters.filter((c) => c.alphaLayer !== 0xffffffff).length, 0),
      instances: this.instanceGeometry.reduce((s, g) => s + (g >= 0 ? 1 : 0), 0),
      clusters: this.clusterCount,
      clusterInstances: this.clusterInstanceCount,
      /** Cluster instances of dynamic groups (0 without the static cache: they are culled with the rest). */
      dynamicClusterInstances: this.clusterInstanceCount - this.dynamicFirst,
      triangles: this.geometries.reduce((s, g) => s + g.indices.length / 3, 0),
    };
  }

  // ---- per frame ------------------------------------------------------------

  /** Run the paging pipeline for this frame. Submit before the receivers render. */
  update(input: FrameInput): void {
    if (!this.computeGroup || !this.rasterGroup) throw new Error("PagedShadowCore.build() has not run");
    // Fully faded shadows (night, the end of dusk) change no pixel: receivers
    // return 1 before any lookup. Stop marking, paging and rasterising until
    // they come back; invalidations keep accumulating (capped: past MAX_REGIONS
    // they become one invalidateAll), and everything is re-rendered on wake.
    if (this.tuning.darkness >= INVISIBLE_DARKNESS) {
      if (!this.dormant) {
        this.dormant = true;
        this.device.queue.writeBuffer(this.paramsBuffer, SHADE_WORD * 4, new Float32Array([Math.min(1, this.tuning.darkness), 0, 0, 0]));
      }
      return;
    }
    if (this.dormant) {
      this.dormant = false;
      this.invalidateAll();
    }
    const d = this.device;
    this.frame++;
    // Pages rendered while the early-out was off have no min/max: re-render
    // them all before receivers may trust the atlas again (invalid pages are
    // never read, so no stale bound is ever used).
    const minMax = this.minMaxSupported && this.tuning.minMaxEarlyOut;
    if (minMax && !this.minMaxLive) this.invalidateAll();
    this.minMaxLive = minMax;
    const lightDir = normalize(input.lightDir);
    this.refreshLevels(lightDir);
    this.uploadDirtyInstances();
    const regionCount = this.writeParams(input);
    const depth = input.depth ? this.bindDepth(input.depth.texture) : null;

    const enc = d.createCommandEncoder({ label: "ps.frame" });
    enc.clearBuffer(this.counterBuffer);
    // Legacy path: mark from last frame's depth at the start of this frame.
    // With markInto(), requests were written during the previous frame and
    // are consumed here, then cleared after paging.
    if (depth) enc.clearBuffer(this.requestBuffer);

    const wg = (n: number) => Math.max(1, Math.ceil(n / 64));
    const k = this.kernels;
    const profiling = this.profiling && this.passTimestamps.length > 0;
    const timed = profiling ? this.passTimestamps : null;
    // Marking gets its own pass: it waits on last frame's depth, and that wait
    // must not be billed to page management.
    if (depth && input.depth) {
      const tex = input.depth.texture;
      const mp = enc.beginComputePass({ label: "ps.mark", timestampWrites: timed?.[0] });
      mp.setBindGroup(0, this.computeGroup);
      mp.setPipeline(depth.pipeline);
      mp.setBindGroup(1, depth.group);
      mp.dispatchWorkgroups(Math.ceil(tex.width / this.markStride / 8), Math.ceil(tex.height / this.markStride / 8));
      mp.end();
    }
    // Paging is two passes around a 12-byte copy: the cull is dispatched
    // indirectly from args finalizeRenderList writes into the work buffer,
    // which cannot be indirect while it is bound writable (see WorkLayout.dispatch).
    const cp = enc.beginComputePass({ label: "ps.paging", timestampWrites: timed?.[1] });
    cp.setBindGroup(0, this.computeGroup);
    cp.setPipeline(k.updateSlots);
    cp.dispatchWorkgroups(wg(this.slots));
    // Stale before invalid: a page both touch needs the full render (K2d).
    const dynamicRegionCount = this.frameDynamicRegions;
    if (dynamicRegionCount > 0) {
      cp.setPipeline(k.markDynamicRegions);
      cp.dispatchWorkgroups(wg(dynamicRegionCount * this.levelCount));
    }
    if (regionCount > 0) {
      cp.setPipeline(k.invalidateRegions);
      cp.dispatchWorkgroups(wg(regionCount * this.levelCount));
    }
    cp.setPipeline(k.collectPhys);
    cp.dispatchWorkgroups(wg(this.pageCount));
    cp.setPipeline(k.allocate);
    cp.dispatchWorkgroups(wg(this.slots));
    // Coarsest level first (see K5): its pages never lose the budget to finer ones.
    const perLevel = this.pagesPerSide * this.pagesPerSide;
    cp.setPipeline(k.buildRenderListCoarse);
    cp.dispatchWorkgroups(wg(perLevel));
    if (this.levelCount > 1) {
      cp.setPipeline(k.buildRenderListFine);
      cp.dispatchWorkgroups(wg(this.slots - perLevel));
    }
    cp.setPipeline(k.finalizeRenderList);
    cp.dispatchWorkgroups(1);
    if (this.staticCache) {
      // The dynamic list follows the static one (K5d), coarsest level first too.
      cp.setPipeline(k.buildDynamicListCoarse);
      cp.dispatchWorkgroups(wg(perLevel));
      if (this.levelCount > 1) {
        cp.setPipeline(k.buildDynamicListFine);
        cp.dispatchWorkgroups(wg(this.slots - perLevel));
      }
      cp.setPipeline(k.finalizeDynamicList);
      cp.dispatchWorkgroups(1);
    }
    cp.end();
    enc.copyBufferToBuffer(this.workBuffer, this.work.dispatch * 4, this.dispatchBuffer, 0, 12);
    const cull = enc.beginComputePass({ label: "ps.cull", timestampWrites: timed?.[3] });
    cull.setBindGroup(0, this.computeGroup);
    // Dynamic cluster instances first: their pairs' count bounds the static
    // ones (both share each pair list). Few threads, each leaving at once on
    // a frame that draws no page.
    const dynamicClusterInstances = this.clusterInstanceCount - this.dynamicFirst;
    if (dynamicClusterInstances > 0) {
      cull.setPipeline(k.cullDynamicClusters);
      cull.dispatchWorkgroups(wg(dynamicClusterInstances));
    }
    // Zero workgroups when no static page renders this frame (the common static case).
    cull.setPipeline(k.cullClusters);
    cull.dispatchWorkgroupsIndirect(this.dispatchBuffer, 0);
    // Always runs: it zeroes the caster draws when the cull did not run (the
    // pair counters were cleared), and it is one thread.
    cull.setPipeline(k.finalizeDraws);
    cull.dispatchWorkgroups(1);
    cull.end();
    if (!depth) enc.clearBuffer(this.requestBuffer);

    const indirect = this.work.indirect * 4;
    const loadOp: GPULoadOp = this.started ? "load" : "clear";
    // Static casters: into staticPool with the cache, into the pool without it.
    const rp = enc.beginRenderPass({
      label: "ps.raster",
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.staticView ?? this.poolView,
        depthLoadOp: loadOp,
        depthClearValue: 1,
        depthStoreOp: "store",
      },
      timestampWrites: timed?.[this.staticCache ? 4 : 2],
    });
    rp.setBindGroup(0, this.rasterGroup);
    rp.setPipeline(this.clearPipeline);
    rp.drawIndirect(this.workBuffer, indirect);
    rp.setPipeline(this.opaquePipeline);
    rp.drawIndirect(this.workBuffer, indirect + 16);
    rp.setPipeline(this.alphaPipeline);
    rp.drawIndirect(this.workBuffer, indirect + 32);
    rp.end();
    if (this.staticCache) {
      // The live pool: every page drawn this frame (static and dynamic list)
      // gets its static depth copied in, then its dynamic casters drawn over
      // it. A depth texture's sub-rectangle cannot be copied, hence a quad per
      // page writing frag_depth. staticPool is bound only here, never in the
      // pass that renders into it.
      const lp = enc.beginRenderPass({
        label: "ps.rasterLive",
        colorAttachments: [],
        depthStencilAttachment: { view: this.poolView, depthLoadOp: loadOp, depthClearValue: 1, depthStoreOp: "store" },
        timestampWrites: timed?.[5],
      });
      lp.setBindGroup(0, this.rasterGroup);
      lp.setBindGroup(1, this.compositeGroup!);
      lp.setPipeline(this.compositePipeline!);
      lp.drawIndirect(this.workBuffer, indirect + 48);
      lp.setPipeline(this.opaqueDynamicPipeline!);
      lp.drawIndirect(this.workBuffer, indirect + 64);
      lp.setPipeline(this.alphaDynamicPipeline!);
      lp.drawIndirect(this.workBuffer, indirect + 80);
      lp.end();
    }
    // Min/max of every page just drawn, in its own pass after the raster so
    // the pool reads see this frame's depth. Pages not drawn this frame keep
    // both their depth and their min/max, so the atlas stays exact.
    if (minMax) {
      const mp = enc.beginComputePass({ label: "ps.minMax" });
      mp.setPipeline(this.minMaxPipeline);
      mp.setBindGroup(0, this.minMaxGroup);
      const blocks = Math.ceil(this.pageSize / MINMAX_TILE / 8);
      const pages =
        Math.min(this.tuning.renderBudget, this.renderBudgetMax) +
        (this.staticCache ? Math.min(this.tuning.dynamicBudget, this.dynamicBudgetMax) : 0);
      mp.dispatchWorkgroups(blocks, blocks, pages);
      mp.end();
    }
    this.started = true;

    // Counters every statsInterval frames (from the first), or every frame while profiling.
    let rb: (typeof this.readbacks)[number] | null = null;
    if (profiling || (this.frame - 1) % Math.max(1, Math.floor(this.statsInterval)) === 0) {
      for (const r of this.readbacks) {
        if (!r.busy) {
          rb = r;
          break;
        }
      }
    }
    if (rb) {
      enc.copyBufferToBuffer(this.counterBuffer, 0, rb.buffer, 0, COUNTER_COUNT * 4);
      rb.timed = profiling;
      if (profiling && this.querySet && this.queryResolve) {
        enc.resolveQuerySet(this.querySet, 0, 6, this.queryResolve, 0);
        enc.copyBufferToBuffer(this.queryResolve, 0, rb.buffer, COUNTER_COUNT * 4, 48);
      }
    }
    d.queue.submit([enc.finish()]);
    if (rb) this.readStats(rb, this.frame);
  }

  /**
   * Mark pages from a camera depth buffer inside the HOST's command encoder,
   * right after the camera that produced it has rendered and before anything
   * else (a HUD camera, a post-process) can clear or overwrite that depth.
   * The requests are consumed by the next update(). Use this instead of
   * FrameInput.depth whenever the host lets you encode mid-frame.
   */
  markInto(encoder: GPUCommandEncoder, depth: { texture: GPUTexture; invViewProj: ArrayLike<number> }): void {
    if (!this.computeGroup) return;
    const bound = this.bindDepth(depth.texture);
    // writeBuffer copies at the call, so one block serves every frame.
    const block = this.markBlock;
    const m = depth.invViewProj;
    const n = Math.min(16, m.length);
    for (let k = 0; k < 16; k++) block[k] = k < n ? m[k] : 0;
    block[16] = depth.texture.width;
    block[17] = depth.texture.height;
    block[18] = this.markStride;
    block[19] = 1;
    this.device.queue.writeBuffer(this.paramsBuffer, 20 * 4, block);
    const mp = encoder.beginComputePass({
      label: "ps.mark",
      timestampWrites: this.profiling && this.passTimestamps.length ? this.passTimestamps[0] : undefined,
    });
    mp.setBindGroup(0, this.computeGroup);
    mp.setPipeline(bound.pipeline);
    mp.setBindGroup(1, bound.group);
    mp.dispatchWorkgroups(
      Math.ceil(depth.texture.width / this.markStride / 8),
      Math.ceil(depth.texture.height / this.markStride / 8),
    );
    mp.end();
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
    const c = this.depthCentre;
    const r = this.depthRadius + 1;
    lv.zMin = dot(c, dir) - r;
    lv.zRange = 2 * r;
    lv.invalidate = true;
  }

  /**
   * Fill the params header (and the queued regions) and upload it. Runs every
   * frame, so it writes through persistent views by index: no typed-array
   * views, array literals or spreads. The bytes are exactly those the
   * array-literal version wrote (proved against it frame by frame).
   */
  private writeParams(input: FrameInput): number {
    const f = this.paramsF32;
    const i = this.paramsI32;
    const u = this.paramsU32;
    const t = this.tuning;
    const eye = input.eye;
    f[0] = eye[0]; f[1] = eye[1]; f[2] = eye[2]; f[3] = input.pixelWorldSizeAt1m;
    f[4] = t.lodBias; f[5] = t.normalOffset; f[6] = t.depthBias; f[7] = t.debugMode;
    u[8] = this.poolSize; u[9] = this.poolSize / this.pageSize; u[10] = this.pageSize; u[11] = this.pageCount;
    u[12] = this.levelCount; u[13] = this.pagesPerSide; u[14] = this.frame; u[15] = Math.min(t.renderBudget, this.renderBudgetMax);
    const regionCount = Math.min(MAX_REGIONS, this.regions.length / 8);
    u[16] = regionCount; u[17] = this.clusterInstanceCount; u[18] = this.maxPairs; u[19] = this.clusterCount;
    if (input.depth) {
      const m = input.depth.invViewProj;
      // At most 16: words 36.. are the depth size and stride.
      const n = Math.min(16, m.length);
      for (let k = 0; k < n; k++) f[20 + k] = m[k];
      f[36] = input.depth.texture.width; f[37] = input.depth.texture.height; f[38] = this.markStride; f[39] = 1;
    } else {
      f[36] = 0; f[37] = 0; f[38] = this.markStride; f[39] = 0;
    }
    f[SHADE_WORD] = Math.min(1, Math.max(0, t.darkness)); f[SHADE_WORD + 1] = this.minMaxLive ? 1 : 0;
    f[SHADE_WORD + 2] = this.markRotate && this.markStride > 1 ? 1 : 0; f[SHADE_WORD + 3] = 0;

    const lo = this.sceneMin;
    const hi = this.sceneMax;
    const half = this.pagesPerSide / 2;
    for (let l = 0; l < this.levelCount; l++) {
      const lv = this.levels[l];
      const pageWorld = this.finestPageWorldSize * 2 ** l;
      const base = LEVELS_WORD + l * 28;
      const r = lv.right;
      const up = lv.up;
      const dir = lv.dir;
      f[base] = r[0]; f[base + 1] = r[1]; f[base + 2] = r[2]; f[base + 3] = pageWorld;
      f[base + 4] = up[0]; f[base + 5] = up[1]; f[base + 6] = up[2]; f[base + 7] = 1 / pageWorld;
      f[base + 8] = dir[0]; f[base + 9] = dir[1]; f[base + 10] = dir[2]; f[base + 11] = pageWorld / this.pageSize;
      f[base + 12] = lv.zMin; f[base + 13] = 1 / lv.zRange; f[base + 14] = lv.zRange; f[base + 15] = 0;
      const cx = Math.floor(dot(eye, r) / pageWorld);
      const cy = Math.floor(dot(eye, up) / pageWorld);
      i[base + 16] = cx - half; i[base + 17] = cy - half; i[base + 18] = 0; i[base + 19] = 0;
      // The scene box's page rect: its 8 corners projected on the level's basis.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < 8; k++) {
        const c0 = k & 1 ? hi[0] : lo[0];
        const c1 = k & 2 ? hi[1] : lo[1];
        const c2 = k & 4 ? hi[2] : lo[2];
        const x = Math.floor((c0 * r[0] + c1 * r[1] + c2 * r[2]) / pageWorld);
        const y = Math.floor((c0 * up[0] + c1 * up[1] + c2 * up[2]) / pageWorld);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      i[base + 20] = x0; i[base + 21] = y0; i[base + 22] = x1; i[base + 23] = y1;
      u[base + 24] = lv.invalidate ? 1 : 0; u[base + 25] = 0; u[base + 26] = 0; u[base + 27] = 0;
      lv.invalidate = false;
    }
    // The dynamic regions follow the static ones. Their count, the dynamic
    // budget and the first dynamic cluster instance ride in levels[0].flags.yzw
    // (unused otherwise; see dynRegionCount() in kernels.ts).
    const dynamicCount = Math.min(MAX_REGIONS - regionCount, this.dynamicRegions.length / 8);
    const l0 = LEVELS_WORD + 24;
    u[l0 + 1] = dynamicCount;
    u[l0 + 2] = Math.min(this.tuning.dynamicBudget, this.dynamicBudgetMax);
    u[l0 + 3] = this.dynamicFirst;
    const regions = this.regions;
    const r0 = PARAMS_HEADER_BYTES / 4;
    for (let k = 0, n = regionCount * 8; k < n; k++) f[r0 + k] = regions[k];
    regions.length = 0;
    const dyn = this.dynamicRegions;
    const d0 = r0 + regionCount * 8;
    for (let k = 0, n = dynamicCount * 8; k < n; k++) f[d0 + k] = dyn[k];
    dyn.length = 0;
    this.frameDynamicRegions = dynamicCount;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params, 0, PARAMS_HEADER_BYTES + (regionCount + dynamicCount) * 32);
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

  /**
   * Upload the rows of every instance moved since the last frame. Dirty
   * instances are sorted and written as runs: instances at most UPLOAD_GAP
   * apart share one writeBuffer (the clean rows between them are re-sent as
   * they are, which is cheaper than another call), so a linkset or a crowd
   * moving together costs one or a few writes instead of one per instance.
   */
  private uploadDirtyInstances(): void {
    if (!this.sceneBuffer || this.dirtyInstances.size === 0) return;
    const order = this.dirtyOrder;
    order.length = 0;
    for (const inst of this.dirtyInstances) order.push(inst);
    this.dirtyInstances.clear();
    order.sort(ascending);
    // Staging floats needed: every run's span.
    let floats = 0;
    for (let a = 0; a < order.length; ) {
      let b = a;
      while (b + 1 < order.length && order[b + 1] - order[b] <= UPLOAD_GAP) b++;
      floats += (order[b] - order[a] + 1) * 12;
      a = b + 1;
    }
    if (this.uploadRows.length < floats) this.uploadRows = new Float32Array(Math.max(floats, this.uploadRows.length * 2));
    const rows = this.uploadRows;
    const m = this.instanceMatrices;
    const base = this.clusterCount * 48;
    let w = 0;
    for (let a = 0; a < order.length; ) {
      let b = a;
      while (b + 1 < order.length && order[b + 1] - order[b] <= UPLOAD_GAP) b++;
      const first = order[a];
      const count = (order[b] - first + 1) * 12;
      for (let k = 0; k < count; k++) rows[w + k] = m[first * 12 + k];
      // writeBuffer copies at the call, so the staging array is reused at once.
      this.device.queue.writeBuffer(this.sceneBuffer, base + first * 48, rows, w, count);
      w += count;
      a = b + 1;
    }
  }

  /** An instance's world AABB into `out` (min xyz, max xyz); false when it is collapsed to zero scale (it casts nothing). */
  private instanceBoundsInto(inst: number, out: Float64Array): boolean {
    const g = this.geometries[this.instanceGeometry[inst]];
    const m = this.instanceMatrices;
    const o = inst * 12;
    let linear = 0;
    for (let r = 0; r < 3; r++) linear += Math.abs(m[o + r * 4]) + Math.abs(m[o + r * 4 + 1]) + Math.abs(m[o + r * 4 + 2]);
    if (linear === 0) return false;
    const c0 = (g.aabbMin[0] + g.aabbMax[0]) / 2;
    const c1 = (g.aabbMin[1] + g.aabbMax[1]) / 2;
    const c2 = (g.aabbMin[2] + g.aabbMax[2]) / 2;
    const e0 = (g.aabbMax[0] - g.aabbMin[0]) / 2;
    const e1 = (g.aabbMax[1] - g.aabbMin[1]) / 2;
    const e2 = (g.aabbMax[2] - g.aabbMin[2]) / 2;
    for (let r = 0; r < 3; r++) {
      const p = o + r * 4;
      const wc = m[p] * c0 + m[p + 1] * c1 + m[p + 2] * c2 + m[p + 3];
      const we = Math.abs(m[p]) * e0 + Math.abs(m[p + 1]) * e1 + Math.abs(m[p + 2]) * e2;
      out[r] = wc - we;
      out[r + 3] = wc + we;
    }
    return true;
  }

  private readStats(rb: { buffer: GPUBuffer; busy: boolean; timed: boolean }, frame: number): void {
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
        s.dynamicPages = Math.min(c[C_DYN_PAGES], this.tuning.dynamicBudget);
        s.dynamicDeferred = c[C_DYN_DEFERRED];
        s.compositedPages = this.staticCache ? s.renderedPages + s.dynamicPages : 0;
        s.opaquePairs = c[C_OPAQUE_PAIRS];
        s.alphaPairs = c[C_ALPHA_PAIRS];
        s.dynamicPairs = c[C_DYN_OPAQUE_PAIRS] + c[C_DYN_ALPHA_PAIRS];
        // Static and dynamic pairs share each list (from either end).
        s.droppedPairs =
          Math.max(0, c[C_OPAQUE_PAIRS] + c[C_DYN_OPAQUE_PAIRS] - this.maxPairs) +
          Math.max(0, c[C_ALPHA_PAIRS] + c[C_DYN_ALPHA_PAIRS] - this.maxPairs);
        if (rb.timed && this.querySet) {
          const ts = new BigUint64Array(data, COUNTER_COUNT * 4, 6);
          const ms = (a: bigint, b: bigint) => (b > a ? Number(b - a) / 1e6 : 0);
          s.gpuMarkMs = ms(ts[0], ts[1]);
          s.gpuComputeMs = ms(ts[2], ts[3]);
          s.gpuRasterMs = ms(ts[4], ts[5]);
        } else if (!this.profiling) {
          // Not profiling: no timings, rather than stale ones that look live.
          s.gpuMarkMs = s.gpuComputeMs = s.gpuRasterMs = null;
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

    // Min/max build: its own layout, since the pool (a depth texture) and a
    // storage texture have no place in the storage-buffer-only compute layout.
    const minMaxLayout = d.createBindGroupLayout({
      label: "ps.minMaxLayout",
      entries: [
        ...Array.from({ length: 3 }, (_, binding) => ({ binding, ...storage("read-only-storage", C) })),
        { binding: 3, visibility: C, texture: { sampleType: "depth" } },
        { binding: 4, visibility: C, storageTexture: { access: "write-only", format: "rg32uint" } },
      ],
    });
    this.minMaxPipeline = d.createComputePipeline({
      label: "ps.buildMinMax",
      layout: d.createPipelineLayout({ bindGroupLayouts: [minMaxLayout] }),
      compute: { module: d.createShaderModule({ label: "ps.minMax", code: minMaxWGSL(this.work) }), entryPoint: "buildMinMax" },
    });
    this.minMaxGroup = d.createBindGroup({
      layout: minMaxLayout,
      entries: [
        ...[this.paramsBuffer, this.pageTableBuffer, this.workBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
        { binding: 3, resource: this.poolTexture.createView({ aspect: "depth-only" }) },
        { binding: 4, resource: this.minMaxTexture.createView() },
      ],
    });

    const kernelModule = d.createShaderModule({ label: "ps.kernels", code: kernelsWGSL(this.work, this.maxPairs) });
    const computePL = d.createPipelineLayout({ bindGroupLayouts: [this.computeLayout] });
    for (const entryPoint of [
      "updateSlots", "invalidateRegions", "collectPhys", "allocate",
      "buildRenderListCoarse", "buildRenderListFine", "finalizeRenderList", "cullClusters", "finalizeDraws",
      ...(this.staticCache
        ? ["markDynamicRegions", "buildDynamicListCoarse", "buildDynamicListFine", "finalizeDynamicList", "cullDynamicClusters"]
        : []),
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

    if (this.staticPool) {
      // The live pool's pass: the composite reads staticPool (group 1), and
      // the dynamic casters draw as the static ones do, from the other end of
      // each pair list.
      const compositeLayout = d.createBindGroupLayout({
        label: "ps.compositeLayout",
        entries: [{ binding: 0, visibility: F, texture: { sampleType: "depth" } }],
      });
      this.compositeGroup = d.createBindGroup({
        layout: compositeLayout,
        entries: [{ binding: 0, resource: this.staticPool.createView({ aspect: "depth-only" }) }],
      });
      this.compositePipeline = d.createRenderPipeline({
        label: "ps.composite",
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.rasterLayout, compositeLayout] }),
        vertex: { module: rasterModule, entryPoint: "clearVS" },
        fragment: { module: rasterModule, entryPoint: "compositeFS", targets: [] },
        primitive: { topology: "triangle-list" },
        depthStencil: depth("always", false),
      });
      this.opaqueDynamicPipeline = d.createRenderPipeline({
        label: "ps.opaqueDynamic",
        layout: rasterPL,
        vertex: { module: rasterModule, entryPoint: "opaqueDynamicVS" },
        fragment: this.useClipDistances ? undefined : { module: rasterModule, entryPoint: "opaqueFS", targets: [] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: depth("less", true),
      });
      this.alphaDynamicPipeline = d.createRenderPipeline({
        label: "ps.alphaDynamic",
        layout: rasterPL,
        vertex: { module: rasterModule, entryPoint: "alphaDynamicVS" },
        fragment: { module: rasterModule, entryPoint: "alphaFS", targets: [] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: depth("less", true),
      });
    }
  }
}

/** The 3 affine rows of the column-major 4x4 at m[o..], written to dst[d..d+12]. */
function writeAffineRows(dst: Float32Array, d: number, m: Float32Array | number[], o: number): void {
  dst[d] = m[o]; dst[d + 1] = m[o + 4]; dst[d + 2] = m[o + 8]; dst[d + 3] = m[o + 12];
  dst[d + 4] = m[o + 1]; dst[d + 5] = m[o + 5]; dst[d + 6] = m[o + 9]; dst[d + 7] = m[o + 13];
  dst[d + 8] = m[o + 2]; dst[d + 9] = m[o + 6]; dst[d + 10] = m[o + 10]; dst[d + 11] = m[o + 14];
}

/**
 * The live instances at clearContent(), for build() to diff against: their
 * matrices and geometry keys (the arrays themselves: clearContent() replaces
 * them rather than clearing them), world bounds (6 per instance), and the
 * non-collapsed instances bucketed by signature hash.
 */
interface InstanceSnapshot {
  matrices: Float32Array;
  geometry: number[];
  keys: (string | null)[];
  bounds: Float64Array;
  buckets: Map<number, number[]>;
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
}

/** Same geometry key and exactly the same matrix (=== per float, as the string signature compared). */
function sameSignature(a: InstanceSnapshot, i: number, b: InstanceSnapshot, j: number): boolean {
  if (a.keys[a.geometry[i]] !== b.keys[b.geometry[j]]) return false;
  const ma = a.matrices;
  const mb = b.matrices;
  const oa = i * 12;
  const ob = j * 12;
  for (let k = 0; k < 12; k++) if (ma[oa + k] !== mb[ob + k]) return false;
  return true;
}
