import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  terrainCaveNetworkBranchContains,
  terrainCaveNetworkBranches,
  createTerrainCaveNetworkPath,
  createTerrainCaveNetworkConnectorSampler,
  createTerrainSurfaceSampler,
  createTerrainVolumeSampler,
  terrainCaveEntrancesIn,
} from '../services/terrainNoise';
import { worldDocumentSchema } from '../services/worldDocument';
import { WorldStreamRenderer } from '../runtime/WorldStreamRenderer';
import { WorldVoxelRenderer } from '../runtime/WorldVoxelRenderer';
import { WorldStreamGeometryBuilder } from '../runtime/worldStreamGeometry';

function world(
  size: [number, number] = [256, 256],
  baseHeight = 40,
  amplitude = 40,
  origin: [number, number] = [0, 0],
) {
  return worldDocumentSchema.parse({
    id: 'lod-world',
    name: 'LOD world',
    seed: 42,
    chunkSize: 32,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      origin,
      size,
      minY: 0,
      maxY: 100,
      baseHeight,
      amplitude,
      noise: 1,
      palette: { surface: 0x55aa44, subsurface: 0x725439, deep: 0x686b70, materialType: 'STANDARD' },
    },
    edits: [],
  });
}

function productionMountainWorld() {
  return worldDocumentSchema.parse({
    id: 'mountain-world',
    name: 'High ridge',
    seed: 817,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      origin: [-512, -512],
      size: [1024, 1024],
      minY: -32,
      maxY: 192,
      baseHeight: 18,
      amplitude: 85,
      noise: 0.82,
      landformScale: 96,
      palette: {
        surface: 0x79a94e,
        subsurface: 0x806044,
        deep: 0x5e6269,
        surfaceDepth: 3,
        subsurfaceDepth: 6,
        materialType: 'STANDARD',
      },
    },
    edits: [],
  });
}

function meshes(renderer: WorldStreamRenderer) {
  return renderer.group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
}

function buildUntil(renderer: WorldStreamRenderer, target: THREE.Vector3, ready: () => boolean, limit = 80) {
  for (let frame = 0; frame < limit && !ready(); frame++) renderer.update(target);
  assert.ok(ready(), `Expected renderer state after at most ${limit} updates.`);
}

function productionCameraHits(
  renderer: WorldStreamRenderer,
  cameraPosition: [number, number, number],
  target: [number, number, number],
  pixels: [number, number][],
) {
  renderer.group.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 720 / 568, 0.1, 2000);
  camera.position.fromArray(cameraPosition);
  camera.lookAt(new THREE.Vector3(...target));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  return pixels.map(([x, y]) => {
    raycaster.setFromCamera(new THREE.Vector2(2 * ((x + 0.5) / 720) - 1, 1 - 2 * ((y + 0.5) / 568)), camera);
    return raycaster.intersectObjects(renderer.group.children, true)[0] ?? null;
  });
}

function hasBoundaryTriangle(
  mesh: THREE.Mesh,
  voxelSize: number,
  axis: 'x' | 'z',
  boundary: number,
  first: [number, number],
  second: [number, number],
) {
  const positions = mesh.geometry.getAttribute('position');
  const normals = mesh.geometry.getAttribute('normal');
  const indices = mesh.geometry.index!;
  const worldPoint = (vertex: number) => {
    const x = (mesh.position.x + positions.getX(vertex) * mesh.scale.x) / voxelSize;
    const y = (mesh.position.y + positions.getY(vertex) * mesh.scale.y) / voxelSize;
    const z = (mesh.position.z + positions.getZ(vertex) * mesh.scale.z) / voxelSize;
    return { x, y, z, fixed: axis === 'x' ? x : z, along: axis === 'x' ? z : x };
  };
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    if (vertices.some((vertex) => normals.getY(vertex) <= 1e-6)) continue;
    const points = vertices.map(worldPoint);
    const crossY =
      (points[1].z - points[0].z) * (points[2].x - points[0].x) -
      (points[1].x - points[0].x) * (points[2].z - points[0].z);
    if (crossY <= 1e-6) continue;
    const onBoundary = points.filter((point) => Math.abs(point.fixed - boundary) < 1e-6);
    if (onBoundary.length < 2) continue;
    const has = (expected: [number, number]) =>
      onBoundary.some(
        (point) => Math.abs(point.along - expected[0]) < 1e-6 && Math.abs(point.y - expected[1]) < 1e-6,
      );
    if (has(first) && has(second)) return true;
  }
  return false;
}

function hasUpwardTriangleCovering(mesh: THREE.Mesh, voxelSize: number, x: number, z: number) {
  const positions = mesh.geometry.getAttribute('position');
  const normals = mesh.geometry.getAttribute('normal');
  const indices = mesh.geometry.index!;
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    if (vertices.some((vertex) => normals.getY(vertex) <= 1e-6)) continue;
    const points = vertices.map((vertex) => ({
      x: (mesh.position.x + positions.getX(vertex) * mesh.scale.x) / voxelSize,
      z: (mesh.position.z + positions.getZ(vertex) * mesh.scale.z) / voxelSize,
    }));
    const [a, b, c] = points;
    const crossY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (crossY <= 1e-6) continue;
    const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(denominator) <= 1e-10) continue;
    const first = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
    const second = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
    const third = 1 - first - second;
    if (first >= -1e-7 && second >= -1e-7 && third >= -1e-7) return true;
  }
  return false;
}

function boundarySideTriangleCount(
  mesh: THREE.Mesh,
  voxelSize: number,
  axis: 'x' | 'z',
  boundary: number,
  outwardSide: -1 | 1,
) {
  const positions = mesh.geometry.getAttribute('position');
  const normals = mesh.geometry.getAttribute('normal');
  const indices = mesh.geometry.index!;
  let count = 0;
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    if (vertices.some((vertex) => Math.abs(normals.getY(vertex)) > 1e-6)) continue;
    const normal = axis === 'x' ? normals.getX(vertices[0]) : normals.getZ(vertices[0]);
    if (normal * outwardSide < 0.9) continue;
    const fixed = vertices.map((vertex) => {
      const coordinate = axis === 'x' ? positions.getX(vertex) : positions.getZ(vertex);
      const translation = axis === 'x' ? mesh.position.x : mesh.position.z;
      const scale = axis === 'x' ? mesh.scale.x : mesh.scale.z;
      return (translation + coordinate * scale) / voxelSize;
    });
    if (fixed.every((value) => Math.abs(value - boundary) < 1e-6)) count++;
  }
  return count;
}

function verticalSideTriangleCount(mesh: THREE.Mesh) {
  const normals = mesh.geometry.getAttribute('normal');
  const indices = mesh.geometry.index!;
  let count = 0;
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    if (
      vertices.every((vertex) => Math.abs(normals.getY(vertex)) <= 1e-6) &&
      vertices.some((vertex) => Math.abs(normals.getX(vertex)) > 0.9 || Math.abs(normals.getZ(vertex)) > 0.9)
    )
      count++;
  }
  return count;
}

function diagonalVerticalBridgeTriangleCount(mesh: THREE.Mesh) {
  const normals = mesh.geometry.getAttribute('normal');
  const indices = mesh.geometry.index!;
  let count = 0;
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    if (
      vertices.every((vertex) => Math.abs(normals.getY(vertex)) <= 1e-6) &&
      Math.abs(normals.getX(vertices[0])) > 0.1 &&
      Math.abs(normals.getZ(vertices[0])) > 0.1
    )
      count++;
  }
  return count;
}

function worldNormalY(hit: THREE.Intersection<THREE.Object3D>) {
  if (!hit.face) return 0;
  return hit.face.normal
    .clone()
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
    .normalize().y;
}

function coarseCornerHeight(
  surfaceAt: (x: number, z: number) => number,
  cornerX: number,
  cornerZ: number,
  spacing: number,
) {
  let total = 0;
  let samples = 0;
  for (let z = cornerZ - 1; z <= cornerZ; z++) {
    for (let x = cornerX - 1; x <= cornerX; x++) {
      let top: number | null = null;
      for (let zOffset = 0; zOffset < spacing; zOffset++)
        for (let xOffset = 0; xOffset < spacing; xOffset++)
          top = Math.max(top ?? -Infinity, surfaceAt(x * spacing + xOffset, z * spacing + zOffset));
      if (top !== null) {
        total += top + 0.5;
        samples++;
      }
    }
  }
  return samples ? total / samples : -0.5;
}

test('coarse shading blends surface normals in world proportions at every LOD spacing', () => {
  const value = { color: 0x79a94e, materialType: 'STANDARD' as const };
  const topAt = (x: number, z: number) => 1000 + x + 2 * z;
  const builder = new WorldStreamGeometryBuilder(
    world(),
    (x, z) => [{ start: 0, end: topAt(x, z) + 1, value }],
    (x, z) => ({ top: topAt(x, z), value }),
  );
  const sampledSurfaceNormal = new THREE.Vector3(-1, 1, -2).normalize();
  for (const spacing of [2, 4, 16]) {
    const geometry = builder.buildCoarseTileGeometry({ x: 0, z: 0 }, spacing, 1, {
      minX: -10000,
      maxX: -9000,
      minZ: -10000,
      maxZ: -9000,
    });
    assert.ok(geometry, 'The reference slope must generate terrain geometry.');
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const index = geometry.index!;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(
      new THREE.Matrix4().makeScale(spacing, 1, spacing),
    );
    for (let offset = 0; offset < index.count; offset += 3) {
      const ids = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
      const [a, b, c] = ids.map((id) =>
        new THREE.Vector3()
          .fromBufferAttribute(position, id)
          .multiply(new THREE.Vector3(spacing, 1, spacing)),
      );
      const faceNormal = b.sub(a).cross(c.sub(a)).normalize();
      const expected = faceNormal.add(sampledSurfaceNormal).normalize();
      for (const id of ids) {
        const shadedNormal = new THREE.Vector3()
          .fromBufferAttribute(normal, id)
          .applyMatrix3(normalMatrix)
          .normalize();
        assert.ok(
          shadedNormal.dot(expected) > 1 - 1e-6,
          `Spacing ${spacing} must retain the physical 50% shading blend after the mesh normal transform.`,
        );
      }
    }
    geometry.dispose();
  }
});

test('world framing respects a compact map and clears the generated height envelope', () => {
  const compact = WorldStreamRenderer.view(world([256, 256]));
  const broad = WorldStreamRenderer.view(world([1024, 1024]));
  assert.ok(compact.distance < broad.distance, 'Small maps start with a closer view.');
  assert.equal(broad.distance, 50, 'A wider map frames the 50 meter terrain height range.');
  assert.ok(broad.horizonDistance > broad.distance);
});

test('far terrain preserves the mountain silhouette with finer vertical than horizontal detail', () => {
  const selected = world();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const farTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'far' &&
        mesh.userData.worldFarTile?.x === 2 &&
        mesh.userData.worldFarTile?.z === 0,
    );
  buildUntil(renderer, target, () => farTile() !== undefined);

  const tile = farTile()!;
  tile.geometry.computeBoundingBox();
  const surfaceAt = createTerrainSurfaceSampler(selected);
  let expectedTop = selected.generator.minY;
  for (let z = 0; z < 64; z++)
    for (let x = 128; x < 192; x++) expectedTop = Math.max(expectedTop, surfaceAt(x, z));
  assert.ok(expectedTop > selected.generator.baseHeight, 'The source terrain has distant relief.');
  assert.equal(tile.geometry.boundingBox!.max.y, expectedTop + 0.5);
  assert.deepEqual(tile.scale.toArray(), [2, selected.voxelSize, 2]);
  assert.ok(tile.userData.worldFarTile.x * 64 > 95, 'This mesh lies beyond the medium window.');
  renderer.dispose();
});

test('far terrain uses the generated voxel3d overhang in its distant silhouette', () => {
  const base = world([256, 256], 40, 0);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      overhangDensity: 1,
      overhangMaxHeight: 24,
    },
  });
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const geometry = renderer.buildTileGeometry('far', { x: 2, z: 0 }, new THREE.Vector3());
  assert.ok(geometry, 'The distant tile is built.');
  const volumeAt = createTerrainVolumeSampler(selected);
  let expectedTop = selected.generator.baseHeight;
  for (let z = 0; z < 64; z++)
    for (let x = 128; x < 192; x++) {
      let top = selected.generator.baseHeight;
      while (
        top < selected.generator.baseHeight + (selected.generator.overhangMaxHeight ?? 8) &&
        volumeAt(x, top + 1, z)
      )
        top++;
      expectedTop = Math.max(expectedTop, top);
    }
  assert.ok(
    expectedTop > selected.generator.baseHeight + 8,
    'The generated sample extends beyond the legacy eight-cell cap.',
  );
  const positions = geometry.getAttribute('position');
  let meshTop = -Infinity;
  for (let vertex = 0; vertex < positions.count; vertex++)
    meshTop = Math.max(meshTop, positions.getY(vertex));
  assert.equal(meshTop, expectedTop + 0.5, 'Far LOD preserves the highest generated overhang silhouette.');
  geometry.dispose();
  renderer.dispose();
});

test('horizon terrain keeps the generated voxel3d overhang silhouette', () => {
  const base = world([512, 512], 40, 0);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      overhangDensity: 1,
      overhangMaxHeight: 24,
    },
  });
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected);
  let expectedTop = selected.generator.minY;
  for (let z = 0; z < 256; z++)
    for (let x = 256; x < 512; x++) {
      const surface = surfaceAt(x, z);
      if (surface === null) continue;
      let columnTop = surface;
      while (
        columnTop < surface + (selected.generator.overhangMaxHeight ?? 8) &&
        volumeAt(x, columnTop + 1, z)
      )
        columnTop++;
      expectedTop = Math.max(expectedTop, columnTop);
    }
  assert.ok(
    expectedTop > selected.generator.baseHeight + 8,
    'The horizon tile contains an overhang above the legacy eight-cell cap.',
  );

  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const geometry = renderer.buildTileGeometry('horizon', { x: 1, z: 0 }, new THREE.Vector3());
  assert.ok(geometry, 'The horizon tile is built.');
  const positions = geometry.getAttribute('position');
  let meshTop = -Infinity;
  for (let vertex = 0; vertex < positions.count; vertex++)
    meshTop = Math.max(meshTop, positions.getY(vertex));
  assert.equal(
    meshTop,
    expectedTop + 0.5,
    'Horizon LOD preserves the highest generated overhang silhouette.',
  );
  geometry.dispose();
  renderer.dispose();
});

test('far and horizon LOD honor zero-density vertical and horizontal overhang controls', () => {
  const base = world([512, 512], 40, 0);
  for (const overhangControl of [
    { overhangProfile: [0] },
    { overhangFootprint: [[0]] },
    { overhangHeightMap: [[0]] },
  ]) {
    const selected = worldDocumentSchema.parse({
      ...base,
      generator: {
        ...base.generator,
        mode: 'voxel3d',
        overhangDensity: 1,
        overhangMaxHeight: 24,
        ...overhangControl,
      },
    });
    const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
    for (const [level, coordinate] of [
      ['far', { x: 2, z: 0 }],
      ['horizon', { x: 1, z: 0 }],
    ] as const) {
      const geometry = renderer.buildTileGeometry(level, coordinate, new THREE.Vector3());
      assert.ok(geometry, `${level} geometry is built.`);
      const positions = geometry.getAttribute('position');
      let meshTop = -Infinity;
      for (let vertex = 0; vertex < positions.count; vertex++)
        meshTop = Math.max(meshTop, positions.getY(vertex));
      assert.equal(meshTop, selected.generator.baseHeight + 0.5, `${level} uses the authored occupancy.`);
      geometry.dispose();
    }
    renderer.dispose();
  }
});

