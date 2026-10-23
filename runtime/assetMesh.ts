import * as THREE from 'three';
import type { Asset, SceneNode } from '../services/projectDocument';
import {
  createVoxelGeometry,
  createVoxelGeometryChunks,
  VOXEL_CHUNK_SIZE,
  VOXEL_MATERIALS,
} from './voxelGeometry';

export type AssetVisual = {
  group: THREE.Group;
  bones: Map<string, THREE.Bone>;
  animate: (clip: string, time: number, speed?: number, ignoredJoints?: ReadonlySet<string>) => void;
};
export const VOXEL_CHUNK_THRESHOLD = VOXEL_CHUNK_SIZE ** 3;
const rigidOpaqueAssets = new WeakMap<Asset, boolean>();
const chunkableAssets = new WeakMap<Asset, boolean>();
const instancedChunkAssets = new WeakMap<Asset, boolean>();
const voxelNeighbors: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
type RigData = NonNullable<Asset['rig']>;
type AnimationKey = RigData['clips'][number]['tracks'][number]['keys'][number];
type PreparedAnimation = {
  duration: number;
  loop: boolean;
  blendIn: number;
  tracks: { joint: string; keys: AnimationKey[] }[];
};
const preparedAnimations = new WeakMap<RigData, Map<string, PreparedAnimation>>();

function animatedRigBoundingSphere(asset: Asset, rig: RigData) {
  const joints = new Map(rig.joints.map((joint) => [joint.name, joint]));
  const largestClipOffset = new Map(rig.joints.map((joint) => [joint.name, 0]));
  for (const clip of rig.clips) {
    const clipOffsets = new Map<string, number>();
    for (const track of clip.tracks) {
      const largestKeyOffset = track.keys.reduce(
        (largest, key) => Math.max(largest, Math.hypot(...(key.position ?? [0, 0, 0]))),
        0,
      );
      clipOffsets.set(track.joint, (clipOffsets.get(track.joint) ?? 0) + largestKeyOffset);
    }
    for (const [joint, offset] of clipOffsets)
      largestClipOffset.set(joint, Math.max(largestClipOffset.get(joint) ?? 0, offset));
  }

  const motionFromRoot = new Map<string, number>();
  const jointMotion = (name: string): number => {
    const cached = motionFromRoot.get(name);
    if (cached !== undefined) return cached;
    const joint = joints.get(name);
    if (!joint) return 0;
    const value = (joint.parent ? jointMotion(joint.parent) : 0) + (largestClipOffset.get(name) ?? 0);
    motionFromRoot.set(name, value);
    return value;
  };

  const restPathFromRoot = new Map<string, number>();
  const jointRestPath = (name: string): number => {
    const cached = restPathFromRoot.get(name);
    if (cached !== undefined) return cached;
    const joint = joints.get(name);
    if (!joint) return 0;
    const parent = joint.parent ? joints.get(joint.parent) : undefined;
    const parentPosition = parent?.position ?? [0, 0, 0];
    const segmentLength = Math.hypot(
      joint.position[0] - parentPosition[0],
      joint.position[1] - parentPosition[1],
      joint.position[2] - parentPosition[2],
    );
    const value = (parent ? jointRestPath(parent.name) : 0) + segmentLength;
    restPathFromRoot.set(name, value);
    return value;
  };

  const jointRadiusBase = new Map(
    rig.joints.map((joint) => [joint.name, jointRestPath(joint.name) + jointMotion(joint.name)]),
  );
  let radius = 0;
  const jointNames = rig.joints.map((joint) => joint.name);
  const halfVoxelDiagonal = Math.sqrt(3) / 2;
  const includeJoint = (voxel: Asset['model']['voxels'][number], name: string) => {
    const joint = joints.get(name);
    if (!joint) return;
    const distanceToJoint = Math.hypot(
      voxel.x - joint.position[0],
      voxel.y - joint.position[1],
      voxel.z - joint.position[2],
    );
    radius = Math.max(radius, jointRadiusBase.get(joint.name)! + distanceToJoint + halfVoxelDiagonal);
  };
  for (const voxel of asset.model.voxels) {
    if (voxel.weights?.length) {
      for (const influence of voxel.weights) includeJoint(voxel, influence.bone);
    } else includeJoint(voxel, voxel.bone ?? jointNames[0]!);
  }
  return new THREE.Sphere(new THREE.Vector3(), radius);
}

