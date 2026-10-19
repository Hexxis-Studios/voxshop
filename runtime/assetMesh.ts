import * as THREE from 'three';
import type { Asset, Rig, SceneNode } from '../services/projectDocument';

const cube = new THREE.BoxGeometry(1, 1, 1),
  positions = cube.getAttribute('position'),
  normals = cube.getAttribute('normal'),
  indices = cube.index!;
const neighborDirections = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
function skin(v: Asset['model']['voxels'][number], rig: Rig | null) {
  const entries = (
    v.weights?.length
      ? v.weights
      : v.bone
        ? [{ bone: v.bone, weight: 1 }]
        : [{ bone: rig?.joints[0].name ?? '', weight: 1 }]
  )
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);
  const sum = entries.reduce((n, w) => n + w.weight, 0) || 1;
  return {
    indices: [0, 0, 0, 0].map((_, i) =>
      Math.max(0, rig?.joints.findIndex((j) => j.name === entries[i]?.bone) ?? 0),
    ),
    weights: [0, 0, 0, 0].map((_, i) => (entries[i]?.weight ?? 0) / sum),
  };
}
export type AssetVisual = {
  group: THREE.Group;
  bones: Map<string, THREE.Bone>;
  animate: (clip: string, time: number, speed?: number) => void;
};
export function createAssetVisual(asset: Asset, hiddenBones: string[] = []): AssetVisual {
  const group = new THREE.Group(),
    bones = new Map<string, THREE.Bone>();
  const rig = asset.rig,
    grid = new Map(
      asset.model.voxels
        .filter((v) => !hiddenBones.includes(v.bone ?? ''))
        .map((v) => [`${v.x},${v.y},${v.z}`, v]),
    );
  const materials = ['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE'];
  const poseKey = (v: any) => JSON.stringify([v.bone, v.weights]);
  const allBones: THREE.Bone[] = [];
  if (rig) {
    for (const j of rig.joints) {
      const b = new THREE.Bone();
      b.name = j.name;
      const p = j.parent ? rig.joints.find((p) => p.name === j.parent)!.position : [0, 0, 0];
      b.position.set(j.position[0] - p[0], j.position[1] - p[1], j.position[2] - p[2]);
      bones.set(j.name, b);
      allBones.push(b);
    }
    for (const j of rig.joints) if (j.parent) bones.get(j.parent)!.add(bones.get(j.name)!);
  }
  // Single skinned mesh, material groups, and joint-aware face culling preserve newly exposed surfaces.
  const p: number[] = [],
    n: number[] = [],
    c: number[] = [],
    si: number[] = [],
    sw: number[] = [],
    ix: number[] = [];
  const geom = new THREE.BufferGeometry();
  for (let mi = 0; mi < materials.length; mi++) {
    const start = ix.length;
    for (const v of grid.values()) {
      if ((v.materialType ?? 'STANDARD') !== materials[mi]) continue;
      const color = new THREE.Color(v.color),
        s = skin(v, rig);
      for (let face = 0; face < 6; face++) {
        const d = neighborDirections[face],
          neighbor = grid.get(`${v.x + d[0]},${v.y + d[1]},${v.z + d[2]}`);
        if (
          neighbor &&
          (neighbor.materialType ?? 'STANDARD') !== 'GLASS' &&
          (!rig || poseKey(neighbor) === poseKey(v))
        )
          continue;
        const base = p.length / 3;
        for (let k = 0; k < 4; k++) {
          const vi = face * 4 + k;
          p.push(positions.getX(vi) + v.x, positions.getY(vi) + v.y, positions.getZ(vi) + v.z);
          n.push(normals.getX(vi), normals.getY(vi), normals.getZ(vi));
          c.push(color.r, color.g, color.b);
          si.push(...s.indices);
          sw.push(...s.weights);
        }
        for (let k = 0; k < 6; k++) ix.push(base + indices.getX(face * 6 + k) - face * 4);
      }
    }
    geom.addGroup(start, ix.length - start, mi);
  }
  geom.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  geom.setIndex(ix);
  const mats = materials.map(
    (m) =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: m === 'METALLIC' ? 0.3 : 0.85,
        metalness: m === 'METALLIC' ? 0.8 : 0,
        transparent: m === 'GLASS',
        opacity: m === 'GLASS' ? 0.5 : 1,
        emissive: m === 'EMISSIVE' ? 0xffffff : 0,
        emissiveIntensity: m === 'EMISSIVE' ? 0.65 : 0,
        side: THREE.FrontSide,
      }),
  );
  let mesh: THREE.Mesh;
  if (rig) {
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const skinned = new THREE.SkinnedMesh(geom, mats);
    for (const j of rig.joints) if (!j.parent) skinned.add(bones.get(j.name)!);
    skinned.updateMatrixWorld(true);
    skinned.bind(new THREE.Skeleton(allBones));
    mesh = skinned;
  } else mesh = new THREE.Mesh(geom, mats);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = !rig;
  mesh.scale.setScalar(asset.voxelSize);
  mesh.position.set(
    -asset.pivot[0] * asset.voxelSize,
    -asset.pivot[1] * asset.voxelSize,
    -asset.pivot[2] * asset.voxelSize,
  );
  group.add(mesh);
  const animate = (clip: string, time: number, speed = 1) => {
    if (!rig) return;
    for (const j of rig.joints) {
      const b = bones.get(j.name)!;
      b.rotation.set(0, 0, 0);
      const parent = rig.joints.find((p) => p.name === j.parent)?.position ?? [0, 0, 0];
      b.position.set(...(j.position.map((n, i) => n - parent[i]) as [number, number, number]));
    }
    const animation = rig.clips.find((c) => c.name.toLowerCase() === clip.toLowerCase());
    if (!animation) return;
    const t = animation.loop
      ? (time * speed) % animation.duration
      : Math.min(animation.duration, time * speed);
    for (const track of animation.tracks) {
      const bone = bones.get(track.joint);
      if (!bone || !track.keys.length) continue;
      const keys = track.keys.slice().sort((a, b) => a.time - b.time);
      let a = keys[0],
        b = keys[keys.length - 1];
      for (let i = 1; i < keys.length; i++)
        if (keys[i].time >= t) {
          a = keys[i - 1];
          b = keys[i];
          break;
        }
      const alpha = Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time || 1)));
      bone.rotation.set(
        ...(a.rotation.map((n, i) => n + (b.rotation[i] - n) * alpha) as [number, number, number]),
      );
      if (a.position || b.position) {
        const p = a.position ?? [0, 0, 0],
          q = b.position ?? [0, 0, 0];
        bone.position.add(
          new THREE.Vector3(...(p.map((n, i) => n + (q[i] - n) * alpha) as [number, number, number])),
        );
      }
    }
  };
  return { group, bones, animate };
}
export function createNodeVisual(node: SceneNode, assets: Map<string, Asset>): AssetVisual {
  const asset = node.assetId ? assets.get(node.assetId) : undefined;
  if (!asset) return { group: new THREE.Group(), bones: new Map(), animate: () => {} };
  const visual = createAssetVisual(
    asset,
    node.attachments.flatMap((a) => a.hiddenBones),
  );
  const wearables: AssetVisual[] = [];
  for (const attachment of node.attachments) {
    const item = assets.get(attachment.assetId)!;
    const socket = asset.rig?.sockets.find((s) => s.name === attachment.socket);
    if (!socket) continue;
    const child = createAssetVisual(item);
    wearables.push(child);
    if (item.rig) {
      visual.group.add(child.group);
      child.group.position.set(...attachment.transform.position);
      child.group.rotation.set(...attachment.transform.rotation);
      child.group.scale.set(...attachment.transform.scale);
    } else {
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
  }
  const animate = visual.animate;
  return {
    ...visual,
    animate: (name, time, speed) => {
      animate(name, time, speed);
      for (const w of wearables) w.animate(name, time, speed);
    },
  };
}
export function disposeObject(object: THREE.Object3D) {
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material)
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
    if ((o as THREE.SkinnedMesh).skeleton) (o as THREE.SkinnedMesh).skeleton.dispose();
  });
  object.removeFromParent();
}