test('far and horizon LOD preserve an authored overhang height map without procedural density', () => {
  const base = world([512, 512], 40, 0);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      overhangDensity: 0,
      overhangMaxHeight: 24,
      overhangHeightMap: [[1]],
    },
  });
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  for (const [level, coordinate] of [
    ['far', { x: 2, z: 0 }],
    ['horizon', { x: 1, z: 0 }],
  ] as const) {
    const geometry = renderer.buildTileGeometry(level, coordinate, new THREE.Vector3());
    assert.ok(geometry, `${level} geometry is built.`);
    const positions = geometry.getAttribute('position');
    let meshTop = -Infinity;
    for (let vertex = 0; vertex < positions.count; vertex++)
      meshTop = Math.max(meshTop, positions.getY(vertex));
    assert.equal(
      meshTop,
      selected.generator.baseHeight + 24 + 0.5,
      `${level} preserves the authored map height.`,
    );
    geometry.dispose();
  }
  renderer.dispose();
});

test('far terrain keeps coarse slopes without internal plate steps', () => {
  const selected = world();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const farTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'far' &&
        mesh.userData.worldFarTile?.x === 2 &&
        mesh.userData.worldFarTile?.z === 0,
    );
  buildUntil(renderer, target, () => farTile() !== undefined);

  const tile = farTile()!;
  tile.geometry.computeBoundingBox();
  const positions = tile.geometry.getAttribute('position');
  const normals = tile.geometry.getAttribute('normal');
  const indices = tile.geometry.index!;
  let slopedTopTriangles = 0;
  let smoothTopTriangles = 0;
  let retainedFaceContrast = 0;
  let interiorSideTriangles = 0;
  const normalAtPoint = new Map<string, THREE.Vector3>();
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    const first = vertices[0];
    const normalY = normals.getY(first);
    if (normalY > 0) {
      if (normalY < 1 - 1e-6) slopedTopTriangles++;
      const vertexNormals = vertices.map(
        (vertex) => new THREE.Vector3(normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex)),
      );
      assert.ok(
        vertexNormals.every((normal) => Math.abs(normal.length() - 1) < 1e-5),
        'Coarse top normals are normalized for lighting.',
      );
      if (vertexNormals.some((normal) => normal.distanceTo(vertexNormals[0]) > 1e-3)) smoothTopTriangles++;
      vertices.forEach((vertex, pointIndex) => {
        const key = [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)]
          .map((coordinate) => coordinate.toFixed(5))
          .join(',');
        const normal = vertexNormals[pointIndex];
        const sharedNormal = normalAtPoint.get(key);
        if (sharedNormal && normal.distanceTo(sharedNormal) > 1e-3) retainedFaceContrast++;
        else if (!sharedNormal) normalAtPoint.set(key, normal);
      });
    }
    if (Math.abs(normalY) > 1e-6) continue;
    const x = vertices.map(
      (vertex) => (tile.position.x + positions.getX(vertex) * tile.scale.x) / selected.voxelSize,
    );
    const z = vertices.map(
      (vertex) => (tile.position.z + positions.getZ(vertex) * tile.scale.z) / selected.voxelSize,
    );
    const [originX, originZ] = selected.generator.origin;
    const [width, depth] = selected.generator.size;
    const worldBoundary =
      (Math.max(...x) - Math.min(...x) < 1e-6 &&
        (Math.abs(x[0] - (originX - 0.5)) < 1e-6 || Math.abs(x[0] - (originX + width - 0.5)) < 1e-6)) ||
      (Math.max(...z) - Math.min(...z) < 1e-6 &&
        (Math.abs(z[0] - (originZ - 0.5)) < 1e-6 || Math.abs(z[0] - (originZ + depth - 0.5)) < 1e-6));
    if (!worldBoundary) interiorSideTriangles++;
  }
  const surfaceAt = createTerrainSurfaceSampler(selected);
  let expectedTop = selected.generator.minY;
  for (let z = 0; z < 64; z++)
    for (let x = 128; x < 192; x++) expectedTop = Math.max(expectedTop, surfaceAt(x, z));

  assert.ok(slopedTopTriangles > 0, 'Adjacent coarse peaks form sloped terrain instead of flat plates.');
  assert.ok(smoothTopTriangles > 0, 'Coarse top fan triangles shade across their shared height samples.');
  assert.ok(retainedFaceContrast > 0, 'The coarse surface retains broad face-to-face shading contrast.');
  assert.equal(interiorSideTriangles, 0, 'Coarse cells do not emit internal vertical step faces.');
  assert.equal(
    tile.geometry.boundingBox!.max.y,
    expectedTop + 0.5,
    'Horizontal LOD preserves the source voxel height without adding vertical quantization.',
  );
  renderer.dispose();
});

test('near-to-medium transition fans meet the detailed non-flat edge at every source cell', () => {
  const selected = world();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const nearTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'near' &&
        mesh.userData.worldTile?.x === 2 &&
        mesh.userData.worldTile?.z === 1,
    );
  const mediumTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'medium' &&
        mesh.userData.worldMediumTile?.x === 1 &&
        mesh.userData.worldMediumTile?.z === 0,
    );
  buildUntil(renderer, target, () => nearTile() !== undefined && mediumTile() !== undefined);

  const near = nearTile()!;
  const medium = mediumTile()!;
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const boundaryX = 47.5;
  const heights = new Set<number>();
  for (let z = 16; z < 32; z++) {
    const top = surfaceAt(47, z) + 0.5;
    heights.add(top);
    assert.ok(
      hasBoundaryTriangle(near, selected.voxelSize, 'x', boundaryX, [z - 0.5, top], [z + 0.5, top]),
      `The near tile exposes its exact top edge at source row ${z}.`,
    );
    assert.ok(
      hasBoundaryTriangle(medium, selected.voxelSize, 'x', boundaryX, [z - 0.5, top], [z + 0.5, top]),
      `The medium transition meets the near top at source row ${z}.`,
    );
  }
  assert.ok(heights.size > 1, 'The shared edge contains real terrain relief.');
  renderer.dispose();
});

test('coarse transition corners morph through the whole band and stop beyond rectangle corners', () => {
  const selected = world([256, 256]);
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [],
    (x, z) => ({ top: x + z, value: { color: 0x55aa44, materialType: 'STANDARD' } }),
  );
  const geometry = builder.buildCoarseTileGeometry({ x: 0, z: 0 }, 4, 2, {
    minX: 0,
    maxX: 32,
    minZ: 0,
    maxZ: 32,
  })!;
  const positions = geometry.getAttribute('position');
  const checkCorner = (x: number, z: number, expectedHeight: number) => {
    const heights: number[] = [];
    for (let vertex = 0; vertex < positions.count; vertex++) {
      if (
        Math.abs(positions.getX(vertex) * 4 - (x - 0.5)) < 1e-6 &&
        Math.abs(positions.getZ(vertex) * 4 - (z - 0.5)) < 1e-6
      )
        heights.push(positions.getY(vertex));
    }
    assert.ok(heights.length > 0, `Corner ${x},${z} is present.`);
    assert.ok(
      heights.every((height) => Math.abs(height - expectedHeight) < 1e-6),
      `Corner ${x},${z} expected ${expectedHeight}, got ${heights.join(',')}.`,
    );
  };
  // Coarse corner x+z+2.5, lower-tier corner x+z+0.5; midpoint blend is 1/2.
  checkCorner(32, 8, 40.5);
  checkCorner(36, 8, 45.5);
  checkCorner(8, 36, 45.5);
  checkCorner(36, 36, 73.5);
  checkCorner(40, 8, 50.5);
  // Being close to the X edge alone must not extend the band along the entire Z axis.
  checkCorner(36, 56, 94.5);
  geometry.dispose();
});

test('coarse transition edges retain lower-tier contour samples between shared corners', () => {
  const selected = world([256, 256]);
  const value = { color: 0x55aa44, materialType: 'STANDARD' as const };
  const topAt = (x: number, z: number) => (x % 4) + (z % 4);
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [],
    (x, z) => ({ top: topAt(x, z), value }),
  );
  const geometry = builder.buildCoarseTileGeometry({ x: 0, z: 0 }, 4, 2, {
    minX: 0,
    maxX: 32,
    minZ: 0,
    maxZ: 32,
  })!;
  const position = geometry.getAttribute('position');
  const samples: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (Math.abs(position.getX(vertex) - 8.875) < 1e-6 && Math.abs(position.getZ(vertex) - 4.375) < 1e-6)
      samples.push(position.getY(vertex));
  }
  assert.ok(samples.length > 0, 'The transition edge includes its lower-tier midpoint sample.');
  assert.ok(
    samples.every((height) => Math.abs(height - 5.5) < 1e-6),
    `The midpoint blends the lower-tier contour with the coarse edge: ${samples.join(',')}.`,
  );
  geometry.dispose();
});

test('near terrain clips voxel-covered side ranges without inventing caps at the cut planes', () => {
  const selected = world();
  const builder = new WorldStreamGeometryBuilder(
    selected,
    (x, z) =>
      x === 0 && z === 0
        ? [{ start: 10, end: 30, value: { color: 0x55aa44, materialType: 'STANDARD' } }]
        : [],
    () => null,
  );
  const geometry = builder.buildNearTileGeometry(
    { x: 0, z: 0 },
    { minX: -32, maxX: 48, minZ: -32, maxZ: 48 },
    [16, 24],
  )!;
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const y = positions.getY(vertex);
    assert.ok(y <= 15.5 || y >= 23.5, 'Side faces stay outside the voxel volume.');
    if (normals.getY(vertex) !== 0)
      assert.ok(y === 9.5 || y === 29.5, 'Only the actual column top and bottom emit horizontal faces.');
  }
  assert.equal(geometry.index!.count / 3, 20, 'Two caps and eight clipped side quads remain.');
  geometry.dispose();
});

test('near-to-medium fan centers smoothly morph toward detailed heights over two coarse cells', () => {
  const selected = world();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const mediumTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'medium' &&
        mesh.userData.worldMediumTile?.x === 1 &&
        mesh.userData.worldMediumTile?.z === 0,
    );
  buildUntil(renderer, target, () => mediumTile() !== undefined);

  const medium = mediumTile()!;
  const positions = medium.geometry.getAttribute('position');
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const checkedSourceX = new Set<number>();
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const x = (medium.position.x + positions.getX(vertex) * medium.scale.x) / selected.voxelSize;
    const z = (medium.position.z + positions.getZ(vertex) * medium.scale.z) / selected.voxelSize;
    if (
      Math.abs((x - 0.5) / 2 - Math.round((x - 0.5) / 2)) > 1e-6 ||
      Math.abs((z - 0.5) / 2 - Math.round((z - 0.5) / 2)) > 1e-6
    )
      continue;
    const sourceX = Math.floor((x - 0.5) / 2) * 2;
    if (![48, 50].includes(sourceX)) continue;
    const sourceZ = Math.floor(z / 2) * 2;
    const sourceHeights = [
      surfaceAt(sourceX, sourceZ),
      surfaceAt(sourceX + 1, sourceZ),
      surfaceAt(sourceX, sourceZ + 1),
      surfaceAt(sourceX + 1, sourceZ + 1),
    ];
    const fineHeight =
      sourceHeights.reduce((total, height) => total + height + 0.5, 0) / sourceHeights.length;
    const coarseHeight = Math.max(...sourceHeights) + 0.5;
    if (Math.abs(coarseHeight - fineHeight) < 0.1) continue;
    const linearBlend = (sourceX + 1 - 48) / 4;
    const blend = linearBlend * linearBlend * (3 - 2 * linearBlend);
    const expectedHeight = fineHeight + (coarseHeight - fineHeight) * blend;
    const actualHeight = (medium.position.y + positions.getY(vertex) * medium.scale.y) / selected.voxelSize;
    assert.ok(
      Math.abs(actualHeight - expectedHeight) < 1e-6,
      `Expected ${expectedHeight}, got ${actualHeight}.`,
    );
    checkedSourceX.add(sourceX);
  }
  assert.deepEqual(
    [...checkedSourceX].sort(),
    [48, 50],
    'Both coarse transition cells expose smooth intermediate heights.',
  );

  renderer.dispose();
});

test('voxel and near terrain share the outer chunk top profile and exposed risers', () => {
  const base = world([128, 128], 40, 16, [-64, -64]);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d' },
  });
  const scene = new THREE.Scene();
  const renderer = new WorldVoxelRenderer(scene, selected);
  const target = new THREE.Vector3(0, 20, 0);
  const nearTile = () =>
    scene
      .getObjectByName(`world:${selected.id}`)
      ?.children.find(
        (child): child is THREE.Mesh =>
          child instanceof THREE.Mesh &&
          child.userData.worldLod === 'near' &&
          child.userData.worldTile?.x === 2 &&
          child.userData.worldTile?.z === 0,
      );
  const outerVoxelMeshes = () =>
    renderer.group.children.filter(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.userData.worldChunk.x === 1 && child.userData.worldChunk.z === 0,
    );
  for (let frame = 0; frame < 120 && (!nearTile() || !outerVoxelMeshes().length); frame++)
    renderer.update(target);
  assert.ok(nearTile(), 'The near heightfield tile next to the voxel window is resident.');
  assert.ok(outerVoxelMeshes().length, 'The outer voxel chunk next to the near tile is resident.');

  const surfaceAt = createTerrainSurfaceSampler(selected);
  const voxelSize = selected.voxelSize;
  const findVoxelTop = (mesh: THREE.Mesh, row: number) =>
    hasUpwardTriangleCovering(mesh, voxelSize, 31.49, row);
  const edgeSide = (mesh: THREE.Mesh, normalX: -1 | 1, row: number) => {
    const positions = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    const indices = mesh.geometry.index!;
    const ys: number[] = [];
    for (let triangle = 0; triangle < indices.count; triangle += 3) {
      const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
      if (
        !vertices.every(
          (vertex) =>
            Math.abs(normals.getX(vertex) - normalX) < 1e-6 && Math.abs(normals.getY(vertex)) < 1e-6,
        )
      )
        continue;
      const points = vertices.map((vertex) => ({
        x: (mesh.position.x + positions.getX(vertex) * mesh.scale.x) / voxelSize,
        y: (mesh.position.y + positions.getY(vertex) * mesh.scale.y) / voxelSize,
        z: (mesh.position.z + positions.getZ(vertex) * mesh.scale.z) / voxelSize,
      }));
      if (
        points.every((point) => Math.abs(point.x - 31.5) < 1e-6) &&
        Math.max(...points.map((point) => point.z)) > row - 0.5 + 1e-6 &&
        Math.min(...points.map((point) => point.z)) < row + 0.5 - 1e-6
      )
        ys.push(...points.map((point) => point.y));
    }
    return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
  };
  const near = nearTile()!;
  const heightsDiffer: number[] = [];
  for (let z = 0; z < 16; z++) {
    const leftTop = surfaceAt(31, z);
    const rightTop = surfaceAt(32, z);
    const voxelChunk = outerVoxelMeshes().find(
      (mesh) => mesh.userData.worldChunk.y === Math.floor(leftTop / 16),
    );
    assert.ok(voxelChunk, `The voxel top chunk exists at row ${z}.`);
    assert.ok(findVoxelTop(voxelChunk!, z), `The voxel top reaches the shared perimeter at source row ${z}.`);
    assert.ok(
      hasUpwardTriangleCovering(near, voxelSize, 32.01, z),
      `The near top begins at the shared perimeter at source row ${z}.`,
    );
    if (leftTop === rightTop) continue;
    heightsDiffer.push(z);
    const expected = [Math.min(leftTop, rightTop) + 0.5, Math.max(leftTop, rightTop) + 0.5];
    const higherSide = leftTop > rightTop ? edgeSide(voxelChunk!, 1, z) : edgeSide(near, -1, z);
    assert.ok(
      higherSide &&
        Math.abs(higherSide[0] - expected[0]) < 1e-6 &&
        Math.abs(higherSide[1] - expected[1]) < 1e-6,
      `The exposed boundary riser spans the exact source profile at row ${z}: ${JSON.stringify({ leftTop, rightTop, expected, higherSide })}.`,
    );
    const duplicateSide = leftTop > rightTop ? edgeSide(near, -1, z) : edgeSide(voxelChunk!, 1, z);
    assert.equal(duplicateSide, null, `Only the higher terrain representation emits the riser at row ${z}.`);
  }
  assert.ok(heightsDiffer.length > 0, 'The checked perimeter contains actual terrain risers.');

  const raycaster = new THREE.Raycaster();
  scene.updateMatrixWorld(true);
  for (const x of [31, 32]) {
    const z = 7;
    raycaster.set(
      new THREE.Vector3(x * voxelSize, 100 * voxelSize, z * voxelSize),
      new THREE.Vector3(0, -1, 0),
    );
    const hit = raycaster.intersectObjects(scene.children, true)[0];
    assert.ok(hit, `A downward camera ray hits the top at x=${x}.`);
    assert.ok(
      Math.abs(hit!.point.y / voxelSize - (surfaceAt(x, z) + 0.5)) < 1e-6,
      `The camera ray returns the exact source top at x=${x}: ${JSON.stringify({ hitY: hit!.point.y / voxelSize, expected: surfaceAt(x, z) + 0.5 })}.`,
    );
  }
  renderer.dispose();
});

