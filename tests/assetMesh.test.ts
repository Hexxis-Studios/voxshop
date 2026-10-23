import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { assetSchema, type SceneNode } from '../services/projectDocument';
import { createNodeVisual, disposeObject } from '../runtime/assetMesh';
import { createModelDocument } from '../services/modelDocument';
import { generateCharacter, fitEquipment } from '../services/assetAssembly';
import { VoxelMaterial, type VoxelData } from '../types';

function asset(voxels: VoxelData[]) {
  return assetSchema.parse({
    id: 'asset-mesh-test',
    name: 'Asset mesh test',
    voxelSize: 0.5,
    model: { format: 'voxshop-model', version: 1, voxels, skeleton: null },
  });
}

function nodeVisual(voxels: VoxelData[]) {
  const selected = asset(voxels);
  const node = { assetId: selected.id, attachments: [] } as unknown as SceneNode;
  return createNodeVisual(node, new Map([[selected.id, selected]]));
}

test('socket attachments preserve their asset voxel size under a differently scaled rig', () => {
  const body = assetSchema.parse({
    ...asset([{ x: 0, y: 0, z: 0, color: 0x557799, materialType: VoxelMaterial.STANDARD, isLocked: false }]),
    id: 'scaled-wearer',
    name: 'Scaled wearer',
    rig: {
      profile: 'test',
      version: 1,
      joints: [{ name: 'root', parent: null, position: [0, 0, 0] }],
      sockets: [{ name: 'hand', joint: 'root', transform: {} }],
    },
  });
  const gear = assetSchema.parse({
    id: 'small-gear',
    name: 'Small gear',
    voxelSize: 0.1,
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x997755 }]),
  });
  const node = {
    assetId: body.id,
    attachments: [
      {
        assetId: gear.id,
        socket: 'hand',
        slot: 'hand',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        hiddenBones: [],
      },
    ],
  } as unknown as SceneNode;
  const visual = createNodeVisual(
    node,
    new Map([
      [body.id, body],
      [gear.id, gear],
    ]),
  );
  visual.group.updateMatrixWorld(true);
  let attachedMesh: THREE.Mesh | undefined;
  visual.group.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh)
      attachedMesh = object as THREE.Mesh;
  });
  assert.ok(attachedMesh, 'the rigid gear is attached below the rig socket');
  const size = new THREE.Box3().setFromObject(attachedMesh).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - gear.voxelSize) < 1e-6);
  assert.ok(Math.abs(size.y - gear.voxelSize) < 1e-6);
  assert.ok(Math.abs(size.z - gear.voxelSize) < 1e-6);
  disposeObject(visual.group);
});

