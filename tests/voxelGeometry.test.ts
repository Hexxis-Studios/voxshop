import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createTerrainLodGeometryChunks,
  createVoxelGeometry,
  createVoxelGeometryChunks,
} from '../runtime/voxelGeometry';
import { createVoxelMaterials } from '../runtime/assetMesh';
import { createModelDocument } from '../services/modelDocument';
import { assetSchema } from '../services/projectDocument';

test('emissive voxel shading preserves each voxel color', () => {
  const material = createVoxelMaterials()[3],
    shader = { fragmentShader: THREE.ShaderLib.standard.fragmentShader } as Parameters<
      typeof material.onBeforeCompile
    >[0];
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  assert.ok(shader.fragmentShader.includes('totalEmissiveRadiance *= diffuseColor.rgb;'));
  assert.equal(material.emissiveIntensity, 0.35);
  material.dispose();
});

test('greedy meshing collapses a solid block to six quads with outward winding and exact bounds', () => {
  const voxels = Array.from({ length: 4096 }, (_, i) => ({
    x: (i % 16) - 8,
    y: Math.floor(i / 16) % 16,
    z: Math.floor(i / 256),
    color: 0x884422,
  }));
  const geometry = createVoxelGeometry(
    assetSchema.parse({ id: 'block', name: 'Block', model: createModelDocument(voxels) }),
  );
  assert.equal(geometry.index!.count, 36);
  assert.equal(geometry.getAttribute('position').count, 24);
  assert.equal(geometry.groups.length, 1, 'Absent materials must not submit empty draw calls.');
  assert.equal(geometry.getAttribute('skinIndex'), undefined);
  assert.equal(geometry.getAttribute('skinWeight'), undefined);
  geometry.computeBoundingBox();
  assert.deepEqual(geometry.boundingBox!.min.toArray(), [-8.5, -0.5, -0.5]);
  assert.deepEqual(geometry.boundingBox!.max.toArray(), [7.5, 15.5, 15.5]);
  const positions = geometry.getAttribute('position'),
    normals = geometry.getAttribute('normal');
  for (let i = 0; i < geometry.index!.count; i += 3) {
    const ids = [0, 1, 2].map((j) => geometry.index!.getX(i + j));
    const [a, b, c] = ids.map((j) => new THREE.Vector3().fromBufferAttribute(positions, j));
    assert.ok(b.sub(a).cross(c.sub(a)).dot(new THREE.Vector3().fromBufferAttribute(normals, ids[0])) > 0);
  }
  geometry.dispose();
});

test('rigged adjacent voxels keep bone seams and their skin weights', () => {
  const asset = assetSchema.parse({
      id: 'rigged',
      name: 'Rigged',
      rig: {
        profile: 'test',
        version: 1,
        joints: [
          { name: 'Root', parent: null, position: [0, 0, 0] },
          { name: 'Child', parent: 'Root', position: [1, 0, 0] },
        ],
      },
      model: createModelDocument([
        { x: 0, y: 0, z: 0, color: 0x884422, bone: 'Root', weights: [{ bone: 'Root', weight: 1 }] },
        { x: 1, y: 0, z: 0, color: 0x884422, bone: 'Child', weights: [{ bone: 'Child', weight: 1 }] },
      ]),
    }),
    geometry = createVoxelGeometry(asset),
    skinIndices = geometry.getAttribute('skinIndex'),
    skinWeights = geometry.getAttribute('skinWeight');
  assert.equal(geometry.index!.count, 72, 'The differently skinned shared faces must remain visible.');
  assert.deepEqual(
    [...new Set(Array.from({ length: skinIndices.count }, (_, i) => skinIndices.getX(i)))].sort(),
    [0, 1],
  );
  for (let i = 0; i < skinWeights.count; i++) {
    assert.equal(skinWeights.getX(i), 1);
    assert.equal(skinWeights.getY(i), 0);
    assert.equal(skinWeights.getZ(i), 0);
    assert.equal(skinWeights.getW(i), 0);
  }
  geometry.dispose();
});

