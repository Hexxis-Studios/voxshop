import * as THREE from 'three';
import type { VoxelData, VoxelWeight } from '../types';
import type { AnimationDef, AnimKeyframe, BoneDef, SkeletonDef } from '../utils/riggingConstants';
import { CONFIG } from '../utils/voxelConstants';

export interface RiggedMeshVoxelization {
  voxels: VoxelData[];
  skeleton: SkeletonDef;
  voxelSize: number;
}

type RigImportContext = {
  skeleton: SkeletonDef;
  namesByIndex: string[];
  nameByBone: Map<THREE.Bone, string>;
  rootName: string;
};

type MeshVoxelization = { voxels: VoxelData[] | null; voxelSize: number; skeleton: SkeletonDef | null };

const near = (a: number, b: number, epsilon = 1e-4) => Math.abs(a - b) <= epsilon;
const cleanZero = (value: number) => (Object.is(value, -0) ? 0 : value);

function importedId(source: string, fallback: string, used: Set<string>) {
  let id = source
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 64);
  if (!id) id = fallback;
  let unique = id;
  let suffix = 2;
  while (used.has(unique)) {
    const tail = `_${suffix++}`;
    unique = `${id.slice(0, 64 - tail.length)}${tail}`;
  }
  used.add(unique);
  return unique;
}

function decompose(matrix: THREE.Matrix4, label: string) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  if (![...position.toArray(), ...quaternion.toArray(), ...scale.toArray()].every(Number.isFinite))
    throw new Error(`Rig import found a non-finite ${label} transform.`);
  if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0 || !near(scale.x, scale.y) || !near(scale.x, scale.z))
    throw new Error(`Rig import cannot preserve non-uniform or negative scale on ${label}.`);
  return { position, quaternion: quaternion.normalize(), scale };
}