function animationClips(rig: RigData) {
  let clips = preparedAnimations.get(rig);
  if (!clips) {
    clips = new Map(
      rig.clips.map((clip) => [
        clip.name.toLowerCase(),
        {
          duration: clip.duration,
          loop: clip.loop,
          blendIn: clip.blendIn ?? 0.12,
          tracks: clip.tracks.map((track) => ({
            joint: track.joint,
            keys: track.keys.slice().sort((a, b) => a.time - b.time),
          })),
        } satisfies PreparedAnimation,
      ]),
    );
    preparedAnimations.set(rig, clips);
  }
  return clips;
}

function animationKeyPair(keys: AnimationKey[], time: number): [AnimationKey, AnimationKey] {
  let low = 0,
    high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle].time < time) low = middle + 1;
    else high = middle;
  }
  const right = Math.min(low, keys.length - 1);
  return [keys[Math.max(0, right - 1)], keys[right]];
}

export function isRigidOpaqueAsset(asset: Asset) {
  const cached = rigidOpaqueAssets.get(asset);
  if (cached !== undefined) return cached;
  const eligible = !asset.rig && !asset.model.voxels.some((v) => v.materialType === 'GLASS');
  rigidOpaqueAssets.set(asset, eligible);
  return eligible;
}

export function shouldChunkAsset(asset: Asset) {
  const cached = chunkableAssets.get(asset);
  if (cached !== undefined) return cached;
  const chunkable = isRigidOpaqueAsset(asset) && asset.model.voxels.length > VOXEL_CHUNK_THRESHOLD;
  chunkableAssets.set(asset, chunkable);
  return chunkable;
}

function shouldInstanceChunkedAsset(asset: Asset) {
  const cached = instancedChunkAssets.get(asset);
  if (cached !== undefined) return cached;
  const voxels = asset.model.voxels;
  const occupied = new Set(voxels.map(({ x, y, z }) => `${x},${y},${z}`));
  let exposedFaces = 0;
  for (const voxel of voxels)
    for (const [dx, dy, dz] of voxelNeighbors)
      if (!occupied.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)) exposedFaces++;
  // One indexed quad is at most 168 CPU bytes; an instance needs a matrix and color (76 bytes).
  const useInstances = exposedFaces * 168 > voxels.length * 76;
  instancedChunkAssets.set(asset, useInstances);
  return useInstances;
}

export function createVoxelMaterials() {
  return VOXEL_MATERIALS.map((m) => {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: m === 'METALLIC' ? 0.3 : 0.85,
      metalness: m === 'METALLIC' ? 0.8 : 0,
      transparent: m === 'GLASS',
      opacity: m === 'GLASS' ? 0.5 : 1,
      emissive: m === 'EMISSIVE' ? 0xffffff : 0,
      emissiveIntensity: m === 'EMISSIVE' ? 0.35 : 0,
      side: THREE.FrontSide,
    });
    if (m === 'EMISSIVE')
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= diffuseColor.rgb;',
        );
      };
    return material;
  });
}