test('rigged adjacent voxels with reordered equivalent weights cull their shared face', () => {
  const asset = assetSchema.parse({
      id: 'equivalent-weights',
      name: 'Equivalent weights',
      rig: {
        profile: 'test',
        version: 1,
        joints: [
          { name: 'Root', parent: null, position: [0, 0, 0] },
          { name: 'Child', parent: 'Root', position: [1, 0, 0] },
        ],
      },
      model: createModelDocument([
        {
          x: 0,
          y: 0,
          z: 0,
          color: 0x884422,
          weights: [
            { bone: 'Root', weight: 0.75 },
            { bone: 'Child', weight: 0.25 },
          ],
        },
        {
          x: 1,
          y: 0,
          z: 0,
          color: 0x884422,
          weights: [
            { bone: 'Child', weight: 0.25 },
            { bone: 'Root', weight: 0.75 },
          ],
        },
      ]),
    }),
    geometry = createVoxelGeometry(asset);
  assert.equal(geometry.index!.count, 60, 'Equivalent GPU influences must not leave an internal face.');
  geometry.dispose();
});

test('blended voxel weights reach the four-slot GPU skin attributes', () => {
  const asset = assetSchema.parse({
      id: 'weighted',
      name: 'Weighted',
      rig: {
        profile: 'test',
        version: 1,
        joints: [
          { name: 'Root', parent: null, position: [0, 0, 0] },
          { name: 'Child', parent: 'Root', position: [1, 0, 0] },
        ],
      },
      model: createModelDocument([
        {
          x: 0,
          y: 0,
          z: 0,
          color: 0x884422,
          bone: 'Root',
          weights: [
            { bone: 'Child', weight: 0.25 },
            { bone: 'Root', weight: 0.75 },
          ],
        },
      ]),
    }),
    geometry = createVoxelGeometry(asset),
    skinIndices = geometry.getAttribute('skinIndex'),
    skinWeights = geometry.getAttribute('skinWeight');
  assert.equal(skinIndices.getX(0), 0);
  assert.equal(skinIndices.getY(0), 1);
  assert.equal(skinWeights.getX(0), 0.75);
  assert.equal(skinWeights.getY(0), 0.25);
  assert.equal(skinWeights.getZ(0), 0);
  assert.equal(skinWeights.getW(0), 0);
  geometry.dispose();
});

test('meshing preserves holes, color seams, material boundaries and sparse distant voxels', () => {
  const voxels = [
    { x: 0, y: 0, z: 0, color: 0xff0000 },
    { x: 1, y: 0, z: 0, color: 0x0000ff },
    { x: 0, y: 1, z: 0, color: 0xff0000, materialType: 'METALLIC' as const },
    { x: 2, y: 1, z: 0, color: 0xff0000 },
    { x: 100000, y: 0, z: 0, color: 0xffffff },
  ];
  const geometry = createVoxelGeometry(
    assetSchema.parse({ id: 'sparse', name: 'Sparse', model: createModelDocument(voxels) }),
  );
  const p = geometry.getAttribute('position'),
    color = geometry.getAttribute('color');
  const areas = new Map<string, number>();
  for (const group of geometry.groups) {
    let area = 0;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const ids = [0, 1, 2].map((j) => geometry.index!.getX(i + j));
      const [a, b, c] = ids.map((j) => new THREE.Vector3().fromBufferAttribute(p, j));
      area += b.sub(a).cross(c.sub(a)).length() / 2;
      assert.deepEqual(
        ids.map((j) => [color.getX(j), color.getY(j), color.getZ(j)]),
        Array(3).fill([color.getX(ids[0]), color.getY(ids[0]), color.getZ(ids[0])]),
      );
    }
    areas.set(String(group.materialIndex), area);
  }
  assert.equal(areas.get('0'), 21); // Four cubes, minus three faces occluded by neighbors.
  assert.equal(areas.get('1'), 5);
  geometry.dispose();
});

test('transparent faces retain their material group and empty models keep valid attributes', () => {
  const glass = assetSchema.parse({
      id: 'glass',
      name: 'Glass',
      model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff, materialType: 'GLASS' }]),
    }),
    geometry = createVoxelGeometry(glass);
  assert.deepEqual(geometry.groups, [{ start: 0, count: 36, materialIndex: 2 }]);
  geometry.dispose();
  const empty = createVoxelGeometry(
    assetSchema.parse({ id: 'empty', name: 'Empty', model: createModelDocument([]) }),
  );
  assert.equal(empty.index!.count, 0);
  assert.ok(empty.getAttribute('position'));
  assert.ok(empty.getAttribute('normal'));
  assert.ok(empty.getAttribute('color'));
  empty.dispose();
});