test('medium shared tile seams stay covered with identical corner heights at two streamed centers', () => {
  const selected = world();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const cases = [
    { target: new THREE.Vector3(), leftX: 1, rightX: 2, tileZ: 0, seamX: 63.5, startZ: 0 },
    {
      target: new THREE.Vector3(64, 0, 64),
      leftX: 5,
      rightX: 6,
      tileZ: 4,
      seamX: 191.5,
      startZ: 128,
    },
  ];
  const mediumTile = (x: number, z: number) =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'medium' &&
        mesh.userData.worldMediumTile?.x === x &&
        mesh.userData.worldMediumTile?.z === z,
    );

  for (const edge of cases) {
    buildUntil(
      renderer,
      edge.target,
      () => !!mediumTile(edge.leftX, edge.tileZ) && !!mediumTile(edge.rightX, edge.tileZ),
    );
    const left = mediumTile(edge.leftX, edge.tileZ)!;
    const right = mediumTile(edge.rightX, edge.tileZ)!;
    for (let z = edge.startZ + 2; z < edge.startZ + 32; z += 2) {
      const sharedHeights = (mesh: THREE.Mesh) => {
        const positions = mesh.geometry.getAttribute('position');
        const normals = mesh.geometry.getAttribute('normal');
        const heights = new Set<number>();
        for (let vertex = 0; vertex < positions.count; vertex++) {
          const x = (mesh.position.x + positions.getX(vertex) * mesh.scale.x) / selected.voxelSize;
          const sourceZ = (mesh.position.z + positions.getZ(vertex) * mesh.scale.z) / selected.voxelSize;
          if (
            normals.getY(vertex) <= 1e-6 ||
            Math.abs(x - edge.seamX) > 1e-6 ||
            Math.abs(sourceZ - (z - 0.5)) > 1e-6
          )
            continue;
          heights.add((mesh.position.y + positions.getY(vertex) * mesh.scale.y) / selected.voxelSize);
        }
        return [...heights].sort((a, b) => a - b);
      };
      assert.deepEqual(
        sharedHeights(left),
        sharedHeights(right),
        `Adjacent medium tiles share the same top vertices at (${edge.seamX}, ${z}).`,
      );
    }
    assert.ok(
      hasUpwardTriangleCovering(left, selected.voxelSize, edge.seamX - 0.125, edge.startZ + 15.5),
      `The left medium tile covers up to seam ${edge.seamX}.`,
    );
    assert.ok(
      hasUpwardTriangleCovering(right, selected.voxelSize, edge.seamX + 0.125, edge.startZ + 15.5),
      `The right medium tile covers beyond seam ${edge.seamX}.`,
    );
  }
  renderer.dispose();
});

test('production near-to-medium seams preserve winding and suppress only outer near cliffs', () => {
  const selected = productionMountainWorld();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3(-0.25, 9, -0.25);
  const findTile = (lod: 'near' | 'medium', x: number, z: number) =>
    meshes(renderer).find((mesh) => {
      const coordinate = lod === 'near' ? mesh.userData.worldTile : mesh.userData.worldMediumTile;
      return mesh.userData.worldLod === lod && coordinate?.x === x && coordinate?.z === z;
    });
  const edges: {
    name: string;
    axis: 'x' | 'z';
    boundary: number;
    nearSide: -1 | 1;
    nearTile: (alongCell: number) => [number, number];
    mediumTile: (alongCell: number) => [number, number];
  }[] = [
    {
      name: '+X',
      axis: 'x' as const,
      boundary: 31.5,
      nearSide: -1 as const,
      nearTile: (along: number) => [1, Math.floor(along / 16)],
      mediumTile: (along: number) => [1, Math.floor(along / 32)],
    },
    {
      name: '-X',
      axis: 'x' as const,
      boundary: -48.5,
      nearSide: 1 as const,
      nearTile: (along: number) => [-3, Math.floor(along / 16)],
      mediumTile: (along: number) => [-2, Math.floor(along / 32)],
    },
    {
      name: '+Z',
      axis: 'z' as const,
      boundary: 31.5,
      nearSide: -1 as const,
      nearTile: (along: number) => [Math.floor(along / 16), 1],
      mediumTile: (along: number) => [Math.floor(along / 32), 1],
    },
    {
      name: '-Z',
      axis: 'z' as const,
      boundary: -48.5,
      nearSide: 1 as const,
      nearTile: (along: number) => [Math.floor(along / 16), -3],
      mediumTile: (along: number) => [Math.floor(along / 32), -2],
    },
  ];
  buildUntil(
    renderer,
    target,
    () => renderer.stats().renderedChunks === 25 && renderer.stats().renderedMediumChunks === 21,
  );

  const surfaceAt = createTerrainSurfaceSampler(selected);
  for (const edge of edges) {
    const outwardSide = edge.nearSide === -1 ? 1 : -1;
    for (let alongCell = -48; alongCell < 32; alongCell++) {
      const near = findTile('near', ...edge.nearTile(alongCell))!;
      const medium = findTile('medium', ...edge.mediumTile(alongCell))!;
      const top =
        edge.axis === 'x'
          ? surfaceAt(Math.floor(edge.boundary + edge.nearSide * 0.5), alongCell) + 0.5
          : surfaceAt(alongCell, Math.floor(edge.boundary + edge.nearSide * 0.5)) + 0.5;
      const segment: [[number, number], [number, number]] = [
        [alongCell - 0.5, top],
        [alongCell + 0.5, top],
      ];
      for (const mesh of [near, medium])
        assert.ok(
          hasBoundaryTriangle(mesh, selected.voxelSize, edge.axis, edge.boundary, segment[0], segment[1]),
          `${mesh.userData.worldLod} exposes an upward-facing ${edge.name} boundary segment at ${alongCell}.`,
        );

      for (const alongOffset of [-0.25, 0, 0.25]) {
        const nearFixed = edge.boundary + edge.nearSide * 0.125;
        const farFixed = edge.boundary - edge.nearSide * 0.125;
        const along = alongCell + alongOffset;
        assert.ok(
          hasUpwardTriangleCovering(
            near,
            selected.voxelSize,
            edge.axis === 'x' ? nearFixed : along,
            edge.axis === 'x' ? along : nearFixed,
          ),
          `The near mesh covers the ${edge.name} edge from inside at source row ${alongCell}.`,
        );
        assert.ok(
          hasUpwardTriangleCovering(
            medium,
            selected.voxelSize,
            edge.axis === 'x' ? farFixed : along,
            edge.axis === 'x' ? along : farFixed,
          ),
          `The medium mesh covers the ${edge.name} edge from outside at source row ${alongCell}.`,
        );
      }

      assert.equal(
        boundarySideTriangleCount(near, selected.voxelSize, edge.axis, edge.boundary, outwardSide),
        0,
        `The near mesh has no outward vertical cliff faces along the ${edge.name} LOD edge.`,
      );
    }
  }

  const nearBounds = { minX: -48.5, maxX: 31.5, minZ: -48.5, maxZ: 31.5 };
  for (const mesh of meshes(renderer).filter((candidate) => candidate.userData.worldLod === 'medium')) {
    const positions = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    const indices = mesh.geometry.index!;
    for (let triangle = 0; triangle < indices.count; triangle += 3) {
      const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
      if (vertices.some((vertex) => normals.getY(vertex) <= 1e-6)) continue;
      const x = vertices.map(
        (vertex) => (mesh.position.x + positions.getX(vertex) * mesh.scale.x) / selected.voxelSize,
      );
      const z = vertices.map(
        (vertex) => (mesh.position.z + positions.getZ(vertex) * mesh.scale.z) / selected.voxelSize,
      );
      assert.ok(
        Math.min(...x) >= nearBounds.maxX ||
          Math.max(...x) <= nearBounds.minX ||
          Math.min(...z) >= nearBounds.maxZ ||
          Math.max(...z) <= nearBounds.minZ,
        'Medium top triangles do not cross into the offset near-tier window.',
      );
    }
  }

  const near = findTile('near', -1, -1)!;
  assert.ok(
    verticalSideTriangleCount(near) > 0,
    'Interior near-tier cliffs remain where adjacent detailed columns have different heights.',
  );
  renderer.dispose();
});

test('production far-to-horizon edge profiles meet with upward-facing triangles on all four sides', () => {
  const selected = productionMountainWorld();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3(-0.25, 9, -0.25);
  const findTile = (lod: 'far' | 'horizon', x: number, z: number) =>
    meshes(renderer).find((mesh) => {
      const coordinate = lod === 'far' ? mesh.userData.worldFarTile : mesh.userData.worldHorizonTile;
      return mesh.userData.worldLod === lod && coordinate?.x === x && coordinate?.z === z;
    });
  const edges: {
    name: string;
    axis: 'x' | 'z';
    boundary: number;
    farTile: (alongCell: number) => [number, number];
    horizonTile: (alongCell: number) => [number, number];
    corner: (alongCell: number) => [number, number];
  }[] = [
    {
      name: '+X',
      axis: 'x',
      boundary: 127.5,
      farTile: (along) => [1, Math.floor(along / 64)],
      horizonTile: (along) => [0, Math.floor(along / 256)],
      corner: (along) => [32, along / 4],
    },
    {
      name: '-X',
      axis: 'x',
      boundary: -192.5,
      farTile: (along) => [-3, Math.floor(along / 64)],
      horizonTile: (along) => [-1, Math.floor(along / 256)],
      corner: (along) => [-48, along / 4],
    },
    {
      name: '+Z',
      axis: 'z',
      boundary: 127.5,
      farTile: (along) => [Math.floor(along / 64), 1],
      horizonTile: (along) => [Math.floor(along / 256), 0],
      corner: (along) => [along / 4, 32],
    },
    {
      name: '-Z',
      axis: 'z',
      boundary: -192.5,
      farTile: (along) => [Math.floor(along / 64), -3],
      horizonTile: (along) => [Math.floor(along / 256), -1],
      corner: (along) => [along / 4, -48],
    },
  ];
  buildUntil(
    renderer,
    target,
    () =>
      renderer.stats().renderedChunks === 25 &&
      renderer.stats().renderedMediumChunks === 21 &&
      renderer.stats().renderedFarChunks === 21,
    80,
  );
  for (let frame = 0; frame < 40 && renderer.stats().renderedHorizonChunks < 16; frame++)
    renderer.update(target);
  assert.equal(renderer.stats().renderedHorizonChunks, 16, 'The full production horizon window is resident.');

  const surfaceAt = createTerrainSurfaceSampler(selected);
  for (const edge of edges) {
    for (let alongCell = -192; alongCell < 128; alongCell += 4) {
      const [cornerX, cornerZ] = edge.corner(alongCell);
      const first = coarseCornerHeight(surfaceAt, cornerX, cornerZ, 4);
      const second =
        edge.axis === 'x'
          ? coarseCornerHeight(surfaceAt, cornerX, cornerZ + 1, 4)
          : coarseCornerHeight(surfaceAt, cornerX + 1, cornerZ, 4);
      const segment: [[number, number], [number, number]] = [
        [alongCell - 0.5, first],
        [alongCell + 3.5, second],
      ];
      for (const [lod, coordinate] of [
        ['far', edge.farTile(alongCell)],
        ['horizon', edge.horizonTile(alongCell)],
      ] as const) {
        const mesh = findTile(lod, ...coordinate);
        assert.ok(mesh, `The ${lod} tile exists at ${edge.name} source segment ${alongCell}.`);
        assert.ok(
          hasBoundaryTriangle(mesh, selected.voxelSize, edge.axis, edge.boundary, segment[0], segment[1]),
          `${lod} has an upward-facing ${edge.name} edge segment at ${alongCell}.`,
        );
      }
    }
  }
  renderer.dispose();
});

test('horizon LOD boundary corners do not emit diagonal vertical bridge triangles', () => {
  const selected = productionMountainWorld();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3(0, 26, 0);
  buildUntil(
    renderer,
    target,
    () => renderer.stats().renderedHorizonChunks === 16 && renderer.stats().renderedFarChunks === 21,
    110,
  );

  const counts = meshes(renderer)
    .filter((mesh) => mesh.userData.worldLod === 'horizon')
    .map((mesh) => ({
      tile: mesh.userData.worldHorizonTile,
      triangles: diagonalVerticalBridgeTriangleCount(mesh),
    }))
    .filter(({ triangles }) => triangles > 0);
  assert.equal(
    counts.reduce((total, tile) => total + tile.triangles, 0),
    0,
    `Horizon transition corners have no diagonal vertical bridge triangles: ${JSON.stringify(counts)}`,
  );
  renderer.dispose();
});

test('production camera rays through the saved LOD seam gaps hit closed terrain geometry', () => {
  const selected = productionMountainWorld();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const defaultTarget = new THREE.Vector3(-0.25, 9, -0.25);
  buildUntil(
    renderer,
    defaultTarget,
    () =>
      renderer.stats().renderedChunks === 25 &&
      renderer.stats().renderedMediumChunks === 21 &&
      renderer.stats().renderedFarChunks === 21 &&
      renderer.stats().renderedHorizonChunks === 16,
    110,
  );
  const defaultHits = productionCameraHits(
    renderer,
    [59.370969, 60.671507, 79.244625],
    [-0.25, 9, -0.25],
    [
      [342, 132],
      [360, 132],
      [390, 132],
      [430, 132],
      [46, 105],
    ],
  );
  assert.ok(
    defaultHits.every(Boolean),
    'All saved default-view background wedges are covered by terrain facets.',
  );
  assert.ok(
    defaultHits.every((hit) => hit && worldNormalY(hit) > 0.02),
    'Default seam pixels hit upward-facing terrain.',
  );
  renderer.dispose();

  const nearTarget = new THREE.Vector3(0, 26, 0);
  const nearRenderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  buildUntil(
    nearRenderer,
    nearTarget,
    () =>
      nearRenderer.stats().renderedChunks === 25 &&
      nearRenderer.stats().renderedMediumChunks === 21 &&
      nearRenderer.stats().renderedFarChunks === 21 &&
      nearRenderer.stats().renderedHorizonChunks === 16,
    110,
  );
  const nearHits = productionCameraHits(
    nearRenderer,
    [0, 54, 82],
    [0, 26, 0],
    [
      [335, 235],
      [330, 240],
      [307, 250],
      [302, 255],
      [319, 247],
      [478, 290],
      [96, 240],
      [95, 239],
      [94, 238],
    ],
  );
  assert.ok(
    nearHits.every(Boolean),
    'Saved near-view seam gaps and adjacent pixels intersect terrain geometry.',
  );
  assert.ok(
    nearHits.every((hit) => hit && worldNormalY(hit) > 0.02),
    `Near seam pixels hit upward-facing terrain: ${JSON.stringify(
      nearHits.map((hit) =>
        hit
          ? {
              lod: hit.object.userData.worldLod,
              point: hit.point.toArray(),
              normalY: worldNormalY(hit),
              faceNormal: hit.face?.normal.toArray(),
            }
          : null,
      ),
    )}`,
  );
  nearRenderer.dispose();

  const horizonRenderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const horizonTarget = new THREE.Vector3(0, 20, 100);
  buildUntil(
    horizonRenderer,
    horizonTarget,
    () =>
      horizonRenderer.stats().renderedChunks === 25 &&
      horizonRenderer.stats().renderedMediumChunks === 21 &&
      horizonRenderer.stats().renderedFarChunks === 21 &&
      horizonRenderer.stats().renderedHorizonChunks === 16,
    110,
  );
  const horizonHits = productionCameraHits(horizonRenderer, [0, 40, -80], [0, 20, 100], [[640, 343]]);
  assert.ok(horizonHits.every(Boolean), 'The saved horizon spike pixel intersects terrain geometry.');
  assert.ok(
    horizonHits.every((hit) => hit && worldNormalY(hit) > 0.02),
    'Horizon seam pixels hit upward-facing terrain.',
  );
  horizonRenderer.dispose();
});