function createChunkedAssetVisual(asset: Asset): AssetVisual {
  if (shouldInstanceChunkedAsset(asset)) return createInstancedChunkedAssetVisual(asset);
  const group = new THREE.Group(),
    chunks = createVoxelGeometryChunks(asset, [], VOXEL_CHUNK_SIZE),
    materials = createVoxelMaterials();
  for (const chunk of chunks) {
    const mesh = new THREE.Mesh(chunk.geometry, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.scale.setScalar(asset.voxelSize);
    mesh.position.set(
      (chunk.origin[0] - asset.pivot[0]) * asset.voxelSize,
      (chunk.origin[1] - asset.pivot[1]) * asset.voxelSize,
      (chunk.origin[2] - asset.pivot[2]) * asset.voxelSize,
    );
    mesh.userData.voxelChunk = true;
    group.add(mesh);
  }
  group.userData.voxelChunkCount = chunks.length;
  group.userData.voxelRepresentation = 'greedy-mesh';
  return { group, bones: new Map(), animate: () => {} };
}

function createInstancedChunkedAssetVisual(asset: Asset): AssetVisual {
  type Chunk = { origin: [number, number, number]; materials: Map<string, Asset['model']['voxels']> };
  const chunks = new Map<string, Chunk>();
  for (const voxel of asset.model.voxels) {
    const coordinates: [number, number, number] = [
      Math.floor(voxel.x / VOXEL_CHUNK_SIZE),
      Math.floor(voxel.y / VOXEL_CHUNK_SIZE),
      Math.floor(voxel.z / VOXEL_CHUNK_SIZE),
    ];
    const key = coordinates.join(',');
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = {
        origin: coordinates.map((coordinate) => coordinate * VOXEL_CHUNK_SIZE) as [number, number, number],
        materials: new Map(),
      };
      chunks.set(key, chunk);
    }
    const material = voxel.materialType ?? 'STANDARD';
    let voxels = chunk.materials.get(material);
    if (!voxels) chunk.materials.set(material, (voxels = []));
    voxels.push(voxel);
  }

  const group = new THREE.Group();
  const materials = createVoxelMaterials();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(24 * 3).fill(1), 3));
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  let instanceCount = 0;
  for (const chunk of chunks.values()) {
    for (const [materialType, voxels] of chunk.materials) {
      const materialIndex = VOXEL_MATERIALS.indexOf(materialType);
      const mesh = new THREE.InstancedMesh(geometry, materials[materialIndex], voxels.length);
      for (let index = 0; index < voxels.length; index++) {
        const voxel = voxels[index];
        transform.position.set(
          voxel.x - chunk.origin[0],
          voxel.y - chunk.origin[1],
          voxel.z - chunk.origin[2],
        );
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
        mesh.setColorAt(index, color.set(voxel.color));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.scale.setScalar(asset.voxelSize);
      mesh.position.set(
        (chunk.origin[0] - asset.pivot[0]) * asset.voxelSize,
        (chunk.origin[1] - asset.pivot[1]) * asset.voxelSize,
        (chunk.origin[2] - asset.pivot[2]) * asset.voxelSize,
      );
      mesh.userData.voxelChunk = true;
      mesh.userData.voxelMaterial = materialType;
      group.add(mesh);
      instanceCount += voxels.length;
    }
  }
  group.userData.voxelChunkCount = chunks.size;
  group.userData.voxelInstanceCount = instanceCount;
  group.userData.voxelRepresentation = 'instanced-cubes';
  return { group, bones: new Map(), animate: () => {} };
}