test('rigged equipment keeps its own skinning scale and follows the wearer socket bone', () => {
  const body = assetSchema.parse({
      ...asset([
        {
          x: 0,
          y: 0,
          z: 0,
          color: 0x557799,
          bone: 'root',
          weights: [{ bone: 'root', weight: 1 }],
        },
      ]),
      id: 'rigged-wearer',
      voxelSize: 0.5,
      rig: {
        profile: 'test',
        version: 1,
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          { name: 'hand', parent: 'root', position: [0, 2, 0] },
        ],
        sockets: [{ name: 'hand', joint: 'hand', transform: { position: [1, 0, 0] } }],
        clips: [
          {
            name: 'walk',
            duration: 1,
            loop: true,
            speed: 1,
            tracks: [
              {
                joint: 'hand',
                keys: [
                  { time: 0, rotation: [0, 0, 0] },
                  { time: 1, rotation: [0, 0, Math.PI / 2] },
                ],
              },
            ],
            events: [],
          },
        ],
      },
    }),
    gear = assetSchema.parse({
      id: 'rigged-gear',
      name: 'Rigged gear',
      voxelSize: 0.1,
      model: createModelDocument([
        { x: 0, y: 0, z: 0, color: 0x997755, bone: 'gear-root', weights: [{ bone: 'gear-root', weight: 1 }] },
      ]),
      rig: {
        profile: 'test',
        version: 1,
        joints: [{ name: 'gear-root', parent: null, position: [0, 0, 0] }],
        sockets: [],
        clips: [
          {
            name: 'walk',
            duration: 1,
            loop: true,
            speed: 1,
            tracks: [
              {
                joint: 'gear-root',
                keys: [
                  { time: 0, rotation: [0, 0, 0] },
                  { time: 1, rotation: [0, 0, Math.PI / 2] },
                ],
              },
            ],
            events: [],
          },
        ],
      },
    }),
    node = {
      assetId: body.id,
      attachments: [
        {
          assetId: gear.id,
          socket: 'hand',
          slot: 'hand',
          transform: { position: [0.1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          hiddenBones: [],
        },
      ],
    } as unknown as SceneNode,
    visual = createNodeVisual(
      node,
      new Map([
        [body.id, body],
        [gear.id, gear],
      ]),
    ),
    skinnedMeshes: THREE.SkinnedMesh[] = [];
  visual.group.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes.push(object as THREE.SkinnedMesh);
  });
  assert.equal(skinnedMeshes.length, 2);
  const gearMesh = skinnedMeshes.find((mesh) =>
    mesh.skeleton.bones.some((bone) => bone.name === 'gear-root'),
  )!;
  visual.group.updateMatrixWorld(true);
  let ancestor: THREE.Object3D | null = gearMesh;
  while (ancestor && ancestor !== visual.bones.get('hand')) ancestor = ancestor.parent;
  assert.equal(
    ancestor,
    visual.bones.get('hand'),
    "rigged equipment is parented to its wearer's socket bone",
  );
  const worldScale = gearMesh.getWorldScale(new THREE.Vector3()),
    worldPosition = gearMesh.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(worldScale.x - gear.voxelSize) < 1e-6);
  assert.ok(Math.abs(worldScale.y - gear.voxelSize) < 1e-6);
  assert.ok(Math.abs(worldScale.z - gear.voxelSize) < 1e-6);
  assert.ok(Math.abs(worldPosition.x - 0.6) < 1e-6);
  assert.ok(Math.abs(worldPosition.y - 1) < 1e-6);
  visual.animate('walk', 0.5);
  visual.group.updateMatrixWorld(true);
  const gearRoot = gearMesh.skeleton.bones.find((bone) => bone.name === 'gear-root')!;
  assert.ok(Math.abs(gearRoot.quaternion.z) > 0.1, "the wearable's own matching clip animates");
  assert.ok(
    gearMesh.getWorldPosition(new THREE.Vector3()).distanceTo(worldPosition) > 0.1,
    "the wearer's moving socket carries the gear skeleton",
  );
  assert.notEqual(gearMesh.skeleton, skinnedMeshes.find((mesh) => mesh !== gearMesh)!.skeleton);
  disposeObject(visual.group);
});

