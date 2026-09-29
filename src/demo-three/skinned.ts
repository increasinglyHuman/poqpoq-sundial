import * as THREE from "three/webgpu";

// A three.js port of src/demo/skinned.ts: ?skinned=N procedural skinned
// characters for the skinned-caster path. Same bone chain (hips -> spine ->
// chest -> head, two arms, two legs), same tube-building math, same walking
// loop as the Babylon version, adapted to three's skinning (SkinnedMesh /
// Skeleton / Bone, 4 bone influences via skinIndex/skinWeight).
//
// Not ported: Babylon's `split` option (spreading weights over 8 influences
// via matricesIndicesExtra/matricesWeightsExtra). three's standard skinning
// pipeline is 4-influence only; this demo always uses the 2-influence blend
// the original geometry produces, which SundialThree's isSkinned() picks up
// as an ordinary 4-influence skinned caster. See the final report for detail.
//
// Handedness: same convention as world.ts — every number here is exactly
// Babylon's; the caller mirrors Z by parenting these meshes under a
// `scale.z = -1` group.

const HIPS = 0, SPINE = 1, CHEST = 2, HEAD = 3, ARM_L = 4, ARM_R = 5, LEG_L = 6, LEG_R = 7;
/** Bone joints in bind-pose mesh space (the mesh origin is between the feet). */
const JOINTS: [number, number, number][] = [
  [0, 0.95, 0], // hips
  [0, 1.25, 0], // spine
  [0, 1.55, 0], // chest
  [0, 1.85, 0], // head (neck)
  [0.42, 1.6, 0], // left shoulder
  [-0.42, 1.6, 0], // right shoulder
  [0.16, 0.95, 0], // left hip
  [-0.16, 0.95, 0], // right hip
];
const PARENT = [-1, HIPS, SPINE, CHEST, CHEST, CHEST, HIPS, HIPS];

interface Builder {
  pos: number[];
  nrm: number[];
  idx: number[];
  bones: number[];
  weights: number[];
}

/**
 * A vertical tube (x, z centre) from y0 to y1, capped by hemispheres when
 * `caps`; `weigh(y)` gives each ring's (bone a, bone b, weight of b).
 */
function tube(b: Builder, cx: number, cz: number, y0: number, y1: number, r: number, caps: boolean, weigh: (y: number) => [number, number, number]) {
  const seg = 16;
  const rings: { y: number; r: number }[] = [];
  const capRings = caps ? 5 : 0;
  for (let i = capRings; i >= 1; i--) {
    const a = (i / capRings) * (Math.PI / 2);
    rings.push({ y: y0 - Math.sin(a) * r, r: Math.cos(a) * r + 1e-3 });
  }
  const body = Math.max(2, Math.round((y1 - y0) / 0.08));
  for (let i = 0; i <= body; i++) rings.push({ y: y0 + ((y1 - y0) * i) / body, r });
  for (let i = 1; i <= capRings; i++) {
    const a = (i / capRings) * (Math.PI / 2);
    rings.push({ y: y1 + Math.sin(a) * r, r: Math.cos(a) * r + 1e-3 });
  }
  const base = b.pos.length / 3;
  for (const ring of rings) {
    const [ba, bb, wb] = weigh(Math.min(Math.max(ring.y, y0), y1));
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      b.pos.push(cx + nx * ring.r, ring.y, cz + nz * ring.r);
      b.nrm.push(nx, 0, nz);
      b.bones.push(ba, bb, 0, 0);
      b.weights.push(1 - wb, wb, 0, 0);
    }
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let s = 0; s < seg; s++) {
      const a = base + i * seg + s;
      const c = base + i * seg + ((s + 1) % seg);
      b.idx.push(a, a + seg, c, c, a + seg, c + seg);
    }
  }
}

/** Blend weight between two joints, smoothed over `band` either side of `at`. */
const blend = (y: number, at: number, band: number) => Math.min(1, Math.max(0, (y - (at - band)) / (2 * band)));