export function createAssetVisual(asset: Asset, hiddenBones: string[] = []): AssetVisual {
  const group = new THREE.Group(),
    bones = new Map<string, THREE.Bone>();
  const rig = asset.rig;
  const allBones: THREE.Bone[] = [];
  const restPositions = new Map<string, [number, number, number]>();
  const restRotations = new Map<string, THREE.Quaternion>();
  if (rig) {
    for (const j of rig.joints) {
      const b = new THREE.Bone();
      b.name = j.name;
      const p = j.parent ? rig.joints.find((p) => p.name === j.parent)!.position : [0, 0, 0];
      const rest = j.position.map((n, i) => n - p[i]) as [number, number, number];
      restPositions.set(j.name, rest);
      b.position.set(...rest);
      b.rotation.set(...j.rotation);
      restRotations.set(j.name, b.quaternion.clone());
      bones.set(j.name, b);
      allBones.push(b);
    }
    for (const j of rig.joints) if (j.parent) bones.get(j.parent)!.add(bones.get(j.name)!);
  }
  const geom = createVoxelGeometry(asset, hiddenBones);
  geom.computeBoundingBox();
  if (geom.boundingBox && !geom.boundingBox.isEmpty()) {
    const bounds = geom.boundingBox.clone(),
      pivot = new THREE.Vector3(...asset.pivot);
    bounds.min.sub(pivot).multiplyScalar(asset.voxelSize);
    bounds.max.sub(pivot).multiplyScalar(asset.voxelSize);
    group.userData.assetBounds = bounds;
  }
  const mats = createVoxelMaterials();
  let mesh: THREE.Mesh;
  if (rig) {
    const skinned = new THREE.SkinnedMesh(geom, mats);
    for (const j of rig.joints) if (!j.parent) skinned.add(bones.get(j.name)!);
    skinned.updateMatrixWorld(true);
    skinned.bind(new THREE.Skeleton(allBones));
    skinned.boundingSphere = animatedRigBoundingSphere(asset, rig);
    mesh = skinned;
  } else mesh = new THREE.Mesh(geom, mats);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.scale.setScalar(asset.voxelSize);
  mesh.position.set(
    -asset.pivot[0] * asset.voxelSize,
    -asset.pivot[1] * asset.voxelSize,
    -asset.pivot[2] * asset.voxelSize,
  );
  group.add(mesh);
  const animationStart = new THREE.Quaternion(),
    animationEnd = new THREE.Quaternion(),
    animationDelta = new THREE.Quaternion();
  const poseFrom = new Map(
    rig?.joints.map((joint) => [
      joint.name,
      { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    ]) ?? [],
  );
  let activeClip: string | undefined;
  let activeBlendIn = 0;
  const animate = (clip: string, time: number, speed = 1, ignoredJoints?: ReadonlySet<string>) => {
    if (!rig) return;
    const key = clip.toLowerCase();
    const animation = animationClips(rig).get(key);
    if (key !== activeClip) {
      for (const joint of rig.joints) {
        const bone = bones.get(joint.name)!;
        const pose = poseFrom.get(joint.name)!;
        pose.position.copy(bone.position);
        pose.quaternion.copy(bone.quaternion);
      }
      activeClip = key;
      activeBlendIn = animation?.blendIn ?? 0;
    }
    for (const j of rig.joints) {
      if (ignoredJoints?.has(j.name)) continue;
      const b = bones.get(j.name)!;
      b.quaternion.copy(restRotations.get(j.name)!);
      b.position.set(...restPositions.get(j.name)!);
    }
    if (!animation) return;
    const t = animation.loop
      ? (time * speed) % animation.duration
      : Math.min(animation.duration, time * speed);
    for (const track of animation.tracks) {
      if (ignoredJoints?.has(track.joint)) continue;
      const bone = bones.get(track.joint);
      if (!bone || !track.keys.length) continue;
      const [a, b] = animationKeyPair(track.keys, t);
      let alpha = Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time || 1)));
      if (a.interpolation === 'step') alpha = 0;
      else if (a.interpolation === 'smooth') alpha = alpha * alpha * (3 - 2 * alpha);
      animationStart.setFromEuler(new THREE.Euler(...a.rotation));
      animationEnd.setFromEuler(new THREE.Euler(...b.rotation));
      bone.quaternion
        .copy(restRotations.get(track.joint)!)
        .multiply(animationDelta.slerpQuaternions(animationStart, animationEnd, alpha));
      if (a.position || b.position) {
        const p = a.position ?? [0, 0, 0],
          q = b.position ?? [0, 0, 0];
        bone.position.x += p[0] + (q[0] - p[0]) * alpha;
        bone.position.y += p[1] + (q[1] - p[1]) * alpha;
        bone.position.z += p[2] + (q[2] - p[2]) * alpha;
      }
    }
    if (activeBlendIn > 0) {
      const phase = Math.max(0, Math.min(1, time / activeBlendIn));
      const blend = phase * phase * (3 - 2 * phase);
      if (blend < 1) {
        for (const joint of rig.joints) {
          if (ignoredJoints?.has(joint.name)) continue;
          const bone = bones.get(joint.name)!;
          const from = poseFrom.get(joint.name)!;
          animationDelta.slerpQuaternions(from.quaternion, bone.quaternion, blend);
          bone.quaternion.copy(animationDelta);
          bone.position.lerpVectors(from.position, bone.position, blend);
        }
      }
    }
  };
  return { group, bones, animate };
}
export function createNodeVisual(node: SceneNode, assets: Map<string, Asset>): AssetVisual {
  const asset = node.assetId ? assets.get(node.assetId) : undefined;
  if (!asset) return { group: new THREE.Group(), bones: new Map(), animate: () => {} };
  const visual =
    shouldChunkAsset(asset) && !node.attachments.length
      ? createChunkedAssetVisual(asset)
      : createAssetVisual(
          asset,
          node.attachments.flatMap((a) => a.hiddenBones),
        );
  const wearables: { visual: AssetVisual; ignoredJoints: Set<string> }[] = [];
  const attachments: { asset: Asset; visual: AssetVisual }[] = [];
  for (const attachment of node.attachments) {
    const item = assets.get(attachment.assetId)!;
    const socket = asset.rig?.sockets.find((s) => s.name === attachment.socket);
    if (!socket) continue;
    const child = createAssetVisual(item);
    wearables.push({ visual: child, ignoredJoints: new Set() });
    attachments.push({ asset: item, visual: child });
    const anchor = new THREE.Group();
    anchor.position.set(...socket.transform.position);
    anchor.rotation.set(...socket.transform.rotation);
    anchor.scale.set(...socket.transform.scale);
    visual.bones.get(socket.joint)!.add(anchor);
    const adjustment = new THREE.Group();
    adjustment.position.set(
      ...(attachment.transform.position.map((n) => n / asset.voxelSize) as [number, number, number]),
    );
    adjustment.rotation.set(...attachment.transform.rotation);
    adjustment.scale.set(...attachment.transform.scale);
    anchor.add(adjustment);
    child.group.scale.multiplyScalar(1 / asset.voxelSize);
    adjustment.add(child.group);
  }
  mergeRiggedAttachments(visual, attachments, wearables, asset);
  const animate = visual.animate;
  return {
    ...visual,
    animate: (name, time, speed) => {
      animate(name, time, speed);
      for (const w of wearables) w.visual.animate(name, time, speed, w.ignoredJoints);
    },
  };
}