function createRigImportContext(
  object: THREE.Object3D,
  clips: THREE.AnimationClip[],
  box: THREE.Box3,
  voxelSize: number,
  centered: { x: number; z: number; yFloor: number },
): RigImportContext | null {
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  object.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes.push(child as THREE.SkinnedMesh);
  });
  if (!skinnedMeshes.length) {
    if (clips.length) throw new Error('This file has animation clips but no skinned rig to preserve.');
    return null;
  }
  if (clips.length > 64) throw new Error('Rig import supports at most 64 animation clips.');
  const sourceSkeleton = skinnedMeshes[0].skeleton;
  if (!sourceSkeleton?.bones.length) throw new Error('Rig import found no bones in the skin.');
  if (sourceSkeleton.bones.length > 128) throw new Error('Rig import supports at most 128 bones.');
  if (skinnedMeshes.some((mesh) => mesh.skeleton !== sourceSkeleton))
    throw new Error('Rig import requires all skinned meshes to use one shared skeleton.');
  for (const mesh of skinnedMeshes) {
    if (!mesh.geometry.attributes.skinIndex || !mesh.geometry.attributes.skinWeight)
      throw new Error('Rig import needs skin indices and weights on every skinned mesh.');
    decompose(mesh.matrixWorld, `skinned mesh "${mesh.name || mesh.uuid}"`);
    mesh.skeleton.update();
  }
  const constrainedNodes: THREE.Object3D[] = [];
  object.traverse((child) => {
    if (child.userData?.constraints || child.userData?.ikConstraints) constrainedNodes.push(child);
  });
  if (constrainedNodes.length) {
    const constrainedNode = constrainedNodes[0];
    throw new Error(
      `Rig import cannot preserve constraints on "${constrainedNode.name || constrainedNode.uuid}".`,
    );
  }

  const used = new Set<string>();
  const namesByIndex = sourceSkeleton.bones.map((bone, index) =>
    importedId(bone.name, `bone_${index + 1}`, used),
  );
  const nameByBone = new Map<THREE.Bone, string>();
  sourceSkeleton.bones.forEach((bone, index) => {
    nameByBone.set(bone, namesByIndex[index]);
  });
  const boneSet = new Set(sourceSkeleton.bones);
  const bones: BoneDef[] = sourceSkeleton.bones.map((bone, index) => {
    const matrix = decompose(bone.matrixWorld, `bone "${bone.name || index}"`);
    if (bone.userData?.constraints || bone.userData?.ikConstraints)
      throw new Error(`Rig import cannot preserve constraints on bone "${bone.name || index}".`);
    let parentObject = bone.parent;
    let parentBone: THREE.Bone | null = null;
    while (parentObject) {
      if (boneSet.has(parentObject as THREE.Bone)) {
        parentBone = parentObject as THREE.Bone;
        break;
      }
      parentObject = parentObject.parent;
    }
    const parentWorld = parentBone
      ? decompose(parentBone.matrixWorld, `parent bone "${parentBone.name}"`)
      : null;
    const parentRotation = parentWorld?.quaternion ?? new THREE.Quaternion();
    const localPosition = parentWorld
      ? matrix.position
          .clone()
          .sub(parentWorld.position)
          .applyQuaternion(parentRotation.clone().invert())
          .divideScalar(voxelSize)
      : new THREE.Vector3(
          (matrix.position.x - box.min.x) / voxelSize - 0.5 - centered.x,
          (matrix.position.y - box.min.y) / voxelSize - 0.5 + centered.yFloor,
          (matrix.position.z - box.min.z) / voxelSize - 0.5 - centered.z,
        );
    const localRotation = parentRotation.clone().invert().multiply(matrix.quaternion).normalize();
    if (
      ![localPosition.x, localPosition.y, localPosition.z].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 100_000,
      )
    )
      throw new Error(`Rig import found an out-of-range bind position on "${bone.name || index}".`);
    const localParent = parentBone ?? bone.parent;
    const localMatrix = (localParent?.matrixWorld ?? new THREE.Matrix4())
      .clone()
      .invert()
      .multiply(bone.matrixWorld);
    const localScale = new THREE.Vector3();
    localMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), localScale);
    if (!near(localScale.x, 1) || !near(localScale.y, 1) || !near(localScale.z, 1))
      throw new Error(`Rig import cannot preserve local bone scale on "${bone.name || index}".`);
    const localEuler = new THREE.Euler().setFromQuaternion(localRotation);
    return {
      name: namesByIndex[index],
      parent: parentBone ? nameByBone.get(parentBone)! : null,
      pivotType: 'center',
      color: '#ffffff',
      bindPosition: [cleanZero(localPosition.x), cleanZero(localPosition.y), cleanZero(localPosition.z)],
      bindRotation: [cleanZero(localEuler.x), cleanZero(localEuler.y), cleanZero(localEuler.z)],
    };
  });
  const rootName = bones.find((bone) => bone.parent === null)?.name;
  if (!rootName) throw new Error('Rig import could not find a root bone.');
  const candidateNames = new Map<string, string[]>();
  sourceSkeleton.bones.forEach((bone, index) => {
    for (const key of [bone.name, bone.uuid]) {
      const matches = candidateNames.get(key) ?? [];
      matches.push(namesByIndex[index]);
      candidateNames.set(key, matches);
    }
  });

  const animationNames = new Set<string>();
  const animations: AnimationDef[] = [];
  for (const clip of clips) {
    if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 3600)
      throw new Error(`Animation "${clip.name || 'unnamed'}" has an unsupported duration.`);
    const clipName = importedId(clip.name, `animation_${animations.length + 1}`, animationNames);
    const clipTracks = new Map<string, { position?: THREE.KeyframeTrack; rotation?: THREE.KeyframeTrack }>();
    for (const track of clip.tracks) {
      let binding: ReturnType<typeof THREE.PropertyBinding.parseTrackName>;
      try {
        binding = THREE.PropertyBinding.parseTrackName(track.name);
      } catch {
        throw new Error(`Animation "${clipName}" contains an unsupported track "${track.name}".`);
      }
      const sourceName = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
      const matches = sourceName ? (candidateNames.get(sourceName) ?? []) : [];
      if (matches.length !== 1)
        throw new Error(`Animation "${clipName}" targets a missing or ambiguous rig node "${track.name}".`);
      const joint = matches[0];
      if (binding.propertyName === 'scale') {
        if (Array.from(track.values).some((value) => !near(value, 1)))
          throw new Error(`Animation "${clipName}" changes bone scale, which VoxShop cannot preserve.`);
        continue;
      }
      const channel =
        binding.propertyName === 'position'
          ? 'position'
          : binding.propertyName === 'quaternion' || binding.propertyName === 'rotation'
            ? 'rotation'
            : null;
      if (!channel)
        throw new Error(`Animation "${clipName}" uses unsupported bone property "${binding.propertyName}".`);
      const entries = clipTracks.get(joint) ?? {};
      if (entries[channel])
        throw new Error(`Animation "${clipName}" has duplicate ${channel} tracks for "${joint}".`);
      if (track.times.length > 2048)
        throw new Error(`Animation "${clipName}" exceeds 2,048 keys on "${joint}".`);
      if (
        !track.times.length ||
        Array.from(track.times).some(
          (time) => !Number.isFinite(time) || time < 0 || time > clip.duration + 1e-3,
        )
      )
        throw new Error(`Animation "${clipName}" has invalid key times.`);
      const interpolant = (track as any).createInterpolant();
      if (interpolant.constructor.name.toLowerCase().includes('cubic'))
        throw new Error(
          `Animation "${clipName}" uses cubic spline interpolation, which VoxShop cannot preserve exactly.`,
        );
      const times = Array.from(track.times);
      if (
        track.values.length !== track.times.length * track.getValueSize() ||
        !Array.from(track.values).every(Number.isFinite) ||
        times.some((time, index) => index > 0 && time <= times[index - 1])
      )
        throw new Error(`Animation "${clipName}" has malformed track values.`);
      const mode = track.getInterpolation();
      if (mode !== THREE.InterpolateLinear && mode !== THREE.InterpolateDiscrete)
        throw new Error(`Animation "${clipName}" uses unsupported interpolation.`);
      entries[channel] = track;
      clipTracks.set(joint, entries);
    }

    const tracks: Record<string, AnimKeyframe[]> = {};
    for (const [joint, channels] of clipTracks) {
      const positionTrack = channels.position;
      const rotationTrack = channels.rotation;
      const positionMode = positionTrack?.getInterpolation();
      const rotationMode = rotationTrack?.getInterpolation();
      if (positionMode !== undefined && rotationMode !== undefined && positionMode !== rotationMode)
        throw new Error(
          `Animation "${clipName}" uses different interpolation for position and rotation on "${joint}".`,
        );
      const sourceBone = sourceSkeleton.bones[namesByIndex.indexOf(joint)];
      const parentMatrix = sourceBone.parent?.matrixWorld ?? new THREE.Matrix4();
      const parentMatrix3 = new THREE.Matrix3().setFromMatrix4(parentMatrix);
      let rigParent = sourceBone.parent;
      while (rigParent && !nameByBone.has(rigParent as THREE.Bone)) rigParent = rigParent.parent;
      const inverseRigParentRotation = rigParent
        ? decompose(rigParent.matrixWorld, `parent bone "${rigParent.name}"`).quaternion.invert()
        : null;
      const restRotation = sourceBone.quaternion.clone();
      const inverseRestRotation = restRotation.clone().invert();
      const times = [...new Set([...(positionTrack?.times ?? []), ...(rotationTrack?.times ?? [])])].sort(
        (a, b) => a - b,
      );
      if (times.length > 2048) throw new Error(`Animation "${clipName}" exceeds 2,048 keys on "${joint}".`);
      const positionInterpolant = (positionTrack as any)?.createInterpolant();
      const rotationInterpolant = (rotationTrack as any)?.createInterpolant();
      tracks[joint] = times.map((time): AnimKeyframe => {
        const frame: AnimKeyframe = { time };
        if (positionInterpolant && positionTrack) {
          const sample = positionInterpolant.evaluate(time);
          const parentDirection = new THREE.Vector3(
            sample[0] - sourceBone.position.x,
            sample[1] - sourceBone.position.y,
            sample[2] - sourceBone.position.z,
          ).applyMatrix3(parentMatrix3);
          if (inverseRigParentRotation) parentDirection.applyQuaternion(inverseRigParentRotation);
          frame.pos = [
            cleanZero(parentDirection.x / voxelSize),
            cleanZero(parentDirection.y / voxelSize),
            cleanZero(parentDirection.z / voxelSize),
          ];
          if (frame.pos.some((value) => !Number.isFinite(value) || Math.abs(value) > 100_000))
            throw new Error(`Animation "${clipName}" has an out-of-range translation on "${joint}".`);
        }
        if (rotationInterpolant && rotationTrack) {
          const sample = rotationInterpolant.evaluate(time);
          const target =
            rotationTrack.ValueTypeName === 'quaternion'
              ? new THREE.Quaternion(sample[0], sample[1], sample[2], sample[3]).normalize()
              : new THREE.Quaternion().setFromEuler(new THREE.Euler(sample[0], sample[1], sample[2]));
          const delta = inverseRestRotation.clone().multiply(target).normalize();
          const euler = new THREE.Euler().setFromQuaternion(delta);
          frame.rot = [cleanZero(euler.x), cleanZero(euler.y), cleanZero(euler.z)];
        }
        const mode = positionMode ?? rotationMode;
        if (mode === THREE.InterpolateDiscrete) frame.interpolation = 'step';
        return frame;
      });
    }
    if (!Object.keys(tracks).length) throw new Error(`Animation "${clipName}" has no supported rig tracks.`);
    animations.push({ name: clipName, duration: clip.duration, tracks });
  }

  return {
    skeleton: { id: 'imported', name: 'Imported rig', bones, animations },
    namesByIndex,
    nameByBone,
    rootName,
  };
}