test('chunk meshing removes shared boundary faces and preserves the complete surface', () => {
  const voxels = Array.from({ length: 32 * 16 * 16 }, (_, i) => ({
    x: i % 32,
    y: Math.floor(i / 32) % 16,
    z: Math.floor(i / 512),
    color: 0x789b55,
  }));
  const asset = assetSchema.parse({
      id: 'land',
      name: 'Land',
      model: createModelDocument(voxels),
    }),
    complete = createVoxelGeometry(asset),
    chunks = createVoxelGeometryChunks(asset, [], 16);
  assert.equal(complete.index!.count, 36);
  assert.equal(chunks.length, 2);
  assert.equal(
    chunks.reduce((sum, chunk) => sum + chunk.geometry.index!.count, 0),
    60,
  );

  const area = (geometry: THREE.BufferGeometry, origin: [number, number, number]) => {
    const p = geometry.getAttribute('position'),
      n = geometry.getAttribute('normal');
    let visible = 0;
    for (let i = 0; i < geometry.index!.count; i += 3) {
      const ids = [0, 1, 2].map((j) => geometry.index!.getX(i + j)),
        [a, b, c] = ids.map((j) =>
          new THREE.Vector3().fromBufferAttribute(p, j).add(new THREE.Vector3(...origin)),
        );
      visible += b.sub(a).cross(c.sub(a)).length() / 2;
      const normal = new THREE.Vector3().fromBufferAttribute(n, ids[0]);
      if (Math.abs(normal.x) === 1)
        assert.notEqual(a.x, 15.5, 'Adjacent chunks must not generate a hidden internal plane.');
    }
    return visible;
  };
  const fullArea = area(complete, [0, 0, 0]);
  assert.equal(
    chunks.reduce((sum, chunk) => sum + area(chunk.geometry, chunk.origin), 0),
    fullArea,
  );
  assert.equal(fullArea, 2 * (32 * 16 + 32 * 16 + 16 * 16));
  complete.dispose();
  chunks.forEach(({ geometry }) => geometry.dispose());
});

test('coarse terrain cells preserve broad peak heights at medium and far detail', () => {
  const peakHeights = [2, 8, 2];
  const voxels: Array<{ x: number; y: number; z: number; color: number }> = [];
  for (let x = 0; x < 18; x++) {
    const height = peakHeights[Math.floor(x / 6)];
    for (let z = 0; z < 6; z++) for (let y = 0; y <= height; y++) voxels.push({ x, y, z, color: 0x789b55 });
  }
  const asset = assetSchema.parse({
    id: 'silhouette',
    name: 'Silhouette',
    model: createModelDocument(voxels),
  });

  const topHeights = (cellSize: number, width: number, depth: number) => {
    const chunks = createTerrainLodGeometryChunks(asset, 16, cellSize);
    const contains = (x: number, z: number, a: number[], b: number[], c: number[]) => {
      const side = (first: number[], second: number[]) =>
        (second[0] - first[0]) * (z - first[2]) - (second[2] - first[2]) * (x - first[0]);
      const sides = [side(a, b), side(b, c), side(c, a)];
      return !(sides.some((value) => value < -1e-6) && sides.some((value) => value > 1e-6));
    };
    const profile: [string, number | null][] = [];
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        let height = -Infinity;
        for (const { origin, geometry } of chunks) {
          const positions = geometry.getAttribute('position');
          const normals = geometry.getAttribute('normal');
          const indices = geometry.index!;
          for (let triangle = 0; triangle < indices.count; triangle += 3) {
            const vertices = [0, 1, 2].map((offset) => indices.getX(triangle + offset));
            if (normals.getY(vertices[0]) !== 1) continue;
            const points = vertices.map((vertex) => [
              origin[0] + positions.getX(vertex),
              origin[1] + positions.getY(vertex),
              origin[2] + positions.getZ(vertex),
            ]);
            if (contains(x, z, points[0], points[1], points[2])) height = Math.max(height, points[0][1]);
          }
        }
        profile.push([`${x},${z}`, Number.isFinite(height) ? height : null]);
      }
    }
    for (const { geometry } of chunks) geometry.dispose();
    return profile;
  };

  assert.deepEqual(topHeights(4, 5, 2), [
    ['0,0', 2.5],
    ['1,0', 8.5],
    ['2,0', 8.5],
    ['3,0', 2.5],
    ['4,0', 2.5],
    ['0,1', 2.5],
    ['1,1', 8.5],
    ['2,1', 8.5],
    ['3,1', 2.5],
    ['4,1', 2.5],
  ]);
  assert.deepEqual(topHeights(6, 3, 1), [
    ['0,0', 2.5],
    ['1,0', 8.5],
    ['2,0', 2.5],
  ]);
});