test('horizon terrain keeps distant peaks with finer vertical than horizontal detail', () => {
  const selected = world([2048, 2048]);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const horizonTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'horizon' &&
        mesh.userData.worldHorizonTile?.x === 1 &&
        mesh.userData.worldHorizonTile?.z === 0,
    );
  buildUntil(renderer, target, () => horizonTile() !== undefined);

  const tile = horizonTile()!;
  tile.geometry.computeBoundingBox();
  const surfaceAt = createTerrainSurfaceSampler(selected);
  let expectedTop = selected.generator.minY;
  for (let z = 0; z < 256; z++)
    for (let x = 256; x < 512; x++) expectedTop = Math.max(expectedTop, surfaceAt(x, z));
  assert.ok(expectedTop > selected.generator.baseHeight, 'The horizon source terrain has distant relief.');
  assert.equal(tile.geometry.boundingBox!.max.y, expectedTop + 0.5);
  assert.deepEqual(tile.scale.toArray(), [8, selected.voxelSize, 8]);
  assert.ok(tile.position.x / selected.voxelSize >= 192, 'The tile starts beyond the 4× far window.');
  renderer.dispose();
});

test('horizon LOD includes sparse edited columns above the generated surface', () => {
  const editedColor = 0xff00ff;
  const selected = world([1024, 1024]);
  selected.edits.push({
    x: 240,
    y: 200,
    z: 240,
    value: { color: editedColor, materialType: 'EMISSIVE' },
  });
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const geometry = renderer.buildTileGeometry('horizon', { x: 0, z: 0 }, new THREE.Vector3())!;
  geometry.computeBoundingBox();
  assert.equal(geometry.boundingBox!.max.y, 200.5);

  const positions = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color');
  let retainedEditedSurfaceColor = false;
  for (let vertex = 0; vertex < positions.count; vertex++) {
    if (positions.getY(vertex) !== 200.5) continue;
    if (colors.getX(vertex) === 1 && colors.getY(vertex) === 0 && colors.getZ(vertex) === 1) {
      retainedEditedSurfaceColor = true;
      break;
    }
  }
  assert.ok(retainedEditedSurfaceColor, 'The highest edited column supplies the coarse surface color.');
  geometry.dispose();
  renderer.dispose();
});

test('coarse LOD averages generated surface colors in linear light while retaining peak height', () => {
  const selected = world([64, 64]);
  const builder = new WorldStreamGeometryBuilder(
    selected,
    () => [{ start: 0, end: 11, value: { color: 0xff0000, materialType: 'STANDARD' } }],
    (x) => ({
      top: 10,
      value: { color: x % 2 ? 0x0000ff : 0xff0000, materialType: 'STANDARD' },
    }),
  );
  const geometry = builder.buildCoarseTileGeometry({ x: 0, z: 0 }, 2, 1, {
    minX: 1000,
    maxX: 2000,
    minZ: 1000,
    maxZ: 2000,
  })!;
  const colors = geometry.getAttribute('color');
  const actual = new THREE.Color().setRGB(colors.getX(0), colors.getY(0), colors.getZ(0)).getHex();
  const expected = new THREE.Color(0).add(new THREE.Color(0xff0000)).add(new THREE.Color(0x0000ff));
  expected.multiplyScalar(0.5);

  assert.equal(actual, expected.getHex());
  geometry.computeBoundingBox();
  assert.equal(geometry.boundingBox!.max.y, 10.5);
  geometry.dispose();
});

test('coarse LOD keeps the highest authored surface color while preserving the tallest source height', () => {
  const authoredColor = 0xff00ff;
  const generatedColor = 0x224466;
  const topAt = (x: number, z: number) => (x === 0 && z === 0 ? 8 : 10);
  const valueAt = (x: number, z: number) => ({
    color: x === 0 && z === 0 ? authoredColor : generatedColor,
    materialType: 'STANDARD' as const,
  });
  const builder = new WorldStreamGeometryBuilder(
    world([64, 64]),
    (x, z) => [{ start: 0, end: topAt(x, z) + 1, value: valueAt(x, z) }],
    (x, z) => ({ top: topAt(x, z), value: valueAt(x, z) }),
    (x, y, z) => x === 0 && y === 8 && z === 0,
  );
  const geometry = builder.buildCoarseTileGeometry({ x: 0, z: 0 }, 2, 1, {
    minX: 1000,
    maxX: 2000,
    minZ: 1000,
    maxZ: 2000,
  })!;
  const colors = geometry.getAttribute('color');
  const actual = new THREE.Color().setRGB(colors.getX(0), colors.getY(0), colors.getZ(0)).getHex();

  assert.equal(actual, authoredColor, 'A sparse painted surface remains represented in the coarse cell.');
  geometry.computeBoundingBox();
  assert.equal(geometry.boundingBox!.max.y, 10.5, 'Coarse geometry still retains the tallest source column.');
  geometry.dispose();
});

test('far-to-horizon transition fans meet the non-flat far profile at every far-cell edge', () => {
  const selected = world([1024, 1024]);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const farTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'far' &&
        mesh.userData.worldFarTile?.x === 2 &&
        mesh.userData.worldFarTile?.z === 1,
    );
  const horizonTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'horizon' &&
        mesh.userData.worldHorizonTile?.x === 0 &&
        mesh.userData.worldHorizonTile?.z === 0,
    );
  buildUntil(renderer, target, () => farTile() !== undefined && horizonTile() !== undefined);

  const far = farTile()!;
  const horizon = horizonTile()!;
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const boundaryX = 191.5;
  const farCellSpacing = 4;
  let nonFlatSegments = 0;
  for (let segment = 0; segment < 4; segment++) {
    const sourceZ = 64 + segment * farCellSpacing;
    const cornerZ = sourceZ / farCellSpacing;
    const startY = coarseCornerHeight(surfaceAt, 48, cornerZ, farCellSpacing);
    const endY = coarseCornerHeight(surfaceAt, 48, cornerZ + 1, farCellSpacing);
    if (startY !== endY) nonFlatSegments++;
    const edgePoints: [[number, number], [number, number]] = [
      [sourceZ - 0.5, startY],
      [sourceZ + farCellSpacing - 0.5, endY],
    ];
    for (const mesh of [far, horizon])
      assert.ok(
        hasBoundaryTriangle(mesh, selected.voxelSize, 'x', boundaryX, edgePoints[0], edgePoints[1]),
        `${mesh.userData.worldLod} meets the shared profile from source row ${sourceZ}.`,
      );
  }
  assert.ok(nonFlatSegments > 0, 'The checked shared edge contains real terrain slope.');
  renderer.dispose();
});

test('negative-side far-to-horizon fans sample right and front edges along the full profile', () => {
  const selected = world([1024, 1024], 40, 40, [-512, -512]);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const xFarTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'far' &&
        mesh.userData.worldFarTile?.x === -2 &&
        mesh.userData.worldFarTile?.z === 0,
    );
  const xHorizonTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'horizon' &&
        mesh.userData.worldHorizonTile?.x === -1 &&
        mesh.userData.worldHorizonTile?.z === 0,
    );
  const zFarTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'far' &&
        mesh.userData.worldFarTile?.x === 0 &&
        mesh.userData.worldFarTile?.z === -2,
    );
  const zHorizonTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'horizon' &&
        mesh.userData.worldHorizonTile?.x === 0 &&
        mesh.userData.worldHorizonTile?.z === -1,
    );
  buildUntil(
    renderer,
    target,
    () =>
      xFarTile() !== undefined &&
      xHorizonTile() !== undefined &&
      zFarTile() !== undefined &&
      zHorizonTile() !== undefined,
  );

  const surfaceAt = createTerrainSurfaceSampler(selected);
  const voxelSize = selected.voxelSize;
  const farCellSpacing = 4;
  let nonFlatSegments = 0;
  const xBoundary = -128.5;
  for (let segment = 0; segment < farCellSpacing; segment++) {
    const sourceZ = segment * farCellSpacing;
    const cornerZ = sourceZ / farCellSpacing;
    const startY = coarseCornerHeight(surfaceAt, -32, cornerZ, farCellSpacing);
    const endY = coarseCornerHeight(surfaceAt, -32, cornerZ + 1, farCellSpacing);
    if (startY !== endY) nonFlatSegments++;
    const edgePoints: [[number, number], [number, number]] = [
      [sourceZ - 0.5, startY],
      [sourceZ + farCellSpacing - 0.5, endY],
    ];
    for (const mesh of [xFarTile()!, xHorizonTile()!])
      assert.ok(
        hasBoundaryTriangle(mesh, voxelSize, 'x', xBoundary, edgePoints[0], edgePoints[1]),
        `${mesh.userData.worldLod} samples its right seam across source rows ${sourceZ}–${sourceZ + 4}.`,
      );
  }

  const zBoundary = -128.5;
  for (let segment = 0; segment < farCellSpacing; segment++) {
    const sourceX = segment * farCellSpacing;
    const cornerX = sourceX / farCellSpacing;
    const startY = coarseCornerHeight(surfaceAt, cornerX, -32, farCellSpacing);
    const endY = coarseCornerHeight(surfaceAt, cornerX + 1, -32, farCellSpacing);
    if (startY !== endY) nonFlatSegments++;
    const edgePoints: [[number, number], [number, number]] = [
      [sourceX - 0.5, startY],
      [sourceX + farCellSpacing - 0.5, endY],
    ];
    for (const mesh of [zFarTile()!, zHorizonTile()!])
      assert.ok(
        hasBoundaryTriangle(mesh, voxelSize, 'z', zBoundary, edgePoints[0], edgePoints[1]),
        `${mesh.userData.worldLod} samples its front seam across source columns ${sourceX}–${sourceX + 4}.`,
      );
  }
  assert.ok(nonFlatSegments > 0, 'The checked right and front profiles contain real terrain slope.');
  renderer.dispose();
});

test('near and medium top surfaces meet at the near-window edge without covering its interior', () => {
  const selected = world([256, 256], 4, 0);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const nearTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'near' &&
        mesh.userData.worldTile?.x === 2 &&
        mesh.userData.worldTile?.z === 0,
    );
  const mediumTile = () =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === 'medium' &&
        mesh.userData.worldMediumTile?.x === 1 &&
        mesh.userData.worldMediumTile?.z === 0,
    );
  buildUntil(renderer, target, () => nearTile() !== undefined && mediumTile() !== undefined);

  const near = nearTile()!;
  const medium = mediumTile()!;
  near.geometry.computeBoundingBox();
  const nearEdgeInCells =
    (near.position.x + near.geometry.boundingBox!.max.x * near.scale.x) / selected.voxelSize;
  assert.equal(nearEdgeInCells, 47.5);

  const position = medium.geometry.getAttribute('position');
  const topY = selected.generator.baseHeight + 0.5;
  let sharedBoundaryVertex = false;
  const indices = medium.geometry.index!;
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    if (vertices.some((vertex) => position.getY(vertex) !== topY)) continue;
    const xCenter = vertices.reduce((sum, vertex) => sum + position.getX(vertex), 0) / 3;
    const zCenter = vertices.reduce((sum, vertex) => sum + position.getZ(vertex), 0) / 3;
    const worldX = (medium.position.x + xCenter * medium.scale.x) / selected.voxelSize;
    const worldZ = (medium.position.z + zCenter * medium.scale.z) / selected.voxelSize;
    assert.ok(
      !(worldX > -32.5 && worldX < 47.5 && worldZ > -32.5 && worldZ < 47.5),
      'No medium top triangle covers the near-window interior.',
    );
    for (const vertex of vertices) {
      const x = (medium.position.x + position.getX(vertex) * medium.scale.x) / selected.voxelSize;
      const z = (medium.position.z + position.getZ(vertex) * medium.scale.z) / selected.voxelSize;
      if (Math.abs(x - nearEdgeInCells) < 1e-6 && z >= -32.5 && z <= 47.5) sharedBoundaryVertex = true;
    }
  }
  assert.ok(sharedBoundaryVertex, 'Medium terrain reaches the near tile edge exactly.');
  renderer.dispose();
});

test('production medium and far masks meet on all ring edges without duplicate top coverage', () => {
  const selected = productionMountainWorld();
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3(-0.25, 9, -0.25);
  const findTile = (lod: 'medium' | 'far', x: number, z: number) =>
    meshes(renderer).find((mesh) => {
      const coordinate = lod === 'medium' ? mesh.userData.worldMediumTile : mesh.userData.worldFarTile;
      return mesh.userData.worldLod === lod && coordinate?.x === x && coordinate?.z === z;
    });
  const edges: {
    name: string;
    axis: 'x' | 'z';
    boundary: number;
    outward: -1 | 1;
    mediumTile: (alongCell: number) => [number, number];
    farTile: (alongCell: number) => [number, number];
    corner: (alongCell: number) => [number, number];
  }[] = [
    {
      name: '+X',
      axis: 'x',
      boundary: 63.5,
      outward: 1,
      mediumTile: (along) => [1, Math.floor(along / 32)],
      farTile: (along) => [1, Math.floor(along / 64)],
      corner: (along) => [32, along / 2],
    },
    {
      name: '-X',
      axis: 'x',
      boundary: -96.5,
      outward: -1,
      mediumTile: (along) => [-3, Math.floor(along / 32)],
      farTile: (along) => [-2, Math.floor(along / 64)],
      corner: (along) => [-48, along / 2],
    },
    {
      name: '+Z',
      axis: 'z',
      boundary: 63.5,
      outward: 1,
      mediumTile: (along) => [Math.floor(along / 32), 1],
      farTile: (along) => [Math.floor(along / 64), 1],
      corner: (along) => [along / 2, 32],
    },
    {
      name: '-Z',
      axis: 'z',
      boundary: -96.5,
      outward: -1,
      mediumTile: (along) => [Math.floor(along / 32), -3],
      farTile: (along) => [Math.floor(along / 64), -2],
      corner: (along) => [along / 2, -48],
    },
  ];
  buildUntil(
    renderer,
    target,
    () => renderer.stats().renderedChunks === 25 && renderer.stats().renderedMediumChunks === 21,
  );
  for (let frame = 0; frame < 40 && renderer.stats().renderedFarChunks < 21; frame++) renderer.update(target);
  assert.equal(renderer.stats().renderedFarChunks, 21, 'The full medium-adjacent far ring is resident.');

  const surfaceAt = createTerrainSurfaceSampler(selected);
  for (const edge of edges) {
    for (let alongCell = -96; alongCell < 64; alongCell += 2) {
      const medium = findTile('medium', ...edge.mediumTile(alongCell));
      const far = findTile('far', ...edge.farTile(alongCell));
      assert.ok(medium, `The medium tile exists on the ${edge.name} ring edge at ${alongCell}.`);
      assert.ok(far, `The far tile exists on the ${edge.name} ring edge at ${alongCell}.`);
      const [cornerX, cornerZ] = edge.corner(alongCell);
      const first = coarseCornerHeight(surfaceAt, cornerX, cornerZ, 2);
      const second =
        edge.axis === 'x'
          ? coarseCornerHeight(surfaceAt, cornerX, cornerZ + 1, 2)
          : coarseCornerHeight(surfaceAt, cornerX + 1, cornerZ, 2);
      const segment: [[number, number], [number, number]] = [
        [alongCell - 0.5, first],
        [alongCell + 1.5, second],
      ];
      for (const mesh of [medium, far])
        assert.ok(
          hasBoundaryTriangle(mesh, selected.voxelSize, edge.axis, edge.boundary, segment[0], segment[1]),
          `${mesh.userData.worldLod} has an upward-facing ${edge.name} edge segment at ${alongCell}.`,
        );
      assert.ok(
        hasUpwardTriangleCovering(
          far,
          selected.voxelSize,
          edge.axis === 'x' ? edge.boundary + edge.outward * 0.125 : alongCell + 0.25,
          edge.axis === 'z' ? edge.boundary + edge.outward * 0.125 : alongCell + 0.25,
        ),
        `The far tier covers immediately outside the ${edge.name} boundary at ${alongCell}.`,
      );
    }
  }
  const mediumBounds = { minX: -96.5, maxX: 63.5, minZ: -96.5, maxZ: 63.5 };
  for (const mesh of meshes(renderer).filter((candidate) => candidate.userData.worldLod === 'far')) {
    const positions = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    const indices = mesh.geometry.index!;
    for (let triangle = 0; triangle < indices.count; triangle += 3) {
      const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
      if (vertices.some((vertex) => normals.getY(vertex) <= 1e-6)) continue;
      const x = vertices.map(
        (vertex) => (mesh.position.x + positions.getX(vertex) * mesh.scale.x) / selected.voxelSize,
      );
      const z = vertices.map(
        (vertex) => (mesh.position.z + positions.getZ(vertex) * mesh.scale.z) / selected.voxelSize,
      );
      assert.ok(
        Math.min(...x) >= mediumBounds.maxX ||
          Math.max(...x) <= mediumBounds.minX ||
          Math.min(...z) >= mediumBounds.maxZ ||
          Math.max(...z) <= mediumBounds.minZ,
        'Far top triangles do not cross into the medium-tier bounds.',
      );
    }
  }
  renderer.dispose();
});