/** Converts mesh surfaces to voxels in world space. Null means the source has no spatial extent. */
export function voxelizeMesh(object: THREE.Object3D, resolution: number | null = null): VoxelData[] | null {
  return voxelizeMeshWithMetadata(object, resolution)?.voxels ?? null;
}

export function voxelizeMeshWithMetadata(
  object: THREE.Object3D,
  resolution: number | null = null,
): { voxels: VoxelData[] | null; voxelSize: number } | null {
  const result = voxelizeMeshInternal(object, resolution, [], false);
  return result ? { voxels: result.voxels, voxelSize: result.voxelSize } : null;
}

/** Voxelizes a skinned mesh in its current bind pose and keeps supported skinning and clips. */
export function voxelizeMeshWithRig(
  object: THREE.Object3D,
  resolution: number | null = null,
  clips: THREE.AnimationClip[] = [],
): RiggedMeshVoxelization | null {
  const result = voxelizeMeshInternal(object, resolution, clips, true);
  if (!result?.skeleton || !result.voxels) return null;
  return { voxels: result.voxels, skeleton: result.skeleton, voxelSize: result.voxelSize };
}

function triangleSkinWeights(
  mesh: THREE.SkinnedMesh,
  vertexIndices: [number, number, number],
  barycentric: THREE.Vector3,
  namesByIndex: string[],
): VoxelWeight[] {
  const skinIndices = mesh.geometry.attributes.skinIndex;
  const skinWeights = mesh.geometry.attributes.skinWeight;
  const accumulated = new Map<string, number>();
  const barycentricWeights = [barycentric.x, barycentric.y, barycentric.z];
  for (let vertex = 0; vertex < 3; vertex++) {
    for (let slot = 0; slot < 4; slot++) {
      if (slot >= skinIndices.itemSize || slot >= skinWeights.itemSize) break;
      const boneIndex = skinIndices.getComponent(vertexIndices[vertex], slot);
      const weight = skinWeights.getComponent(vertexIndices[vertex], slot);
      if (!Number.isFinite(boneIndex) || !Number.isFinite(weight) || weight < 0)
        throw new Error('Rig import found an invalid skin weight.');
      if (weight === 0) continue;
      if (!Number.isInteger(boneIndex) || boneIndex < 0 || boneIndex >= namesByIndex.length)
        throw new Error('Rig import found a skin index outside its skeleton.');
      const name = namesByIndex[boneIndex];
      accumulated.set(name, (accumulated.get(name) ?? 0) + barycentricWeights[vertex] * weight);
    }
  }
  const sorted = [...accumulated]
    .filter(([, weight]) => weight > 1e-8)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4);
  const total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 1e-8)
    throw new Error('Rig import found a voxel with no usable skin weights.');
  return sorted.map(([bone, weight]) => ({ bone, weight: weight / total }));
}