test('compatible rigged gear merges reordered joints, remaps skin weights, and follows the character pose', () => {
  const body = assetSchema.parse({
      ...asset([
        {
          x: 0,
          y: 0,
          z: 0,
          color: 0x557799,
          bone: 'root',
          weights: [{ bone: 'root', weight: 1 }],
        },
      ]),
      id: 'merged-wearer',
      rig: {
        profile: 'shared-humanoid',
        version: 1,
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          { name: 'hand', parent: 'root', position: [0, 2, 0] },
        ],
        sockets: [{ name: 'hand', joint: 'hand', transform: { position: [0.2, 0, 0] } }],
        clips: [
          {
            name: 'walk',
            duration: 1,
            loop: true,
            speed: 1,
            tracks: [
              {
                joint: 'hand',
                keys: [
                  { time: 0, rotation: [0, 0, 0] },
                  { time: 1, rotation: [0, 0, Math.PI / 2] },
                ],
              },
            ],
            events: [],
          },
        ],
      },
    }),
    gear = assetSchema.parse({
      id: 'merged-blade',
      name: 'Merged blade',
      voxelSize: 0.25,
      model: createModelDocument([
        {
          x: 1,
          y: 2,
          z: 0,
          color: 0x997755,
          bone: 'blade',
          weights: [
            { bone: 'blade', weight: 0.75 },
            { bone: 'hand', weight: 0.25 },
          ],
        },
      ]),
      rig: {
        profile: 'shared-humanoid',
        version: 1,
        // Deliberately differs from the character order and includes a gear-only joint first.
        joints: [
          { name: 'blade', parent: 'hand', position: [1, 2, 0] },
          { name: 'hand', parent: 'root', position: [0, 2, 0] },
          { name: 'root', parent: null, position: [0, 0, 0] },
        ],
        sockets: [],
        clips: [],
      },
    }),
    node = {
      assetId: body.id,
      attachments: [
        {
          assetId: gear.id,
          socket: 'hand',
          slot: 'hand',
          transform: { position: [0.1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          hiddenBones: [],
        },
      ],
    } as unknown as SceneNode,
    visual = createNodeVisual(
      node,
      new Map([
        [body.id, body],
        [gear.id, gear],
      ]),
    ),
    skinnedMeshes: THREE.SkinnedMesh[] = [];
  visual.group.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes.push(object as THREE.SkinnedMesh);
  });

  assert.equal(skinnedMeshes.length, 2);
  const [bodyMesh, gearMesh] = skinnedMeshes;
  assert.equal(bodyMesh.skeleton, gearMesh.skeleton, 'both meshes share the merged character skeleton');
  assert.deepEqual(
    gearMesh.skeleton.bones.map((bone) => bone.name),
    ['root', 'hand', 'blade'],
    'the character joint order stays intact and gear-only bones are appended',
  );
  const skinIndex = gearMesh.geometry.getAttribute('skinIndex');
  const skinWeight = gearMesh.geometry.getAttribute('skinWeight');
  assert.equal(skinIndex.getX(0), 2, 'the first gear influence remaps from gear index 0 to union index 2');
  assert.equal(skinIndex.getY(0), 1, 'the second gear influence remaps from gear index 1 to union index 1');
  assert.equal(skinWeight.getX(0), 0.75);
  assert.equal(skinWeight.getY(0), 0.25);

  visual.group.updateMatrixWorld(true);
  const gearOrigin = gearMesh.getWorldPosition(new THREE.Vector3());
  assert.ok(
    Math.abs(gearOrigin.x - 0.2) < 1e-6,
    'socket and attachment offsets remain in the rendered transform',
  );
  assert.ok(Math.abs(gearOrigin.y - 1) < 1e-6, 'the attached mesh remains at the character hand');
  assert.ok(Math.abs(gearMesh.getWorldScale(new THREE.Vector3()).x - gear.voxelSize) < 1e-6);

  gearMesh.skeleton.update();
  const before = gearMesh.localToWorld(gearMesh.getVertexPosition(0, new THREE.Vector3()));
  visual.animate('walk', 0.5);
  visual.group.updateMatrixWorld(true);
  gearMesh.skeleton.update();
  const after = gearMesh.localToWorld(gearMesh.getVertexPosition(0, new THREE.Vector3()));
  assert.ok(after.distanceTo(before) > 0.1, 'the merged gear surface follows the character hand animation');
  disposeObject(visual.group);
});

test('fitted shell skeleton merging preserves character size and animated surface at non-unit voxel scales', () => {
  for (const profile of ['biped', 'machine', 'quadruped'] as const) {
    for (const voxelSize of [0.1, 0.5]) {
      const body = assetSchema.parse(
        generateCharacter({
          id: 'body',
          name: 'Body',
          profile,
          height: 18,
          width: 8,
          color: 0xdd7733,
          accent: 0xeeddcc,
          voxelSize,
        }),
      );
      const shell = assetSchema.parse(
        fitEquipment(body, { id: 'shell', name: 'Shell', kind: 'shell', color: 0x446677 }),
      );
      const assets = new Map([
        [body.id, body],
        [shell.id, shell],
      ]);
      const bare = createNodeVisual({ assetId: body.id, attachments: [] } as unknown as SceneNode, assets);
      const dressed = createNodeVisual(
        {
          assetId: body.id,
          attachments: [
            {
              assetId: shell.id,
              socket: 'body',
              slot: 'body',
              hiddenBones: [],
              transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            },
          ],
        } as unknown as SceneNode,
        assets,
      );
      const firstMesh = (group: THREE.Group) => {
        let result: THREE.SkinnedMesh | undefined;
        group.traverse((object) => {
          if (!result && (object as THREE.SkinnedMesh).isSkinnedMesh) result = object as THREE.SkinnedMesh;
        });
        return result!;
      };
      const plainMesh = firstMesh(bare.group),
        dressedMesh = firstMesh(dressed.group);
      for (const time of [0, 0.3, 0.7]) {
        for (const visual of [bare, dressed]) {
          visual.animate('walk', time);
          visual.group.position.set(3, 1, -2);
          visual.group.rotation.y = 0.4;
          visual.group.scale.set(1.2, 0.8, 1.1);
          visual.group.updateMatrixWorld(true);
        }
        plainMesh.skeleton.update();
        dressedMesh.skeleton.update();
        for (let vertex = 0; vertex < plainMesh.geometry.getAttribute('position').count; vertex++) {
          const expected = plainMesh.localToWorld(plainMesh.getVertexPosition(vertex, new THREE.Vector3()));
          const actual = dressedMesh.localToWorld(dressedMesh.getVertexPosition(vertex, new THREE.Vector3()));
          assert.ok(
            actual.distanceTo(expected) < 1e-5,
            `${profile} at voxel size ${voxelSize}: equipment changed the body surface`,
          );
        }
      }
      disposeObject(bare.group);
      disposeObject(dressed.group);
    }
  }
});