function characterMesh(name: string): THREE.SkinnedMesh {
  const b: Builder = { pos: [], nrm: [], idx: [], bones: [], weights: [] };
  // Torso: hips -> spine -> chest -> head, blended across each joint.
  tube(b, 0, 0, 0.9, 2.0, 0.3, true, (y) => {
    if (y < JOINTS[SPINE][1]) return [HIPS, SPINE, blend(y, JOINTS[SPINE][1], 0.08)];
    if (y < JOINTS[CHEST][1]) return [SPINE, CHEST, blend(y, JOINTS[CHEST][1], 0.08)];
    return [CHEST, HEAD, blend(y, JOINTS[HEAD][1], 0.08)];
  });
  // Arms hang from the shoulders, blended into the chest at the top.
  for (const [bone, x] of [[ARM_L, 0.42], [ARM_R, -0.42]] as const) {
    tube(b, x, 0, 0.85, 1.6, 0.1, true, (y) => [bone, CHEST, blend(y, 1.6, 0.08)]);
  }
  // Legs from the hips to the ground, blended into the hips at the top.
  for (const [bone, x] of [[LEG_L, 0.16], [LEG_R, -0.16]] as const) {
    tube(b, x, 0, 0.1, 0.95, 0.12, true, (y) => [bone, HIPS, blend(y, 0.95, 0.08)]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3));
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(b.bones, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(b.weights, 4));
  geo.setIndex(b.idx);
  const mesh = new THREE.SkinnedMesh(geo);
  mesh.name = name;
  return mesh;
}

function characterSkeleton(): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < JOINTS.length; i++) {
    const p = PARENT[i];
    const j = JOINTS[i];
    const local = p < 0 ? j : ([j[0] - JOINTS[p][0], j[1] - JOINTS[p][1], j[2] - JOINTS[p][2]] as const);
    const bone = new THREE.Bone();
    bone.name = `bone.${i}`;
    bone.position.set(local[0], local[1], local[2]);
    bones.push(bone);
    if (p < 0) continue;
    bones[p].add(bone);
  }
  return bones;
}

export interface SkinnedCharacter {
  mesh: THREE.SkinnedMesh;
  /** Pose and place the character at time t (seconds). */
  update(t: number): void;
}

const EULER = new THREE.Euler();

export function buildCharacters(count: number, heightAt: (x: number, z: number) => number): { characters: SkinnedCharacter[]; material: THREE.MeshStandardMaterial } {
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.85, 0.45, 0.2), metalness: 0, roughness: 0.6 });
  const characters: SkinnedCharacter[] = [];
  for (let c = 0; c < count; c++) {
    const mesh = characterMesh(`skinned${c}`);
    mesh.material = material;
    mesh.receiveShadow = true;
    const bones = characterSkeleton();
    mesh.add(bones[HIPS]);
    mesh.bind(new THREE.Skeleton(bones));
    // Twice human size, so the limbs' shadows are wide enough to read at page scale.
    mesh.scale.set(2, 2, 2);
    const phase = (c / Math.max(1, count)) * Math.PI * 2;
    const pose = (bone: number, x: number, y: number, z: number) => {
      bones[bone].quaternion.setFromEuler(EULER.set(x, y, z, "XYZ"));
    };
    characters.push({
      mesh,
      update(t) {
        const w = t * 2.2 + phase;
        const swing = Math.sin(w);
        // Walk a circle, facing along it.
        const a = t * 0.18 + phase;
        const cx = -30 + Math.cos(a) * 6;
        const cz = -40 + Math.sin(a) * 6;
        mesh.position.set(cx, heightAt(cx, cz), cz);
        mesh.rotation.y = -a;
        pose(HIPS, 0, 0.15 * swing, 0);
        pose(SPINE, 0.25 + 0.2 * Math.sin(w * 0.5), 0, 0.35 * Math.sin(w * 0.5));
        pose(CHEST, 0.15, -0.2 * swing, 0.25 * Math.sin(w * 0.5));
        pose(HEAD, 0, 0.4 * Math.sin(w * 0.3), 0);
        // Arms swing opposite the legs, and lift outwards so their shadows separate from the body's.
        pose(ARM_L, 1.1 * swing, 0, 0.6 + 0.4 * Math.sin(w * 0.7));
        pose(ARM_R, -1.1 * swing, 0, -0.6 - 0.4 * Math.sin(w * 0.7));
        pose(LEG_L, -0.7 * swing, 0, 0.1);
        pose(LEG_R, 0.7 * swing, 0, -0.1);
      },
    });
  }
  return { characters, material };
}