function poseSkinnedMeshesAtBindPose(object: THREE.Object3D) {
  const meshes: THREE.SkinnedMesh[] = [];
  object.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(child as THREE.SkinnedMesh);
  });
  if (!meshes.length) return;
  const skeleton = meshes[0].skeleton;
  if (meshes.some((mesh) => mesh.skeleton !== skeleton))
    throw new Error('Rig import requires all skinned meshes to use one shared skeleton.');
  object.updateMatrixWorld(true);
  const bindWorld = new Map<THREE.Bone, THREE.Matrix4>();
  skeleton.bones.forEach((bone, index) => {
    const inverse = skeleton.boneInverses[index];
    if (!inverse) throw new Error(`Rig import is missing the bind transform for bone "${bone.name}".`);
    bindWorld.set(bone, inverse.clone().invert());
  });
  const worldAtBindPose = new Map<THREE.Object3D, THREE.Matrix4>();
  const getWorldAtBindPose = (node: THREE.Object3D): THREE.Matrix4 => {
    const bind = bindWorld.get(node as THREE.Bone);
    if (bind) return bind;
    const cached = worldAtBindPose.get(node);
    if (cached) return cached;
    if (node.matrixAutoUpdate) node.updateMatrix();
    const world = node.parent
      ? getWorldAtBindPose(node.parent).clone().multiply(node.matrix)
      : node.matrix.clone();
    worldAtBindPose.set(node, world);
    return world;
  };
  for (const bone of skeleton.bones) {
    const parentWorld = bone.parent ? getWorldAtBindPose(bone.parent) : new THREE.Matrix4();
    const local = parentWorld.clone().invert().multiply(bindWorld.get(bone)!);
    local.decompose(bone.position, bone.quaternion, bone.scale);
    bone.matrixAutoUpdate = true;
    bone.updateMatrix();
  }
  object.updateMatrixWorld(true);
  skeleton.update();
}

