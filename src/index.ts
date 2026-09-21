// @poqpoq/sundial — engine-agnostic core. Talks only to a GPUDevice.
export { PagedShadowCore } from "./core/PagedShadowCore";
export type {
  FrameInput,
  InstanceGroup,
  PagedShadowOptions,
  Stats,
  Tuning,
  Vec3,
} from "./core/PagedShadowCore";
export type { GeometryInput } from "./core/geometry";
export { COMMON_WGSL, RECEIVER_WGSL, MAX_LEVELS } from "./core/wgsl";