test('far and horizon top surfaces meet at the far-window edge without overlap', () => {
  const selected = world([1024, 1024], 4, 0);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3();
  const findTile = (lod: string, x: number, z: number) =>
    meshes(renderer).find(
      (mesh) =>
        mesh.userData.worldLod === lod &&
        (mesh.userData.worldFarTile?.x ?? mesh.userData.worldHorizonTile?.x) === x &&
        (mesh.userData.worldFarTile?.z ?? mesh.userData.worldHorizonTile?.z) === z,
    );
  const farTile = () => findTile('far', 2, 0);
  const horizonTile = () => findTile('horizon', 0, 0);
  buildUntil(renderer, target, () => farTile() !== undefined && horizonTile() !== undefined);

  const far = farTile()!;
  const horizon = horizonTile()!;
  const boundaryX = 191.5;
  const topY = selected.generator.baseHeight + 0.5;
  let farReachesBoundary = false;
  const farPositions = far.geometry.getAttribute('position');
  for (let vertex = 0; vertex < farPositions.count; vertex++) {
    const x = (far.position.x + farPositions.getX(vertex) * far.scale.x) / selected.voxelSize;
    if (Math.abs(x - boundaryX) < 1e-6) farReachesBoundary = true;
  }
  assert.ok(farReachesBoundary, 'Far terrain reaches the horizon edge.');

  const positions = horizon.geometry.getAttribute('position');
  const indices = horizon.geometry.index!;
  let horizonReachesBoundary = false;
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const vertices = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
    if (vertices.some((vertex) => positions.getY(vertex) !== topY)) continue;
    const xCoordinates = vertices.map(
      (vertex) => (horizon.position.x + positions.getX(vertex) * horizon.scale.x) / selected.voxelSize,
    );
    const zCoordinates = vertices.map(
      (vertex) => (horizon.position.z + positions.getZ(vertex) * horizon.scale.z) / selected.voxelSize,
    );
    const centerX = xCoordinates.reduce((sum, x) => sum + x, 0) / 3;
    const centerZ = zCoordinates.reduce((sum, z) => sum + z, 0) / 3;
    assert.ok(
      !(centerX > -128 && centerX < 192 && centerZ > -128 && centerZ < 192),
      'Horizon top faces do not cover the far window.',
    );
    for (const x of xCoordinates)
      if (Math.abs(x - boundaryX) < 1e-6 && centerZ >= 0 && centerZ <= 191.5) horizonReachesBoundary = true;
  }
  assert.ok(horizonReachesBoundary, 'Horizon terrain begins at the far edge.');
  renderer.dispose();
});

test('near, medium, far and horizon resident geometry stay within exact caps while moving', () => {
  const renderer = new WorldStreamRenderer(new THREE.Scene(), world([1024, 1024], 4, 0));
  const targets = [new THREE.Vector3(), new THREE.Vector3(128, 0, 128)];
  for (const target of targets) {
    for (let frame = 0; frame < 80; frame++) {
      renderer.update(target);
      const stats = renderer.stats();
      assert.ok(stats.residentChunks <= stats.maximumResidentChunks);
      assert.ok(stats.residentMediumChunks <= stats.maximumResidentMediumChunks);
      assert.ok(stats.residentFarChunks <= stats.maximumResidentFarChunks);
      assert.ok(stats.residentHorizonChunks <= stats.maximumResidentHorizonChunks);
      assert.ok(stats.residentGeometries <= stats.maximumResidentGeometries);
      assert.ok(stats.residentCoarseBufferBytes <= stats.maximumResidentCoarseBufferBytes);
      assert.equal(meshes(renderer).length, stats.residentGeometries);
    }
  }
  assert.equal(renderer.stats().maximumResidentGeometries, 100);
  assert.equal(renderer.stats().maximumCoarseBufferBytesPerTile, 3_910_560);
  assert.equal(renderer.stats().maximumResidentCoarseBufferBytes, 205_204_800);
  renderer.dispose();
});

test('million-cell world extents render only bounded nearby terrain at far positive and negative coordinates', () => {
  const selected = world([1_000_000, 1_000_000], 40, 40, [-500_000, -500_000]);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const viewPositions: [number, number][] = [
    [0, 0],
    [-249_900, -249_900],
    [249_900, 249_900],
    [-249_900, 249_900],
    [249_900, -249_900],
  ];
  for (const [x, z] of viewPositions) {
    const target = new THREE.Vector3(x, 0, z);
    for (let frame = 0; frame < 110; frame++) {
      renderer.update(target);
      const stats = renderer.stats();
      assert.ok(stats.residentChunks <= stats.maximumResidentChunks);
      assert.ok(stats.residentMediumChunks <= stats.maximumResidentMediumChunks);
      assert.ok(stats.residentFarChunks <= stats.maximumResidentFarChunks);
      assert.ok(stats.residentHorizonChunks <= stats.maximumResidentHorizonChunks);
      assert.ok(stats.residentGeometries <= stats.maximumResidentGeometries);
      assert.ok(stats.residentCoarseBufferBytes <= stats.maximumResidentCoarseBufferBytes);
    }
    const expectedNearX = Math.floor(x / selected.voxelSize / 16);
    const expectedNearZ = Math.floor(z / selected.voxelSize / 16);
    assert.ok(
      meshes(renderer).some(
        (mesh) =>
          mesh.userData.worldLod === 'near' &&
          mesh.userData.worldTile?.x === expectedNearX &&
          mesh.userData.worldTile?.z === expectedNearZ,
      ),
      `A nearby tile renders around the camera at (${x}, ${z}) meters.`,
    );
    assert.ok(renderer.stats().residentGeometries < 100);
  }
  renderer.dispose();
});

test('medium terrain LOD preserves the generated voxel cave entrance instead of filling its shaft', () => {
  const base = world([128, 128], 40, 20, [16, 16]);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d' },
  });
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const geometry = renderer.buildTileGeometry('medium', { x: 2, z: 2 }, new THREE.Vector3(79, 20, 79));
  assert.ok(geometry, 'The medium terrain tile containing the cave entrance is built.');

  const mesh = new THREE.Mesh(geometry);
  mesh.scale.set(1, selected.voxelSize, 1);
  mesh.position.set(32, 0, 32);
  mesh.updateMatrixWorld(true);
  const entrance = selected.generator.origin[0] + Math.floor(selected.generator.size[0] / 2);
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3((entrance + 0.25) * selected.voxelSize, 100, (entrance + 0.25) * selected.voxelSize),
    new THREE.Vector3(0, -1, 0),
  );
  const entranceHit = raycaster.intersectObject(mesh)[0];
  assert.ok(entranceHit, 'The coarse cave opening has a rendered floor.');
  const entranceTop = entranceHit.point.y / selected.voxelSize;
  assert.ok(
    entranceTop < createTerrainSurfaceSampler(selected)(entrance + 4, entrance) - 2,
    'The streamed medium heightfield retains a visible depth at the voxel cave entrance.',
  );
  renderer.dispose();
});

test('far LOD keeps the generated 3x3 shaft open across its tile seam', () => {
  const base = world([2048, 2048], 40, 20, [0, 0]);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d' },
  });
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const entranceX = selected.generator.origin[0] + Math.floor(selected.generator.size[0] / 2);
  const entranceZ = selected.generator.origin[1] + Math.floor(selected.generator.size[1] / 2);
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const floorYAt = (sourceX: number, sourceZ: number) => {
    const cellX = Math.floor(sourceX + 0.5);
    const cellZ = Math.floor(sourceZ + 0.5);
    let floorTop = surfaceAt(cellX, cellZ);
    while (floorTop >= selected.generator.minY && !volumeAt(cellX, floorTop, cellZ)) floorTop--;
    return (floorTop + 0.5) * selected.voxelSize;
  };
  assert.equal(
    volumeAt(entranceX, surfaceAt(entranceX, entranceZ), entranceZ),
    false,
    'The generated source terrain has an open entrance at this sample.',
  );
  const expectedFloorY = floorYAt(entranceX, entranceZ);
  assert.ok(expectedFloorY > 0, 'The shaft has a solid lower floor.');

  const referenceWorld = worldDocumentSchema.parse({
    ...selected,
    generator: { ...selected.generator, mode: 'heightfield' },
  });
  const referenceRenderer = new WorldStreamRenderer(new THREE.Scene(), referenceWorld);
  const meshes: THREE.Mesh[] = [];
  const referenceMeshes: THREE.Mesh[] = [];
  const target = new THREE.Vector3();
  try {
    // The generated entrance lies on both a far coarse-cell and tile boundary.
    for (const z of [15, 16]) {
      for (const x of [15, 16]) {
        for (const [tileRenderer, tileMeshes] of [
          [renderer, meshes],
          [referenceRenderer, referenceMeshes],
        ] as const) {
          const geometry = tileRenderer.buildTileGeometry('far', { x, z }, target);
          assert.ok(geometry, `Far tile ${x},${z} is built.`);
          const bufferBytes =
            geometry.getAttribute('position').array.byteLength +
            geometry.getAttribute('normal').array.byteLength +
            geometry.getAttribute('color').array.byteLength +
            (geometry.index?.array.byteLength ?? 0);
          assert.ok(
            bufferBytes <= tileRenderer.stats().maximumCoarseBufferBytesPerTile,
            'The 4×4 far aperture stays within the existing coarse-tile buffer cap.',
          );
          const mesh = new THREE.Mesh(geometry);
          mesh.scale.set(2, selected.voxelSize, 2);
          mesh.position.set(x * 32, 0, z * 32);
          mesh.updateMatrixWorld(true);
          tileMeshes.push(mesh);
        }
      }
    }

    const hitsAt = (sourceX: number, sourceZ: number) => {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(sourceX * selected.voxelSize, 200, sourceZ * selected.voxelSize),
        new THREE.Vector3(0, -1, 0),
      );
      return ray.intersectObjects(meshes);
    };
    const rayAt = (sourceX: number, sourceZ: number) => hitsAt(sourceX, sourceZ)[0] ?? null;
    const referenceRayAt = (sourceX: number, sourceZ: number) => {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(sourceX * selected.voxelSize, 200, sourceZ * selected.voxelSize),
        new THREE.Vector3(0, -1, 0),
      );
      return ray.intersectObjects(referenceMeshes)[0] ?? null;
    };
    for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const sourceX = entranceX + offsetX + 0.25;
        const sourceZ = entranceZ + offsetZ + 0.25;
        const hit = rayAt(sourceX, sourceZ);
        assert.ok(hit, `The source cell ${offsetX},${offsetZ} reaches the far shaft floor.`);
        assert.ok(
          Math.abs(hit.point.y - floorYAt(sourceX, sourceZ)) < 1e-5,
          `The far subgrid keeps the exact recessed floor at ${sourceX},${sourceZ}.`,
        );
      }
    }
    for (const offset of [-1.51, 1.51]) {
      const xHit = rayAt(entranceX + offset, entranceZ);
      const zHit = rayAt(entranceX, entranceZ + offset);
      assert.ok(xHit && zHit, 'Adjacent rays still hit the surrounding coarse surface.');
      assert.ok(xHit.point.y > expectedFloorY + 2 * selected.voxelSize);
      assert.ok(zHit.point.y > expectedFloorY + 2 * selected.voxelSize);
    }

    // The exterior fan profiles remain the original coarse surface at the affected cell perimeter.
    const edge = entranceX - 0.5;
    for (const [sourceX, sourceZ] of [
      [edge, entranceZ - 5],
      [edge, entranceZ + 5],
      [entranceX - 5, edge],
      [entranceX + 5, edge],
    ]) {
      const apertureProfile = rayAt(sourceX, sourceZ);
      const referenceProfile = referenceRayAt(sourceX, sourceZ);
      assert.ok(apertureProfile && referenceProfile, 'The far fan perimeter remains covered.');
      assert.ok(
        Math.abs(apertureProfile.point.y - referenceProfile.point.y) < 1e-5,
        `The existing far fan edge at ${sourceX},${sourceZ} keeps its height (${apertureProfile.point.y} vs ${referenceProfile.point.y}).`,
      );
    }

    // Probe both sides of each tile seam and the exact seam to catch gaps or stacked surfaces.
    for (const [sourceX, sourceZ, before, after] of [
      [edge, entranceZ + 0.23, [edge - 0.01, entranceZ + 0.23], [edge + 0.01, entranceZ + 0.23]],
      [entranceX + 0.23, edge, [entranceX + 0.23, edge - 0.01], [entranceX + 0.23, edge + 0.01]],
    ] as const) {
      const seamHits = hitsAt(sourceX, sourceZ);
      assert.ok(seamHits.length > 0, `The exact far tile seam at ${sourceX},${sourceZ} has coverage.`);
      assert.ok(
        seamHits.every((hit) => Math.abs(hit.point.y - seamHits[0].point.y) < 1e-5),
        'The exact far tile seam has no vertically stacked surface.',
      );
      for (const [probeX, probeZ] of [before, after]) {
        const probeHit = rayAt(probeX, probeZ);
        assert.ok(probeHit, `The far tile seam remains covered beside ${probeX},${probeZ}.`);
        assert.ok(
          Math.abs(probeHit.point.y - floorYAt(probeX, probeZ)) < 1e-5,
          'The opening floor continues across both sides of the far tile seam.',
        );
      }
    }
  } finally {
    for (const mesh of meshes) mesh.geometry.dispose();
    for (const mesh of referenceMeshes) mesh.geometry.dispose();
    renderer.dispose();
    referenceRenderer.dispose();
  }
});