function voxelizeMeshInternal(
  object: THREE.Object3D,
  resolution: number | null,
  clips: THREE.AnimationClip[],
  keepRig: boolean,
): MeshVoxelization | null {
  if (keepRig) poseSkinnedMeshesAtBindPose(object);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  object.traverse((child) => {
    if (!(child as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mesh = child as THREE.SkinnedMesh;
    mesh.skeleton.update();
    mesh.computeBoundingBox();
    if (mesh.boundingBox) box.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim === 0) return { voxels: null, voxelSize: 0, skeleton: null };
  const res = resolution ?? Math.max(16, Math.min(96, Math.round(maxDim)));
  const voxelWorldSize = maxDim / res;
  if (!Number.isFinite(voxelWorldSize) || voxelWorldSize < 0.001 || voxelWorldSize > 100)
    throw new Error('Mesh import voxel size must be between 0.001 and 100 meters.');
  const half = voxelWorldSize * 0.5;
  const nxHalf = Math.round(size.x / voxelWorldSize / 2);
  const nzHalf = Math.round(size.z / voxelWorldSize / 2);
  const yFloor = CONFIG.FLOOR_Y + 1;
  const rigContext = keepRig
    ? createRigImportContext(object, clips, box, voxelWorldSize, { x: nxHalf, z: nzHalf, yFloor })
    : null;

  const texCache = new Map<string, ImageData | null>();
  const getTexData = (tex: THREE.Texture | null | undefined): ImageData | null => {
    if (!tex?.image) return null;
    if (texCache.has(tex.uuid)) return texCache.get(tex.uuid)!;
    try {
      const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
      const w = (img as any).naturalWidth || (img as any).width || 1;
      const h = (img as any).naturalHeight || (img as any).height || 1;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d')!;
      context.drawImage(img as any, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h);
      texCache.set(tex.uuid, data);
      return data;
    } catch {
      texCache.set(tex.uuid, null);
      return null;
    }
  };
  const sampleTex = (data: ImageData, u: number, v: number): number => {
    const { width: w, height: h } = data;
    const uw = ((u % 1) + 1) % 1;
    const vw = ((v % 1) + 1) % 1;
    const px = Math.min(w - 1, Math.max(0, Math.floor(uw * w)));
    const py = Math.min(h - 1, Math.max(0, Math.floor((1 - vw) * h)));
    const i = (py * w + px) * 4;
    return (data.data[i] << 16) | (data.data[i + 1] << 8) | data.data[i + 2];
  };

  const voxelMap = new Map<string, number>();
  const rigWeightMap = new Map<string, { distance: number; weights: VoxelWeight[] }>();
  let cellTests = 0;
  const pA = new THREE.Vector3(),
    pB = new THREE.Vector3(),
    pC = new THREE.Vector3();
  const tri = new THREE.Triangle();
  const voxelBox = new THREE.Box3();
  const closest = new THREE.Vector3();
  const barycentric = new THREE.Vector3();

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geo = child.geometry as THREE.BufferGeometry;
    if (!geo.attributes.position) return;

    child.updateWorldMatrix(true, false);
    const matrix = child.matrixWorld;
    const posAttr = geo.attributes.position;
    const colorAttr = geo.attributes.color;
    const uvAttr = geo.attributes.uv;
    const indexAttr = geo.index;
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
    const skinnedMesh = (child as THREE.SkinnedMesh).isSkinnedMesh ? (child as THREE.SkinnedMesh) : null;
    skinnedMesh?.skeleton.update();

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const getWorldVert = (i: number, out: THREE.Vector3): THREE.Vector3 =>
      skinnedMesh
        ? skinnedMesh.getVertexPosition(i, out).applyMatrix4(matrix)
        : out.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(matrix);

    const groupForFace: number[] = [];
    if (geo.groups.length > 0) {
      for (const group of geo.groups) {
        const faceStart = group.start / 3,
          faceEnd = faceStart + group.count / 3;
        for (let face = faceStart; face < faceEnd; face++) groupForFace[face] = group.materialIndex ?? 0;
      }
    }
    const texDataCache: (ImageData | null)[] = materials.map((material) =>
      getTexData((material as THREE.MeshStandardMaterial)?.map),
    );
    const matColors: number[] = materials.map((material) => (material as any)?.color?.getHex?.() ?? 0xcccccc);

    for (let t = 0; t < triCount; t++) {
      const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
      const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

      getWorldVert(i0, pA);
      getWorldVert(i1, pB);
      getWorldVert(i2, pC);
      tri.set(pA, pB, pC);

      const matIdx = groupForFace[t] ?? 0;
      const texData = texDataCache[matIdx] ?? null;
      const matColor = matColors[matIdx] ?? 0xcccccc;

      let color: number;
      if (texData && uvAttr) {
        const u = (uvAttr.getX(i0) + uvAttr.getX(i1) + uvAttr.getX(i2)) / 3;
        const v = (uvAttr.getY(i0) + uvAttr.getY(i1) + uvAttr.getY(i2)) / 3;
        color = sampleTex(texData, u, v);
        if (matColor !== 0xffffff && matColor !== 0xcccccc) {
          const mr = (matColor >> 16) & 0xff,
            mg = (matColor >> 8) & 0xff,
            mb = matColor & 0xff;
          const tr = (color >> 16) & 0xff,
            tg = (color >> 8) & 0xff,
            tb = color & 0xff;
          color =
            (Math.round((tr * mr) / 255) << 16) |
            (Math.round((tg * mg) / 255) << 8) |
            Math.round((tb * mb) / 255);
        }
      } else if (colorAttr) {
        const r = (colorAttr.getX(i0) + colorAttr.getX(i1) + colorAttr.getX(i2)) / 3;
        const g = (colorAttr.getY(i0) + colorAttr.getY(i1) + colorAttr.getY(i2)) / 3;
        const b = (colorAttr.getZ(i0) + colorAttr.getZ(i1) + colorAttr.getZ(i2)) / 3;
        color = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
      } else {
        color = matColor;
      }

      const txMin = Math.min(pA.x, pB.x, pC.x),
        txMax = Math.max(pA.x, pB.x, pC.x);
      const tyMin = Math.min(pA.y, pB.y, pC.y),
        tyMax = Math.max(pA.y, pB.y, pC.y);
      const tzMin = Math.min(pA.z, pB.z, pC.z),
        tzMax = Math.max(pA.z, pB.z, pC.z);

      const ixMin = Math.max(0, Math.floor((txMin - box.min.x) / voxelWorldSize));
      const ixMax = Math.min(res, Math.ceil((txMax - box.min.x) / voxelWorldSize));
      const iyMin = Math.max(0, Math.floor((tyMin - box.min.y) / voxelWorldSize));
      const iyMax = Math.min(res, Math.ceil((tyMax - box.min.y) / voxelWorldSize));
      const izMin = Math.max(0, Math.floor((tzMin - box.min.z) / voxelWorldSize));
      const izMax = Math.min(res, Math.ceil((tzMax - box.min.z) / voxelWorldSize));

      for (let ix = ixMin; ix <= ixMax; ix++) {
        for (let iy = iyMin; iy <= iyMax; iy++) {
          for (let iz = izMin; iz <= izMax; iz++) {
            if (++cellTests > 50_000_000)
              throw new Error(
                'Mesh conversion exceeded its work budget. Use a simpler mesh or lower resolution.',
              );
            const vcx = box.min.x + (ix + 0.5) * voxelWorldSize;
            const vcy = box.min.y + (iy + 0.5) * voxelWorldSize;
            const vcz = box.min.z + (iz + 0.5) * voxelWorldSize;
            voxelBox.min.set(vcx - half, vcy - half, vcz - half);
            voxelBox.max.set(vcx + half, vcy + half, vcz + half);
            if (tri.intersectsBox(voxelBox)) {
              const key = `${ix},${iy},${iz}`;
              if (!voxelMap.has(key)) voxelMap.set(key, color);
              if (rigContext) {
                const center = voxelBox.getCenter(new THREE.Vector3());
                tri.closestPointToPoint(center, closest);
                const distance = center.distanceToSquared(closest);
                const previous = rigWeightMap.get(key);
                if (!previous || distance < previous.distance) {
                  tri.getBarycoord(closest, barycentric);
                  const weights = skinnedMesh
                    ? triangleSkinWeights(skinnedMesh, [i0, i1, i2], barycentric, rigContext.namesByIndex)
                    : [{ bone: rigContext.rootName, weight: 1 }];
                  rigWeightMap.set(key, { distance, weights });
                }
              }
              if (voxelMap.size > 250_000)
                throw new Error('Mesh conversion exceeds 250,000 voxels. Use a lower resolution.');
            }
          }
        }
      }
    }
  });

  const voxels = Array.from(voxelMap.entries()).map(([key, color]) => {
    const [ix, iy, iz] = key.split(',').map(Number);
    const voxel: VoxelData = { x: ix - nxHalf, y: iy + yFloor, z: iz - nzHalf, color };
    const weights = rigWeightMap.get(key)?.weights;
    if (weights?.length) {
      voxel.weights = weights;
      voxel.bone = weights[0].bone;
    }
    return voxel;
  });
  return { voxels, voxelSize: voxelWorldSize, skeleton: rigContext?.skeleton ?? null };
}
