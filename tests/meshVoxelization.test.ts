import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { voxelizeMesh } from '../services/meshVoxelization';
import { CONFIG } from '../utils/voxelConstants';

function triangleGeometry(points: number[] = [0, 0, 0, 2, 0, 0, 0, 2, 0], uvs?: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

test('mesh conversion is deterministic and preserves centered X/Z and floor-relative Y coordinates', () => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0x6a4c93 }),
  );
  const first = voxelizeMesh(mesh, 4);
  const second = voxelizeMesh(mesh, 4);

  assert.ok(first && first.length > 0);
  assert.deepEqual(second, first);
  assert.ok(
    first.every(
      ({ x, y, z, color }) =>
        Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && Number.isInteger(color),
    ),
  );
  assert.ok(first.every(({ y }) => y >= CONFIG.FLOOR_Y + 1));
  assert.ok(first.some(({ x }) => x < 0) && first.some(({ x }) => x > 0));
  assert.ok(first.some(({ z }) => z < 0) && first.some(({ z }) => z > 0));
});

test('mesh conversion averages vertex colors and selects material color by geometry group', () => {
  const vertexGeometry = triangleGeometry();
  vertexGeometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  const vertexVoxels = voxelizeMesh(new THREE.Mesh(vertexGeometry), 4)!;
  assert.ok(vertexVoxels.length > 0);
  assert.ok(vertexVoxels.every(({ color }) => color === 0x555555));

  const groupedGeometry = triangleGeometry();
  groupedGeometry.addGroup(0, 3, 1);
  const materialVoxels = voxelizeMesh(
    new THREE.Mesh(groupedGeometry, [
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
      new THREE.MeshStandardMaterial({ color: 0x11aabb }),
    ]),
    4,
  )!;
  assert.ok(materialVoxels.length > 0);
  assert.ok(materialVoxels.every(({ color }) => color === 0x11aabb));
});

test('mesh conversion samples texture color and multiplies a tinted material', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const pixel = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  for (let i = 0; i < pixel.data.length; i += 4) {
    pixel.data.set([128, 192, 64, 255], i);
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {}, getImageData: () => pixel }),
      }),
    },
  });
  try {
    const geometry = triangleGeometry(undefined, [0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
    const material = new THREE.MeshStandardMaterial({ color: 0x80ff80 });
    material.map = new THREE.Texture({ width: 2, height: 2 });
    const voxels = voxelizeMesh(new THREE.Mesh(geometry, material), 4)!;
    assert.ok(voxels.length > 0);
    assert.ok(voxels.every(({ color }) => color === 0x40c020));
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as any).document;
  }
});

test('mesh conversion applies nested world transforms to geometry', () => {
  const geometry = triangleGeometry();
  const transformed = new THREE.Group();
  transformed.position.set(12, 3, -7);
  transformed.rotation.z = Math.PI / 2;
  const child = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x234567 }));
  child.position.set(1, 2, 3);
  child.scale.set(2, 1, 1);
  transformed.add(child);
  transformed.updateMatrixWorld(true);

  const bakedGeometry = geometry.clone().applyMatrix4(child.matrixWorld);
  const baked = new THREE.Mesh(bakedGeometry, child.material);
  const actual = voxelizeMesh(transformed, 8);
  assert.ok(actual && actual.length > 0);
  assert.deepEqual(actual, voxelizeMesh(baked, 8));
  assert.notDeepEqual(actual, voxelizeMesh(new THREE.Mesh(geometry.clone(), child.material), 8));
});

test('mesh conversion uses the current skinned pose and its expanded bounds', () => {
  const geometry = triangleGeometry([1, 0, 0, 2, 0, 0, 1, 1, 0]);
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const material = new THREE.MeshStandardMaterial({ color: 0x123456 });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([bone]));
  bone.rotation.z = Math.PI / 2;
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();

  const deformedPositions: number[] = [];
  for (let index = 0; index < geometry.attributes.position.count; index++) {
    const point = mesh.getVertexPosition(index, new THREE.Vector3());
    deformedPositions.push(point.x, point.y, point.z);
  }
  const deformedGeometry = new THREE.BufferGeometry();
  deformedGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float64Array(deformedPositions), 3),
  );
  const expected = voxelizeMesh(new THREE.Mesh(deformedGeometry, material), 8);
  const actual = voxelizeMesh(mesh, 8);

  assert.ok(actual && actual.length > 0);
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual, voxelizeMesh(new THREE.Mesh(geometry.clone(), material), 8));
});

test('empty geometry returns no voxels and zero-extent meshes leave the current model alone', () => {
  assert.equal(voxelizeMesh(new THREE.Group()), null);
  const point = triangleGeometry([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(voxelizeMesh(new THREE.Mesh(point), 8), null);
});

test('mesh conversion rejects surfaces that exceed the voxel cap', () => {
  const geometry = triangleGeometry([0, 0, 0, 512, 0, 0, 512, 512, 0, 0, 0, 0, 512, 512, 0, 0, 512, 0]);
  assert.throws(() => voxelizeMesh(new THREE.Mesh(geometry), 512), /exceeds 250,000 voxels/);
});

test('mesh conversion enforces its cell-test work budget', () => {
  const points: number[] = [];
  for (let i = 0; i < 24; i++) points.push(0, 0, 0, 400, 400, 400, 400, 0, 400);
  const geometry = triangleGeometry(points);
  const intersectsBox = THREE.Triangle.prototype.intersectsBox;
  THREE.Triangle.prototype.intersectsBox = () => false;
  try {
    assert.throws(() => voxelizeMesh(new THREE.Mesh(geometry), 400), /exceeded its work budget/);
  } finally {
    THREE.Triangle.prototype.intersectsBox = intersectsBox;
  }
});