test('horizon LOD preserves the generated 3x3 shaft through a coarse tile seam', () => {
  const base = world([2048, 2048], 40, 20, [0, 0]);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d' },
  });
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const entranceX = selected.generator.origin[0] + Math.floor(selected.generator.size[0] / 2);
  const entranceZ = selected.generator.origin[1] + Math.floor(selected.generator.size[1] / 2);
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const floorYAt = (x: number, z: number) => {
    const cellX = Math.floor(x + 0.5);
    const cellZ = Math.floor(z + 0.5);
    let floorTop = surfaceAt(cellX, cellZ);
    while (floorTop >= selected.generator.minY && !volumeAt(cellX, floorTop, cellZ)) floorTop--;
    return (floorTop + 0.5) * selected.voxelSize;
  };
  const expectedFloorY = floorYAt(entranceX, entranceZ);
  assert.ok(expectedFloorY > 0, 'The generated shaft has a solid lower floor.');
  const floorTop = Math.round(expectedFloorY / selected.voxelSize - 0.5);
  const meshes: THREE.Mesh[] = [];
  const referenceWorld = worldDocumentSchema.parse({
    ...selected,
    generator: { ...selected.generator, mode: 'heightfield' },
  });
  const referenceRenderer = new WorldStreamRenderer(new THREE.Scene(), referenceWorld);
  const referenceMeshes: THREE.Mesh[] = [];
  const target = new THREE.Vector3();
  try {
    for (const z of [3, 4]) {
      for (const x of [3, 4]) {
        for (const [tileRenderer, tileMeshes] of [
          [renderer, meshes],
          [referenceRenderer, referenceMeshes],
        ] as const) {
          const geometry = tileRenderer.buildTileGeometry('horizon', { x, z }, target);
          assert.ok(geometry, `Horizon tile ${x},${z} is built.`);
          const bufferBytes =
            geometry.getAttribute('position').array.byteLength +
            geometry.getAttribute('normal').array.byteLength +
            geometry.getAttribute('color').array.byteLength +
            (geometry.index?.array.byteLength ?? 0);
          assert.ok(
            bufferBytes <= tileRenderer.stats().maximumCoarseBufferBytesPerTile,
            'The subdivided aperture remains within the declared coarse-tile build bound.',
          );
          const mesh = new THREE.Mesh(geometry);
          mesh.scale.set(8, selected.voxelSize, 8);
          mesh.position.set(x * 128, 0, z * 128);
          mesh.updateMatrixWorld(true);
          tileMeshes.push(mesh);
        }
      }
    }

    const hitsAt = (sourceX: number, sourceZ: number) => {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(sourceX * selected.voxelSize, 200, sourceZ * selected.voxelSize),
        new THREE.Vector3(0, -1, 0),
      );
      return ray.intersectObjects(meshes);
    };
    const rayAt = (sourceX: number, sourceZ: number) => hitsAt(sourceX, sourceZ)[0] ?? null;
    const referenceRayAt = (sourceX: number, sourceZ: number) => {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(sourceX * selected.voxelSize, 200, sourceZ * selected.voxelSize),
        new THREE.Vector3(0, -1, 0),
      );
      return ray.intersectObjects(referenceMeshes)[0] ?? null;
    };
    for (const edgeOffset of [-1.49, 0, 1.49]) {
      const hit = rayAt(entranceX + edgeOffset, entranceZ);
      assert.ok(hit, `The ray at source-cell offset ${edgeOffset} reaches the shaft floor.`);
      assert.ok(
        Math.abs(hit.point.y - floorYAt(entranceX + edgeOffset, entranceZ)) < 1e-5,
        `The ray at ${edgeOffset} reaches the recessed floor at the generated column height (${hit.point.y} vs ${expectedFloorY}).`,
      );
    }
    for (const edgeOffset of [-1.49, 1.49]) {
      const hit = rayAt(entranceX, entranceZ + edgeOffset);
      assert.ok(hit, `The ray at z source-cell offset ${edgeOffset} reaches the shaft floor.`);
      assert.ok(Math.abs(hit.point.y - floorYAt(entranceX, entranceZ + edgeOffset)) < 1e-5);
    }
    for (const outsideOffset of [-1.51, 1.51]) {
      const hit = rayAt(entranceX + outsideOffset, entranceZ);
      assert.ok(hit, `The adjacent ray at ${outsideOffset} still hits the coarse surface.`);
      assert.ok(
        hit.point.y > expectedFloorY + 2 * selected.voxelSize,
        `The opening ends at the 3-source-cell boundary instead of lowering its coarse cell.`,
      );
      const zHit = rayAt(entranceX, entranceZ + outsideOffset);
      assert.ok(zHit, `The adjacent z ray at ${outsideOffset} still hits the coarse surface.`);
      assert.ok(zHit.point.y > expectedFloorY + 2 * selected.voxelSize);
    }

    // The opening crosses both the affected coarse-cell edge and the horizon tile edge.
    // Rays just to either side must hit their source floor without a gap or stacked surface.
    const edge = entranceX - 0.5;
    for (const [sourceX, sourceZ] of [
      [edge, entranceZ - 5],
      [edge, entranceZ + 5],
      [entranceX - 5, entranceZ - 0.5],
      [entranceX + 5, entranceZ - 0.5],
    ]) {
      const apertureProfile = rayAt(sourceX, sourceZ);
      const referenceProfile = referenceRayAt(sourceX, sourceZ);
      assert.ok(apertureProfile && referenceProfile, 'The affected cell perimeter stays covered.');
      assert.ok(
        Math.abs(apertureProfile.point.y - referenceProfile.point.y) < 1e-5,
        `The existing fan edge at ${sourceX},${sourceZ} keeps its height.`,
      );
    }
    for (const [sourceX, sourceZ] of [
      [edge, entranceZ],
      [entranceX, entranceZ - 0.5],
      [edge, entranceZ - 0.5],
    ]) {
      const hits = hitsAt(sourceX, sourceZ);
      assert.ok(hits.length > 0, `The exact shared edge at ${sourceX},${sourceZ} has no gap.`);
      assert.ok(
        hits.every((hit) => Math.abs(hit.point.y - hits[0].point.y) < 1e-5),
        `The exact shared edge at ${sourceX},${sourceZ} has no vertically stacked surface.`,
      );
    }
    for (const sourceX of [edge - 0.01, edge + 0.01]) {
      const cellX = Math.floor(sourceX + 0.5);
      const cellFloor = surfaceAt(cellX, entranceZ);
      let cellTop = cellFloor;
      while (cellTop >= selected.generator.minY && !volumeAt(cellX, cellTop, entranceZ)) cellTop--;
      const hit = rayAt(sourceX, entranceZ);
      assert.ok(hit, `The opening remains covered beside the x tile seam at ${sourceX}.`);
      assert.equal(
        hitsAt(sourceX, entranceZ).length,
        1,
        'Only one subgrid surface covers either side of the edge.',
      );
      assert.ok(Math.abs(hit.point.y - (cellTop + 0.5) * selected.voxelSize) < 1e-5);
    }
    for (const sourceZ of [entranceZ - 0.5 - 0.01, entranceZ - 0.5 + 0.01]) {
      const cellZ = Math.floor(sourceZ + 0.5);
      const cellFloor = surfaceAt(entranceX, cellZ);
      let cellTop = cellFloor;
      while (cellTop >= selected.generator.minY && !volumeAt(entranceX, cellTop, cellZ)) cellTop--;
      const hit = rayAt(entranceX, sourceZ);
      assert.ok(hit, `The opening remains covered beside the z tile seam at ${sourceZ}.`);
      assert.equal(
        hitsAt(entranceX, sourceZ).length,
        1,
        'Only one subgrid surface covers either side of the edge.',
      );
      assert.ok(Math.abs(hit.point.y - (cellTop + 0.5) * selected.voxelSize) < 1e-5);
    }

    const filledY = floorTop + 1;
    assert.equal(
      volumeAt(entranceX, filledY, entranceZ),
      false,
      'The edit fills generated empty shaft space.',
    );
    const filledWorld = worldDocumentSchema.parse({
      ...selected,
      edits: [
        {
          x: entranceX,
          y: filledY,
          z: entranceZ,
          value: { color: 0x725439, materialType: 'STANDARD' },
        },
      ],
    });
    const filledRenderer = new WorldStreamRenderer(new THREE.Scene(), filledWorld);
    try {
      const geometry = filledRenderer.buildTileGeometry('horizon', { x: 4, z: 4 }, target);
      assert.ok(geometry, 'The edited horizon tile is built.');
      const mesh = new THREE.Mesh(geometry);
      mesh.scale.set(8, selected.voxelSize, 8);
      mesh.position.set(512, 0, 512);
      mesh.updateMatrixWorld(true);
      const ray = (sourceX: number) =>
        new THREE.Raycaster(
          new THREE.Vector3(sourceX * selected.voxelSize, 200, entranceZ * selected.voxelSize),
          new THREE.Vector3(0, -1, 0),
        ).intersectObject(mesh)[0];
      const filledHit = ray(entranceX);
      assert.ok(
        filledHit && filledHit.point.y >= expectedFloorY + selected.voxelSize - 1e-5,
        'The filled voxel raises the distant floor by one full source cell.',
      );
      const openNeighborHit = ray(entranceX + 0.75);
      assert.ok(openNeighborHit, 'The other empty cells in the 3×3 footprint remain open.');
      assert.ok(Math.abs(openNeighborHit.point.y - floorYAt(entranceX + 0.75, entranceZ)) < 1e-5);
      geometry.dispose();
    } finally {
      filledRenderer.dispose();
    }
  } finally {
    for (const mesh of meshes) mesh.geometry.dispose();
    for (const mesh of referenceMeshes) mesh.geometry.dispose();
    renderer.dispose();
    referenceRenderer.dispose();
  }
});

test('horizon LOD distributes its bounded authored openings across four coarse cells', () => {
  const base = world([2048, 2048], 40, 0, [0, 0]);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), base);
  const edits: { x: number; y: number; z: number; value: null }[] = [];
  const openingGroups = [1041, 1057].flatMap((startX) => [1041, 1057].map((startZ) => ({ startX, startZ })));
  for (const { startX, startZ } of openingGroups)
    for (let z = startZ; z < startZ + 3; z++)
      for (let x = startX; x < startX + 3; x++)
        for (let y = 40; y >= 35; y--) edits.push({ x, y, z, value: null });
  renderer.updateWorldEdits(edits, edits);

  const geometry = renderer.buildTileGeometry('horizon', { x: 4, z: 4 }, new THREE.Vector3());
  assert.ok(geometry, 'The authored opening is represented by the distant horizon tile.');
  const mesh = new THREE.Mesh(geometry);
  mesh.scale.set(8, base.voxelSize, 8);
  mesh.position.set(512, 0, 512);
  mesh.updateMatrixWorld(true);
  const rayAt = (x: number, z: number) =>
    new THREE.Raycaster(
      new THREE.Vector3(x * base.voxelSize, 100, z * base.voxelSize),
      new THREE.Vector3(0, -1, 0),
    ).intersectObject(mesh)[0];
  const retainedByGroup = openingGroups.map(({ startX, startZ }) => {
    let retained = 0;
    for (let z = startZ; z < startZ + 3; z++)
      for (let x = startX; x < startX + 3; x++) {
        const opening = rayAt(x + 0.25, z + 0.25);
        assert.ok(opening, `The horizon covers authored source cell ${x},${z}.`);
        if (opening.point.y < 40 * base.voxelSize) retained++;
      }
    return retained;
  });
  assert.deepEqual(
    retainedByGroup,
    [9, 9, 9, 9],
    'Each selected coarse cell receives an equal share of the budget.',
  );
  const outside = rayAt(1064.25, 1042.25);
  assert.ok(outside, 'The surrounding horizon remains covered.');
  const bufferBytes =
    geometry.getAttribute('position').array.byteLength +
    geometry.getAttribute('normal').array.byteLength +
    geometry.getAttribute('color').array.byteLength +
    (geometry.index?.array.byteLength ?? 0);
  assert.ok(
    bufferBytes <= renderer.stats().maximumCoarseBufferBytesPerTile,
    'Authored openings remain within the declared bounded coarse-tile buffer budget.',
  );
  geometry.dispose();
  renderer.dispose();
});

test('horizon cave sampling keeps connected openings at coarse-cell edge midpoints', () => {
  const base = world([2048, 2048], 80, 0);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      caveDensity: 1,
      caveEntrancesPerRegion: 0,
    },
  });
  const value = { color: selected.generator.palette.surface, materialType: 'STANDARD' as const };
  const sourceY = 39;
  const edgeMidpoint = [16, sourceY, 16].join(',');
  const connectedCellCenter = [39, sourceY, 23].join(',');
  const build = (openCells: Set<string>) => {
    const builder = new WorldStreamGeometryBuilder(
      selected,
      () => [{ start: 0, end: 81, value }],
      () => ({ top: 80, value }),
      undefined,
      undefined,
      undefined,
      () => 80,
      (_x, y, _z) => !openCells.has(`${_x},${y},${_z}`),
    );
    return builder.buildCoarseTileGeometry(
      { x: 0, z: 0 },
      16,
      4,
      { minX: 5000, maxX: 6000, minZ: 5000, maxZ: 6000 },
      true,
    )!;
  };
  const solid = build(new Set());
  const isolated = build(new Set([edgeMidpoint]));
  const connected = build(new Set([edgeMidpoint, connectedCellCenter]));
  try {
    assert.equal(
      isolated.getIndex()!.count,
      solid.getIndex()!.count,
      'An isolated edge probe does not create a detached distant cavern.',
    );
    assert.ok(
      connected.getIndex()!.count > solid.getIndex()!.count,
      'An edge-midpoint opening connected to a neighboring coarse cave cell adds interior shell geometry.',
    );
  } finally {
    solid.dispose();
    isolated.dispose();
    connected.dispose();
  }
});

test('far and horizon LOD retain deterministic cave-field mouths and their recessed floors', () => {
  const base = productionMountainWorld();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d', caveDensity: 0.75 },
  });
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const entrances = terrainCaveEntrancesIn(
    selected,
    { minX: -512, maxX: 512, minZ: -512, maxZ: 512 },
    surfaceAt,
  );
  const entrancesByHorizonTile = new Map<string, typeof entrances>();
  for (const caveEntrance of entrances) {
    const key = `${Math.floor(caveEntrance.x / 256)},${Math.floor(caveEntrance.z / 256)}`;
    const group = entrancesByHorizonTile.get(key) ?? [];
    group.push(caveEntrance);
    entrancesByHorizonTile.set(key, group);
  }
  const entrance = [...entrancesByHorizonTile.entries()].find(
    ([key, group]) => key !== '0,0' && group.length === 1,
  )?.[1][0];
  assert.ok(entrance, 'The selected seed provides a field-connected mouth outside the legacy entrance tile.');

  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const voxelSize = selected.voxelSize;
  const target = new THREE.Vector3(
    (entrance.x + 300) * voxelSize,
    selected.generator.baseHeight,
    (entrance.z + 300) * voxelSize,
  );
  try {
    for (const level of ['far', 'horizon'] as const) {
      const spacing = level === 'far' ? 4 : 16;
      const tileWidth = 16 * spacing;
      const coordinate = { x: Math.floor(entrance.x / tileWidth), z: Math.floor(entrance.z / tileWidth) };
      const geometry = renderer.buildTileGeometry(level, coordinate, target);
      assert.ok(geometry, `${level} cave tile is built.`);
      const mesh = new THREE.Mesh(geometry);
      mesh.scale.set(spacing * voxelSize, voxelSize, spacing * voxelSize);
      mesh.position.set(coordinate.x * tileWidth * voxelSize, 0, coordinate.z * tileWidth * voxelSize);
      mesh.updateMatrixWorld(true);
      try {
        for (let z = entrance.z - 1; z <= entrance.z + 1; z++) {
          for (let x = entrance.x - 1; x <= entrance.x + 1; x++) {
            let floor = surfaceAt(x, z);
            while (floor >= selected.generator.minY && !volumeAt(x, floor, z)) floor--;
            const hit = new THREE.Raycaster(
              new THREE.Vector3(x * voxelSize, 200, z * voxelSize),
              new THREE.Vector3(0, -1, 0),
            ).intersectObject(mesh)[0];
            assert.ok(hit, `${level} retains the opening floor at ${x},${z}.`);
            assert.ok(
              Math.abs(hit.point.y - (floor + 0.5) * voxelSize) < 1e-5,
              `${level} reaches the generated cave floor at ${x},${z} (hit=${hit.point.y}, floor=${(floor + 0.5) * voxelSize}).`,
            );
          }
        }
      } finally {
        geometry.dispose();
      }
    }
  } finally {
    renderer.dispose();
  }
});

