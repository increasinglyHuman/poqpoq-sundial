import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Bone } from "@babylonjs/core/Bones/bone";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

// ?skinned=N: procedural skinned characters for the skinned-caster path. A
// capsule torso on a hips -> spine -> chest -> head chain, two arms and two
// legs, all one mesh with a skeleton built in code (no assets). They walk a
// loop, bending the spine and swinging the limbs far enough that a shadow
// cast from the bind pose, or clipped by too small a box, is obvious.

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

/**
 * `split`: move half of every weight into Babylon's second influence set
 * (matricesIndicesExtra / matricesWeightsExtra) on the same bones. The pose is
 * unchanged; it exercises the 8-influence path.
 */
function characterMesh(scene: Scene, name: string, split: boolean): Mesh {
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
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = b.pos;
  vd.normals = b.nrm;
  vd.indices = b.idx;
  vd.matricesIndices = b.bones;
  vd.matricesWeights = b.weights;
  if (split) {
    vd.matricesWeights = b.weights.map((w) => w / 2);
    vd.matricesIndicesExtra = b.bones;
    vd.matricesWeightsExtra = b.weights.map((w) => w / 2);
  }
  vd.applyToMesh(mesh);
  mesh.numBoneInfluencers = split ? 8 : 4;
  return mesh;
}

function characterSkeleton(scene: Scene, name: string): Skeleton {
  const skeleton = new Skeleton(name, name, scene);
  const bones: Bone[] = [];
  for (let i = 0; i < JOINTS.length; i++) {
    const p = PARENT[i];
    const j = JOINTS[i];
    const local = p < 0 ? j : [j[0] - JOINTS[p][0], j[1] - JOINTS[p][1], j[2] - JOINTS[p][2]];
    bones.push(new Bone(`${name}.${i}`, skeleton, p < 0 ? null : bones[p], Matrix.Translation(local[0], local[1], local[2])));
  }
  return skeleton;
}

export interface SkinnedCharacter {
  mesh: Mesh;
  /** Pose and place the character at time t (seconds). */
  update(t: number): void;
}

const Q = new Quaternion();
const T = new Vector3();
const ONE = new Vector3(1, 1, 1);

export function buildCharacters(scene: Scene, count: number, heightAt: (x: number, z: number) => number, split = false): { characters: SkinnedCharacter[]; material: PBRMaterial } {
  const material = new PBRMaterial("skinnedChar", scene);
  material.albedoColor = new Color3(0.85, 0.45, 0.2);
  material.metallic = 0;
  material.roughness = 0.6;
  const characters: SkinnedCharacter[] = [];
  for (let c = 0; c < count; c++) {
    const mesh = characterMesh(scene, `skinned${c}`, split);
    const skeleton = characterSkeleton(scene, `skeleton${c}`);
    mesh.skeleton = skeleton;
    mesh.material = material;
    mesh.receiveShadows = true;
    // Twice human size, so the limbs' shadows are wide enough to read at page scale.
    mesh.scaling.set(2, 2, 2);
    const phase = (c / Math.max(1, count)) * Math.PI * 2;
    const bones = skeleton.bones;
    const pose = (bone: number, x: number, y: number, z: number) => {
      const j = JOINTS[bone];
      const p = PARENT[bone];
      T.set(p < 0 ? j[0] : j[0] - JOINTS[p][0], p < 0 ? j[1] : j[1] - JOINTS[p][1], p < 0 ? j[2] : j[2] - JOINTS[p][2]);
      Quaternion.FromEulerAnglesToRef(x, y, z, Q);
      Matrix.ComposeToRef(ONE, Q, T, bones[bone].getLocalMatrix());
      bones[bone].markAsDirty();
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