/** Merge compatible wearable joints into the character skeleton while keeping each gear mesh in place. */
function mergeRiggedAttachments(
  character: AssetVisual,
  attachments: { asset: Asset; visual: AssetVisual }[],
  wearables: { visual: AssetVisual; ignoredJoints: Set<string> }[],
  characterAsset: Asset,
) {
  const characterRig = characterAsset.rig;
  if (!characterRig || !attachments.length) return;
  let characterMesh: THREE.SkinnedMesh | undefined;
  character.group.traverse((object) => {
    if (!characterMesh && (object as THREE.SkinnedMesh).isSkinnedMesh)
      characterMesh = object as THREE.SkinnedMesh;
  });
  if (!characterMesh) return;

  const candidates = attachments.flatMap((attachment, index) => {
    const rig = attachment.asset.rig;
    if (!rig || rig.profile !== characterRig.profile) return [];
    const sharedJoints = new Set(
      rig.joints.map((joint) => joint.name).filter((name) => character.bones.has(name)),
    );
    if (!sharedJoints.size) return [];
    let mesh: THREE.SkinnedMesh | undefined;
    attachment.visual.group.traverse((object) => {
      if (!mesh && (object as THREE.SkinnedMesh).isSkinnedMesh) mesh = object as THREE.SkinnedMesh;
    });
    if (!mesh) return [];
    return [{ ...attachment, index, rig, mesh }];
  });
  if (!candidates.length) return;

  character.group.updateMatrixWorld(true);
  const mergedBones = characterMesh.skeleton.bones.slice();
  const wearableBoneIndices = new Map<number, Map<string, number>>();
  for (const candidate of candidates) {
    const jointIndices = new Map<string, number>();
    const ignoredJoints = wearables[candidate.index].ignoredJoints;
    for (const joint of candidate.rig.joints) {
      const bodyBone = character.bones.get(joint.name);
      const gearBone = candidate.visual.bones.get(joint.name);
      if (bodyBone) {
        jointIndices.set(joint.name, mergedBones.indexOf(bodyBone));
        ignoredJoints.add(joint.name);
        // Keep the gear rest hierarchy under the matching character pose. The duplicate gear bone
        // remains as a transform parent for gear-only descendants, but is not part of the union.
        bodyBone.attach(gearBone!);
      } else {
        jointIndices.set(joint.name, mergedBones.length);
        mergedBones.push(gearBone!);
      }
    }
    wearableBoneIndices.set(candidate.index, jointIndices);
  }
  character.group.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(mergedBones);
  // The union inverses were computed in the scaled world bind pose, unlike the
  // original mesh's voxel-space bind. Rebind both meshes in the same coordinate frame.
  characterMesh.bind(skeleton, characterMesh.matrixWorld.clone());
  for (const candidate of candidates) {
    const jointIndices = wearableBoneIndices.get(candidate.index)!;
    const skinIndex = candidate.mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    if (skinIndex) {
      for (let vertex = 0; vertex < skinIndex.count; vertex++) {
        const remap = (index: number) => {
          const jointName = candidate.rig.joints[index]?.name;
          return jointIndices.get(jointName ?? '') ?? 0;
        };
        skinIndex.setXYZW(
          vertex,
          remap(skinIndex.getX(vertex)),
          remap(skinIndex.getY(vertex)),
          remap(skinIndex.getZ(vertex)),
          remap(skinIndex.getW(vertex)),
        );
      }
      skinIndex.needsUpdate = true;
    }
    candidate.mesh.bind(skeleton, candidate.mesh.matrixWorld.clone());
    // Character joints outside the socket can move these vertices beyond the gear-only bind sphere.
    candidate.mesh.frustumCulled = false;
  }
}
export function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    skeletons = new Set<THREE.Skeleton>();
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !geometries.has(mesh.geometry)) {
      geometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    if (mesh.material)
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        if (!materials.has(material)) {
          materials.add(material);
          material.dispose();
        }
    const skeleton = (o as THREE.SkinnedMesh).skeleton;
    if (skeleton && !skeletons.has(skeleton)) {
      skeletons.add(skeleton);
      skeleton.dispose();
    }
  });
  object.removeFromParent();
}