test('far LOD carries unlinked cave mouths down continuous independent field shafts', () => {
  const base = world([256, 256], 40, 0, [0, 0]);
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      caveDensity: 1,
      caveEntrancesPerRegion: 1,
      caveNetwork: false,
    },
  });
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const entrance = terrainCaveEntrancesIn(
    selected,
    {
      minX: 0,
      maxX: 256,
      minZ: 0,
      maxZ: 256,
    },
    surfaceAt,
  )[0];
  assert.ok(entrance, 'The seeded field generates a cave mouth in the region.');

  const isMouthColumn = (x: number, z: number) =>
    Math.abs(x - entrance.x) <= 1 && Math.abs(z - entrance.z) <= 1;
  const value = { color: selected.generator.palette.surface, materialType: 'STANDARD' as const };
  const createBuilder = (hasSideExit: boolean) =>
    new WorldStreamGeometryBuilder(
      selected,
      () => [{ start: selected.generator.minY, end: 41, value }],
      () => ({ top: 40, value }),
      () => false,
      isMouthColumn,
      () => [],
      surfaceAt,
      (x, y, z) =>
        !(
          (isMouthColumn(x, z) && y >= 37 && y <= 40) ||
          (x === entrance.x && z === entrance.z && y >= 8 && y < 37) ||
          (hasSideExit && x === entrance.x + 1 && z === entrance.z && y === 8)
        ),
    );
  for (const spacing of [4, 16]) {
    const tileWidth = 16 * spacing;
    const coordinate = {
      x: Math.floor(entrance.x / tileWidth),
      z: Math.floor(entrance.z / tileWidth),
    };
    const geometry = createBuilder(false).buildCoarseTileGeometry(
      coordinate,
      spacing,
      spacing / 2,
      { minX: -10000, maxX: -9000, minZ: -10000, maxZ: -9000 },
      true,
    );
    assert.ok(geometry, `The spacing-${spacing} tile contains terrain and its cave mouth.`);
    const position = geometry.getAttribute('position');
    let carriesIndependentShaft = false;
    let carriesDeadEndCap = false;
    const localMouthX = entrance.x / spacing - coordinate.x * 16;
    const localMouthZ = entrance.z / spacing - coordinate.z * 16;
    for (let index = 0; index < position.count; index++)
      if (Math.abs(position.getY(index) - 7.5) < 1e-6) {
        carriesIndependentShaft = true;
        if (
          Math.abs(position.getX(index) - localMouthX) < 1e-6 &&
          Math.abs(position.getZ(index) - localMouthZ) < 1e-6
        )
          carriesDeadEndCap = true;
      }
    assert.ok(carriesIndependentShaft, `The spacing-${spacing} tile carries the deep field shaft.`);
    assert.ok(carriesDeadEndCap, `The spacing-${spacing} tile closes the shaft against solid below.`);
    geometry.dispose();

    const sideExitGeometry = createBuilder(true).buildCoarseTileGeometry(
      coordinate,
      spacing,
      spacing / 2,
      { minX: -10000, maxX: -9000, minZ: -10000, maxZ: -9000 },
      true,
    );
    assert.ok(sideExitGeometry, `The spacing-${spacing} side-exit tile builds.`);
    const sideExitPosition = sideExitGeometry.getAttribute('position');
    let leavesCavernExitOpen = false;
    for (let index = 0; index < sideExitPosition.count; index++)
      if (
        Math.abs(sideExitPosition.getY(index) - 7.5) < 1e-6 &&
        Math.abs(sideExitPosition.getX(index) - localMouthX) < 1e-6 &&
        Math.abs(sideExitPosition.getZ(index) - localMouthZ) < 1e-6
      )
        leavesCavernExitOpen = true;
    assert.equal(leavesCavernExitOpen, false, `The spacing-${spacing} side exit stays uncapped.`);
    sideExitGeometry.dispose();
  }
});

test('horizon LOD keeps every bounded generated cave mouth in a region', () => {
  const base = productionMountainWorld();
  const selected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      caveDensity: 1,
      caveEntrancesPerRegion: 4,
    },
  });
  const surfaceAt = createTerrainSurfaceSampler(selected);
  const volumeAt = createTerrainVolumeSampler(selected, surfaceAt);
  const entrances = terrainCaveEntrancesIn(
    selected,
    { minX: -512, maxX: 512, minZ: -512, maxZ: 512 },
    surfaceAt,
  );
  const grouped = new Map<string, typeof entrances>();
  for (const entrance of entrances) {
    const key = `${Math.floor(entrance.x / 256)},${Math.floor(entrance.z / 256)}`;
    const group = grouped.get(key) ?? [];
    group.push(entrance);
    grouped.set(key, group);
  }
  const [regionKey, regionEntrances] = [...grouped.entries()].find(([, group]) => group.length === 4) ?? [];
  assert.ok(regionKey && regionEntrances, 'The dense fixture has one region at the four-mouth limit.');

  const [regionX, regionZ] = regionKey.split(',').map(Number);
  const renderer = new WorldStreamRenderer(new THREE.Scene(), selected);
  const target = new THREE.Vector3(
    (regionX * 256 + 900) * selected.voxelSize,
    selected.generator.baseHeight,
    (regionZ * 256 + 900) * selected.voxelSize,
  );
  const geometry = renderer.buildTileGeometry('horizon', { x: regionX, z: regionZ }, target);
  assert.ok(geometry, 'The selected horizon tile builds.');
  const bufferBytes =
    geometry.getAttribute('position').array.byteLength +
    geometry.getAttribute('normal').array.byteLength +
    geometry.getAttribute('color').array.byteLength +
    (geometry.index?.array.byteLength ?? 0);
  assert.ok(
    bufferBytes <= renderer.stats().maximumCoarseBufferBytesPerTile,
    'All four openings stay within the declared horizon tile buffer cap.',
  );
  const mesh = new THREE.Mesh(geometry);
  mesh.scale.set(16 * selected.voxelSize, selected.voxelSize, 16 * selected.voxelSize);
  mesh.position.set(regionX * 256 * selected.voxelSize, 0, regionZ * 256 * selected.voxelSize);
  mesh.updateMatrixWorld(true);
  try {
    for (const entrance of regionEntrances)
      for (let z = entrance.z - 1; z <= entrance.z + 1; z++)
        for (let x = entrance.x - 1; x <= entrance.x + 1; x++) {
          let floor = surfaceAt(x, z);
          while (floor >= selected.generator.minY && !volumeAt(x, floor, z)) floor--;
          const hit = new THREE.Raycaster(
            new THREE.Vector3(x * selected.voxelSize, 200, z * selected.voxelSize),
            new THREE.Vector3(0, -1, 0),
          ).intersectObject(mesh)[0];
          assert.ok(hit, `The horizon tile keeps the cave floor at ${x},${z}.`);
          assert.ok(
            Math.abs(hit.point.y - (floor + 0.5) * selected.voxelSize) < 1e-5,
            `The opening reaches its generated floor at ${x},${z}.`,
          );
        }
  } finally {
    geometry.dispose();
    renderer.dispose();
  }
});

test('far and horizon LOD retain bounded cave-network tunnel surfaces', () => {
  const base = world([1024, 256], 40, 20);
  const networkWorld = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d', caveNetwork: true },
  });
  const closedWorld = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d', caveNetwork: false },
  });
  const path = createTerrainCaveNetworkPath(networkWorld);
  assert.ok(path, 'The authored world has a deterministic cave trunk.');
  assert.equal(path.axis, 'x');

  const build = (
    document: typeof networkWorld,
    level: 'far' | 'horizon',
    coordinate: { x: number; z: number },
    target = new THREE.Vector3(),
  ) => {
    const renderer = new WorldStreamRenderer(new THREE.Scene(), document);
    const geometry = renderer.buildTileGeometry(level, coordinate, target);
    if (!geometry) {
      renderer.dispose();
      return 0;
    }
    const byteLength =
      geometry.getAttribute('position').array.byteLength +
      geometry.getAttribute('normal').array.byteLength +
      geometry.getAttribute('color').array.byteLength +
      (geometry.index?.array.byteLength ?? 0);
    assert.ok(byteLength <= renderer.stats().maximumCoarseBufferBytesPerTile);
    const vertexCount = geometry.getAttribute('position').count;
    geometry.dispose();
    renderer.dispose();
    return vertexCount;
  };

  for (const level of ['far', 'horizon'] as const) {
    const spacing = level === 'far' ? 4 : 16;
    const tileWidth = 16 * spacing;
    const axialTile = Math.floor(800 / tileWidth);
    const crossTiles = Math.ceil(256 / tileWidth);
    let addedVertices = 0;
    for (let crossTile = 0; crossTile < crossTiles; crossTile++) {
      const coordinate = { x: axialTile, z: crossTile };
      addedVertices += build(networkWorld, level, coordinate) - build(closedWorld, level, coordinate);
    }
    assert.equal(
      addedVertices,
      16 * 8 * 4,
      `${level} emits each of the 16 bounded trunk segments once across cross-axis tile seams.`,
    );

    const along = 800;
    const first = path.at(along);
    const second = path.at(along + spacing);
    const midpoint = path.at(along + spacing / 2);
    const crossTile = Math.floor(midpoint.z / tileWidth);
    const coordinate = { x: axialTile, z: crossTile };
    const renderer = new WorldStreamRenderer(new THREE.Scene(), networkWorld);
    const geometry = renderer.buildTileGeometry(level, coordinate, new THREE.Vector3());
    assert.ok(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.scale.set(
      spacing * networkWorld.voxelSize,
      networkWorld.voxelSize,
      spacing * networkWorld.voxelSize,
    );
    mesh.position.set(
      coordinate.x * tileWidth * networkWorld.voxelSize,
      0,
      coordinate.z * tileWidth * networkWorld.voxelSize,
    );
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(
        (along + spacing / 2) * networkWorld.voxelSize,
        (first.y + 0.5) * networkWorld.voxelSize,
        ((first.z + second.z) / 2) * networkWorld.voxelSize,
      ),
      new THREE.Vector3(0, 0, 1),
    );
    try {
      const hit = ray.intersectObject(mesh)[0];
      assert.ok(hit, `${level} exposes the trunk's inward-facing wall to a ray from inside the tunnel.`);
      const hitCross = hit.point.z / networkWorld.voxelSize;
      assert.ok(
        hitCross > midpoint.z + 2.5 && hitCross < midpoint.z + 3.1,
        `${level} uses the shared three-cell lateral tunnel radius.`,
      );
    } finally {
      geometry.dispose();
      mesh.material.dispose();
      renderer.dispose();
    }
  }

  const point = path.at(800);
  const coveredTarget = new THREE.Vector3(
    point.x * networkWorld.voxelSize,
    point.y * networkWorld.voxelSize,
    point.z * networkWorld.voxelSize,
  );
  const coveredTile = { x: Math.floor(800 / 64), z: Math.floor(point.z / 64) };
  assert.equal(
    build(networkWorld, 'far', coveredTile, coveredTarget),
    build(closedWorld, 'far', coveredTile, coveredTarget),
    'Far cave geometry leaves its finer medium-tier cutout clear of duplicate tunnel walls.',
  );
});