test('large high-surface opaque assets use chunked cube instances with voxel colors and material batches', () => {
  const voxels = Array.from({ length: 4_200 }, (_, index) => ({
    x: (index % 100) * 2,
    y: 0,
    z: Math.floor(index / 100) * 2,
    color: index % 2 ? 0x4d79ad : 0xc05f46,
    materialType: index === 0 ? VoxelMaterial.METALLIC : VoxelMaterial.STANDARD,
    isLocked: false,
  }));
  const visual = nodeVisual(voxels);
  const meshes = visual.group.children.filter(
    (child): child is THREE.InstancedMesh => (child as THREE.InstancedMesh).isInstancedMesh,
  );
  const instanceBytes = meshes.reduce(
    (total, mesh) =>
      total + mesh.instanceMatrix.array.byteLength + (mesh.instanceColor?.array.byteLength ?? 0),
    0,
  );

  assert.equal(visual.group.userData.voxelRepresentation, 'instanced-cubes');
  assert.equal(visual.group.userData.voxelInstanceCount, voxels.length);
  assert.equal(meshes.length, visual.group.children.length);
  assert.ok(meshes.some((mesh) => mesh.userData.voxelMaterial === VoxelMaterial.METALLIC));
  assert.ok(meshes.some((mesh) => mesh.userData.voxelMaterial === VoxelMaterial.STANDARD));
  assert.ok(instanceBytes < voxels.length * 6 * 168);
  const firstMesh = meshes.find((mesh) => mesh.userData.voxelMaterial === VoxelMaterial.METALLIC)!;
  const color = new THREE.Color();
  firstMesh.getColorAt(0, color);
  const expectedColor = new THREE.Color(0xc05f46);
  assert.ok(Math.abs(color.r - expectedColor.r) < 1e-6);
  assert.ok(Math.abs(color.g - expectedColor.g) < 1e-6);
  assert.ok(Math.abs(color.b - expectedColor.b) < 1e-6);
  assert.equal((firstMesh.material as THREE.MeshStandardMaterial).metalness, 0.8);
});

test('dense chunked assets retain greedy meshes when faces merge compactly', () => {
  const voxels: VoxelData[] = [];
  for (let y = 0; y < 20; y++)
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        voxels.push({
          x,
          y,
          z,
          color: 0x77915b,
          materialType: VoxelMaterial.STANDARD,
          isLocked: false,
        });
  const visual = nodeVisual(voxels);
  const meshes = visual.group.children.filter((child) => (child as THREE.Mesh).isMesh);

  assert.equal(visual.group.userData.voxelRepresentation, 'greedy-mesh');
  assert.ok(meshes.length > 0);
  assert.ok(meshes.every((child) => !(child as THREE.InstancedMesh).isInstancedMesh));
});

test('disposing one instanced asset does not invalidate another asset visual', () => {
  const voxels = Array.from({ length: 4_200 }, (_, index) => ({
    x: index * 2,
    y: 0,
    z: 0,
    color: 0x77915b,
    materialType: VoxelMaterial.STANDARD,
    isLocked: false,
  }));
  const first = nodeVisual(voxels);
  const second = nodeVisual(voxels);
  const firstGeometry = (first.group.children[0] as THREE.Mesh).geometry;
  const secondGeometry = (second.group.children[0] as THREE.Mesh).geometry;
  let secondDisposed = false;
  secondGeometry.addEventListener('dispose', () => (secondDisposed = true));

  assert.notEqual(firstGeometry, secondGeometry);
  disposeObject(first.group);
  assert.equal(secondDisposed, false);
  disposeObject(second.group);
  assert.equal(secondDisposed, true);
});
