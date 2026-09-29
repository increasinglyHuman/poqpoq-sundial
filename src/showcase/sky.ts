import * as THREE from "three/webgpu";
import { Fn, cameraPosition, clamp, dot, float, max, mix, modelViewProjection, normalize, positionWorld, pow, smoothstep, uniform } from "three/tsl";

/**
 * A simple analytic gradient sky: zenith to horizon, a warm glow around the
 * sun and a small disc. Its horizon colour is the fog colour, so distant
 * terrain dissolves into it. Cheap, and predictable under ACES tone mapping.
 */
export class GradientSky extends THREE.Mesh {
  readonly zenith = uniform(new THREE.Color());
  readonly horizon = uniform(new THREE.Color());
  readonly glow = uniform(new THREE.Color());
  readonly sunDirection = uniform(new THREE.Vector3(0, 1, 0));

  constructor() {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    super(new THREE.BoxGeometry(1, 1, 1), material);
    this.frustumCulled = false;
    this.renderOrder = -1;

    material.vertexNode = Fn(() => {
      const position = modelViewProjection;
      // On the far plane. (@types/three types this node without swizzles.)
      const clip = position as unknown as { z: { assign(v: unknown): void }; w: unknown };
      clip.z.assign(clip.w);
      return position;
    })();

    material.colorNode = Fn(() => {
      const dir = normalize(positionWorld.sub(cameraPosition));
      const up = max(dir.y, float(0));
      // Zenith blue fades to the hazy horizon over the first ~25 degrees.
      const base = mix(this.horizon, this.zenith, pow(smoothstep(0.0, 0.55, up), float(0.8)));
      const toSun = clamp(dot(dir, this.sunDirection), 0.0, 1.0);
      const halo = pow(toSun, float(6)).mul(0.35).add(pow(toSun, float(64)).mul(0.6));
      const disc = smoothstep(0.9994, 0.9997, toSun).mul(12.0);
      // Below the horizon: the horizon colour, a touch darker.
      const below = smoothstep(0.0, -0.2, dir.y);
      const sky = base.add(this.glow.mul(halo.add(disc)));
      return mix(sky, this.horizon.mul(0.85), below);
    })();
  }
}