test('far and horizon LOD retain capped dead-end cave-network branches', () => {
  const base = world([2048, 256], 40, 20);
  const branchWorld = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d', caveNetwork: true, caveBranchCount: 4 },
  });
  const trunkWorld = worldDocumentSchema.parse({
    ...base,
    generator: { ...base.generator, mode: 'voxel3d', caveNetwork: true, caveBranchCount: 0 },
  });
  const path = createTerrainCaveNetworkPath(branchWorld);
  assert.ok(path);
  const branches = terrainCaveNetworkBranches(branchWorld, path);
  const branch = branches.at(-1);
  assert.ok(branch && branch.length >= 4, 'The deterministic fixture has a distant side branch.');
  const center = path.at(branch.along);
  const branchDistance = Math.max(2, Math.min(8, branch.length / 2));
  const cross = (path.axis === 'x' ? center.z : center.x) + branch.direction * branchDistance;
  assert.ok(
    path.axis === 'x'
      ? terrainCaveNetworkBranchContains(path, branch, branch.along, center.y + 1, Math.round(cross))
      : terrainCaveNetworkBranchContains(path, branch, Math.round(cross), center.y + 1, branch.along),
    'The ray origin is inside the authored branch occupancy.',
  );

  for (const level of ['far', 'horizon'] as const) {
    const spacing = level === 'far' ? 4 : 16;
    const tileWidth = 16 * spacing;
    const primaryTile = Math.floor(branch.along / tileWidth);
    const crossTile = Math.floor(cross / tileWidth);
    const coordinate =
      path.axis === 'x' ? { x: primaryTile, z: crossTile } : { x: crossTile, z: primaryTile };
    const renderer = new WorldStreamRenderer(new THREE.Scene(), branchWorld);
    const geometry = renderer.buildTileGeometry(level, coordinate, new THREE.Vector3());
    const baselineRenderer = new WorldStreamRenderer(new THREE.Scene(), trunkWorld);
    const baseline = baselineRenderer.buildTileGeometry(level, coordinate, new THREE.Vector3());
    assert.ok(geometry && baseline, `${level} meshes the branch tile.`);
    assert.ok(
      geometry.getAttribute('position').count > baseline.getAttribute('position').count,
      `${level} adds branch walls and a closed endpoint cap.`,
    );
    const byteLength =
      geometry.getAttribute('position').array.byteLength +
      geometry.getAttribute('normal').array.byteLength +
      geometry.getAttribute('color').array.byteLength +
      (geometry.index?.array.byteLength ?? 0);
    assert.ok(byteLength <= renderer.stats().maximumCoarseBufferBytesPerTile);

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.scale.set(spacing * branchWorld.voxelSize, branchWorld.voxelSize, spacing * branchWorld.voxelSize);
    mesh.position.set(
      coordinate.x * tileWidth * branchWorld.voxelSize,
      0,
      coordinate.z * tileWidth * branchWorld.voxelSize,
    );
    mesh.updateMatrixWorld(true);
    const rayOrigin =
      path.axis === 'x'
        ? new THREE.Vector3(
            center.x * branchWorld.voxelSize,
            (center.y + 1) * branchWorld.voxelSize,
            cross * branchWorld.voxelSize,
          )
        : new THREE.Vector3(
            cross * branchWorld.voxelSize,
            (center.y + 1) * branchWorld.voxelSize,
            center.z * branchWorld.voxelSize,
          );
    const direction = path.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    try {
      const hit = new THREE.Raycaster(rayOrigin, direction).intersectObject(mesh)[0];
      assert.ok(hit, `${level} exposes the branch wall to a ray from inside the passage.`);
      const hitCell =
        path.axis === 'x' ? hit.point.x / branchWorld.voxelSize : hit.point.z / branchWorld.voxelSize;
      const startCell = path.axis === 'x' ? center.x : center.z;
      assert.ok(hitCell > startCell + 1.5 && hitCell < startCell + 3);
    } finally {
      geometry.dispose();
      baseline.dispose();
      mesh.material.dispose();
      renderer.dispose();
      baselineRenderer.dispose();
    }

    const centerCross = path.axis === 'x' ? center.z : center.x;
    const endpoint = centerCross + branch.direction * branch.length;
    const endpointTile = Math.floor(endpoint / tileWidth);
    const capCoordinate =
      path.axis === 'x' ? { x: primaryTile, z: endpointTile } : { x: endpointTile, z: primaryTile };
    const capRenderer = new WorldStreamRenderer(new THREE.Scene(), branchWorld);
    const capGeometry = capRenderer.buildTileGeometry(level, capCoordinate, new THREE.Vector3());
    assert.ok(capGeometry, `${level} meshes the branch dead end.`);
    const capMesh = new THREE.Mesh(capGeometry, new THREE.MeshBasicMaterial());
    capMesh.scale.set(
      spacing * branchWorld.voxelSize,
      branchWorld.voxelSize,
      spacing * branchWorld.voxelSize,
    );
    capMesh.position.set(
      capCoordinate.x * tileWidth * branchWorld.voxelSize,
      0,
      capCoordinate.z * tileWidth * branchWorld.voxelSize,
    );
    capMesh.updateMatrixWorld(true);
    const capRay =
      path.axis === 'x'
        ? new THREE.Raycaster(
            new THREE.Vector3(
              (branch.along + 0.25) * branchWorld.voxelSize,
              center.y * branchWorld.voxelSize,
              (endpoint - branch.direction * 4) * branchWorld.voxelSize,
            ),
            new THREE.Vector3(0, 0, branch.direction),
          )
        : new THREE.Raycaster(
            new THREE.Vector3(
              (endpoint - branch.direction * 4) * branchWorld.voxelSize,
              center.y * branchWorld.voxelSize,
              (branch.along + 0.25) * branchWorld.voxelSize,
            ),
            new THREE.Vector3(branch.direction, 0, 0),
          );
    try {
      const hit = capRay.intersectObject(capMesh)[0];
      assert.ok(hit, `${level} closes the side passage at its generated dead end.`);
      const hitCross = (path.axis === 'x' ? hit.point.z : hit.point.x) / branchWorld.voxelSize;
      assert.ok(Math.abs(hitCross - endpoint) < 1e-5);
    } finally {
      capGeometry.dispose();
      capMesh.material.dispose();
      capRenderer.dispose();
    }
  }

  const compactBase = world([256, 256], 40, 20);
  const compactBranches = worldDocumentSchema.parse({
    ...compactBase,
    generator: { ...compactBase.generator, mode: 'voxel3d', caveNetwork: true, caveBranchCount: 4 },
  });
  const compactTrunk = worldDocumentSchema.parse({
    ...compactBase,
    generator: { ...compactBase.generator, mode: 'voxel3d', caveNetwork: true, caveBranchCount: 0 },
  });
  const compactTarget = new THREE.Vector3(1000, 0, 1000);
  const compactRenderer = new WorldStreamRenderer(new THREE.Scene(), compactBranches);
  const compactGeometry = compactRenderer.buildTileGeometry('horizon', { x: 0, z: 0 }, compactTarget);
  const compactBaselineRenderer = new WorldStreamRenderer(new THREE.Scene(), compactTrunk);
  const compactBaseline = compactBaselineRenderer.buildTileGeometry('horizon', { x: 0, z: 0 }, compactTarget);
  assert.ok(compactGeometry && compactBaseline);
  assert.ok(
    compactGeometry.getAttribute('position').count > compactBaseline.getAttribute('position').count,
    'A horizon tile keeps all four co-located authored branches.',
  );
  const compactBytes =
    compactGeometry.getAttribute('position').array.byteLength +
    compactGeometry.getAttribute('normal').array.byteLength +
    compactGeometry.getAttribute('color').array.byteLength +
    (compactGeometry.index?.array.byteLength ?? 0);
  assert.ok(compactBytes <= compactRenderer.stats().maximumCoarseBufferBytesPerTile);
  compactGeometry.dispose();
  compactBaseline.dispose();
  compactRenderer.dispose();
  compactBaselineRenderer.dispose();
});

test('far and horizon LOD carry connected cave-density mouths within bounded geometry', () => {
  const base = world([2048, 2048], 40, 20);
  const connectedWorld = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      caveDensity: 0.95,
      caveEntrancesPerRegion: 4,
      caveNetwork: true,
      caveNetworkReach: 2048,
      caveBranchCount: 0,
    },
  });
  const unconnectedWorld = worldDocumentSchema.parse({
    ...connectedWorld,
    generator: { ...connectedWorld.generator, caveNetworkReach: 0 },
  });
  const surfaceAt = createTerrainSurfaceSampler(connectedWorld);
  const path = createTerrainCaveNetworkPath(connectedWorld);
  assert.ok(path);
  const connectorsIn = createTerrainCaveNetworkConnectorSampler(connectedWorld, surfaceAt);
  const entrances = terrainCaveEntrancesIn(
    connectedWorld,
    { minX: 0, maxX: 2048, minZ: 0, maxZ: 2048 },
    surfaceAt,
  );
  const selected = entrances
    .map((mouth) => {
      const along = path.axis === 'x' ? mouth.x : mouth.z;
      const center = path.at(along);
      const mouthCross = path.axis === 'x' ? mouth.z : mouth.x;
      const trunkCross = path.axis === 'x' ? center.z : center.x;
      const tileX = Math.floor(mouth.x / 256);
      const tileZ = Math.floor(mouth.z / 256);
      const bounds = {
        minX: tileX * 256,
        maxX: (tileX + 1) * 256,
        minZ: tileZ * 256,
        maxZ: (tileZ + 1) * 256,
      };
      const connector = connectorsIn(bounds).find(
        ({ shaft }) => shaft[0][0] === mouth.x && shaft[0][2] === mouth.z,
      );
      return { connector, crossDistance: Math.abs(mouthCross - trunkCross) };
    })
    .find(
      ({ connector, crossDistance }) =>
        connector && crossDistance > 256 && connector.shaft[0][1] - connector.shaft[1][1] > 8,
    );
  assert.ok(selected?.connector, 'the fixture contains a distant mouth with a traversable shaft');
  const connector = selected.connector;
  const mouthX = connector.shaft[0][0];
  const mouthZ = connector.shaft[0][2];

  for (const level of ['far', 'horizon'] as const) {
    const spacing = level === 'far' ? 4 : 16;
    const tileWidth = 16 * spacing;
    const coordinate = { x: Math.floor(mouthX / tileWidth), z: Math.floor(mouthZ / tileWidth) };
    const bounds = {
      minX: coordinate.x * tileWidth,
      maxX: (coordinate.x + 1) * tileWidth,
      minZ: coordinate.z * tileWidth,
      maxZ: (coordinate.z + 1) * tileWidth,
    };
    assert.ok(
      connectorsIn(bounds).some(({ shaft }) => shaft[0][0] === mouthX && shaft[0][2] === mouthZ),
      `${level} tile sampling retains the shared connector descriptor`,
    );

    const target = new THREE.Vector3(-10000, 0, -10000);
    const renderer = new WorldStreamRenderer(new THREE.Scene(), connectedWorld);
    const baselineRenderer = new WorldStreamRenderer(new THREE.Scene(), unconnectedWorld);
    const geometry = renderer.buildTileGeometry(level, coordinate, target);
    const baseline = baselineRenderer.buildTileGeometry(level, coordinate, target);
    assert.ok(geometry && baseline, `${level} creates both comparable tile meshes`);
    assert.ok(
      geometry.getAttribute('position').count > baseline.getAttribute('position').count,
      `${level} adds the mouth shaft and its clipped trunk connector`,
    );
    const bytes =
      geometry.getAttribute('position').array.byteLength +
      geometry.getAttribute('normal').array.byteLength +
      geometry.getAttribute('color').array.byteLength +
      (geometry.index?.array.byteLength ?? 0);
    assert.ok(bytes <= renderer.stats().maximumCoarseBufferBytesPerTile);

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.scale.set(
      spacing * connectedWorld.voxelSize,
      connectedWorld.voxelSize,
      spacing * connectedWorld.voxelSize,
    );
    mesh.position.set(
      coordinate.x * tileWidth * connectedWorld.voxelSize,
      0,
      coordinate.z * tileWidth * connectedWorld.voxelSize,
    );
    mesh.updateMatrixWorld(true);
    const shaftY = (connector.shaft[0][1] + connector.shaft[1][1]) / 2;
    try {
      const hit = new THREE.Raycaster(
        new THREE.Vector3(
          mouthX * connectedWorld.voxelSize,
          shaftY * connectedWorld.voxelSize,
          mouthZ * connectedWorld.voxelSize,
        ),
        new THREE.Vector3(1, 0, 0),
      ).intersectObject(mesh)[0];
      assert.ok(hit, `${level} exposes the connector shaft wall from inside`);
      const hitX = hit.point.x / connectedWorld.voxelSize;
      assert.ok(
        hitX > mouthX + 1.35 && hitX < mouthX + 1.65,
        `${level} meets the three-cell cave-mouth boundary (hit=${hitX}, mouth=${mouthX})`,
      );

      const tunnelPoint: [number, number, number] = connector.tunnel[0].map(
        (start, index) => (start + connector.tunnel[1][index]) / 2,
      ) as [number, number, number];
      const tunnelCoordinate = {
        x: Math.floor(tunnelPoint[0] / tileWidth),
        z: Math.floor(tunnelPoint[2] / tileWidth),
      };
      const tunnelBounds = {
        minX: tunnelCoordinate.x * tileWidth,
        maxX: (tunnelCoordinate.x + 1) * tileWidth,
        minZ: tunnelCoordinate.z * tileWidth,
        maxZ: (tunnelCoordinate.z + 1) * tileWidth,
      };
      assert.ok(
        connectorsIn(tunnelBounds).some(({ shaft }) => shaft[0][0] === mouthX && shaft[0][2] === mouthZ),
        `${level} keeps the connector descriptor in its tunnel tile`,
      );
      const tunnelGeometry = renderer.buildTileGeometry(level, tunnelCoordinate, target);
      const tunnelBaseline = baselineRenderer.buildTileGeometry(level, tunnelCoordinate, target);
      assert.ok(tunnelGeometry && tunnelBaseline);
      const tunnelBytes =
        tunnelGeometry.getAttribute('position').array.byteLength +
        tunnelGeometry.getAttribute('normal').array.byteLength +
        tunnelGeometry.getAttribute('color').array.byteLength +
        (tunnelGeometry.index?.array.byteLength ?? 0);
      assert.ok(tunnelBytes <= renderer.stats().maximumCoarseBufferBytesPerTile);
      assert.ok(
        tunnelGeometry.getAttribute('position').count > tunnelBaseline.getAttribute('position').count,
        `${level} emits the clipped horizontal connector segment`,
      );
      const tunnelMesh = new THREE.Mesh(tunnelGeometry, new THREE.MeshBasicMaterial());
      tunnelMesh.scale.set(
        spacing * connectedWorld.voxelSize,
        connectedWorld.voxelSize,
        spacing * connectedWorld.voxelSize,
      );
      tunnelMesh.position.set(
        tunnelCoordinate.x * tileWidth * connectedWorld.voxelSize,
        0,
        tunnelCoordinate.z * tileWidth * connectedWorld.voxelSize,
      );
      tunnelMesh.updateMatrixWorld(true);
      try {
        const direction = path.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const hit = new THREE.Raycaster(
          new THREE.Vector3(
            tunnelPoint[0] * connectedWorld.voxelSize,
            tunnelPoint[1] * connectedWorld.voxelSize,
            tunnelPoint[2] * connectedWorld.voxelSize,
          ),
          direction,
        ).intersectObject(tunnelMesh)[0];
        assert.ok(hit, `${level} exposes the horizontal connector wall from inside`);
        const hitCross = (path.axis === 'x' ? hit.point.x : hit.point.z) / connectedWorld.voxelSize;
        const centerCross = path.axis === 'x' ? tunnelPoint[0] : tunnelPoint[2];
        assert.ok(
          hitCross > centerCross + 1.35 && hitCross < centerCross + 1.65,
          `${level} connector hit=${hitCross}, center=${centerCross}, axis=${path.axis}`,
        );
      } finally {
        tunnelGeometry.dispose();
        tunnelBaseline.dispose();
        tunnelMesh.material.dispose();
      }
    } finally {
      geometry.dispose();
      baseline.dispose();
      mesh.material.dispose();
      renderer.dispose();
      baselineRenderer.dispose();
    }
  }
});

test('far and horizon cave connectors keep inward tube faces in Z-major worlds', () => {
  const base = world([1024, 2048], 40, 20);
  const connected = worldDocumentSchema.parse({
    ...base,
    generator: {
      ...base.generator,
      mode: 'voxel3d',
      caveDensity: 0.95,
      caveEntrancesPerRegion: 4,
      caveNetwork: true,
      caveNetworkReach: 2048,
      caveBranchCount: 0,
    },
  });
  const path = createTerrainCaveNetworkPath(connected);
  assert.ok(path);
  assert.equal(path.axis, 'z');
  const surfaceAt = createTerrainSurfaceSampler(connected);
  const connectorsIn = createTerrainCaveNetworkConnectorSampler(connected, surfaceAt);
  const selected = terrainCaveEntrancesIn(connected, { minX: 0, maxX: 1024, minZ: 0, maxZ: 2048 }, surfaceAt)
    .map((mouth) => {
      const center = path.at(mouth.z);
      const connector = connectorsIn({
        minX: Math.floor(mouth.x / 256) * 256,
        maxX: (Math.floor(mouth.x / 256) + 1) * 256,
        minZ: Math.floor(mouth.z / 256) * 256,
        maxZ: (Math.floor(mouth.z / 256) + 1) * 256,
      }).find(({ shaft }) => shaft[0][0] === mouth.x && shaft[0][2] === mouth.z);
      return { connector, crossDistance: Math.abs(mouth.x - center.x) };
    })
    .find(
      ({ connector, crossDistance }) =>
        connector && crossDistance > 256 && connector.shaft[0][1] - connector.shaft[1][1] > 8,
    );
  assert.ok(selected?.connector);
  const connector = selected.connector;

  for (const level of ['far', 'horizon'] as const) {
    const spacing = level === 'far' ? 4 : 16;
    const tileWidth = spacing * 16;
    const midpoint: [number, number, number] = connector.tunnel[0].map(
      (value, index) => (value + connector.tunnel[1][index]) / 2,
    ) as [number, number, number];
    const coordinate = { x: Math.floor(midpoint[0] / tileWidth), z: Math.floor(midpoint[2] / tileWidth) };
    const renderer = new WorldStreamRenderer(new THREE.Scene(), connected);
    const geometry = renderer.buildTileGeometry(level, coordinate, new THREE.Vector3(-10000, 0, -10000));
    assert.ok(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.scale.set(spacing * connected.voxelSize, connected.voxelSize, spacing * connected.voxelSize);
    mesh.position.set(
      coordinate.x * tileWidth * connected.voxelSize,
      0,
      coordinate.z * tileWidth * connected.voxelSize,
    );
    mesh.updateMatrixWorld(true);
    try {
      const hit = new THREE.Raycaster(
        new THREE.Vector3(
          midpoint[0] * connected.voxelSize,
          midpoint[1] * connected.voxelSize,
          midpoint[2] * connected.voxelSize,
        ),
        new THREE.Vector3(0, 0, 1),
      ).intersectObject(mesh)[0];
      assert.ok(hit, `${level} has an inward-facing Z-major connector wall`);
      const hitZ = hit.point.z / connected.voxelSize;
      assert.ok(hitZ > midpoint[2] + 1.35 && hitZ < midpoint[2] + 1.65);
    } finally {
      geometry.dispose();
      mesh.material.dispose();
      renderer.dispose();
    }
  }
});
