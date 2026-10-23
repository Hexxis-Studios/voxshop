import * as THREE from 'three';
import type { Asset, Rig } from '../services/projectDocument';
import { resolveSkinWeights } from '../services/skinWeights';

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
function skin(v: Asset['model']['voxels'][number], rig: Rig) {
  return resolveSkinWeights(
    v,
    rig.joints.map((joint) => joint.name),
  );
}

export const VOXEL_MATERIALS = ['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE'];
export const VOXEL_CHUNK_SIZE = 16;

type Voxel = Asset['model']['voxels'][number];
type VoxelNeighborLookup = (position: { x: number; y: number; z: number }) => Voxel | undefined;
type Plane = Map<string, Voxel>;
type GeometryBuilder = {
  origin: [number, number, number];
  positions: number[];
  normals: number[];
  colors: number[];
  skinIndices: number[];
  skinWeights: number[];
  indices: number[];
  groups: THREE.BufferGeometry['groups'];
};
export type VoxelGeometryChunk = {
  origin: [number, number, number];
  geometry: THREE.BufferGeometry;
};

/** Static terrain LOD keeps vertical steps and coarsens only the horizontal surface grid. */
export const TERRAIN_LOD_CELL_SIZE = 4;
export const TERRAIN_FAR_LOD_CELL_SIZE = 6;
export type TerrainLodTransform = { scaleX: number; scaleZ: number; offsetX: number; offsetZ: number };

/** Map coarse horizontal cells back onto the source model's exact X/Z bounds. */
export function getTerrainLodTransform(asset: Asset, cellSize = TERRAIN_LOD_CELL_SIZE): TerrainLodTransform {
  if (!Number.isInteger(cellSize) || cellSize < 2)
    throw new Error('Terrain LOD cell size must be an integer of at least two.');
  if (!asset.model.voxels.length) return { scaleX: 1, scaleZ: 1, offsetX: 0, offsetZ: 0 };
  const axis = (name: 'x' | 'z') => {
    let min = Infinity,
      max = -Infinity;
    for (const voxel of asset.model.voxels) {
      min = Math.min(min, voxel[name]);
      max = Math.max(max, voxel[name]);
    }
    const minCell = Math.floor((min + 0.5) / cellSize),
      maxCell = Math.floor((max + 0.5) / cellSize),
      sourceMin = min - 0.5,
      sourceMax = max + 0.5,
      coarseMin = minCell * cellSize - cellSize / 2,
      coarseMax = maxCell * cellSize + cellSize / 2,
      scale = (sourceMax - sourceMin) / (coarseMax - coarseMin);
    return { scale, offset: sourceMin - coarseMin * scale };
  };
  const x = axis('x'),
    z = axis('z');
  return { scaleX: x.scale, scaleZ: z.scale, offsetX: x.offset, offsetZ: z.offset };
}

function emptyGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
  geometry.setIndex([]);
  return geometry;
}

function builder(origin: [number, number, number]): GeometryBuilder {
  return {
    origin,
    positions: [],
    normals: [],
    colors: [],
    skinIndices: [],
    skinWeights: [],
    indices: [],
    groups: [],
  };
}

/** Greedy voxel surface mesh, optionally split into independently frustum-culled cells. */
export function createVoxelGeometryChunks(
  asset: Asset,
  hiddenBones: string[] = [],
  chunkSize = 0,
  neighborAt?: VoxelNeighborLookup,
): VoxelGeometryChunk[] {
  if (chunkSize < 0 || !Number.isInteger(chunkSize))
    throw new Error('Voxel chunk size must be a nonnegative integer.');
  const rig = asset.rig;
  const size = !rig && chunkSize ? chunkSize : 0;
  const materials = VOXEL_MATERIALS;
  const hidden = new Set(hiddenBones);
  const grid = new Map<string, Voxel>();
  for (const voxel of asset.model.voxels)
    if (!hidden.has(voxel.bone ?? '')) grid.set(`${voxel.x},${voxel.y},${voxel.z}`, voxel);
  const voxelsByMaterial = new Map(materials.map((material) => [material, [] as Voxel[]]));
  for (const voxel of grid.values()) voxelsByMaterial.get(voxel.materialType ?? 'STANDARD')!.push(voxel);
  const poseKeys = new WeakMap<Voxel, string>();
  const poseKey = (v: Voxel) => {
    const cached = poseKeys.get(v);
    if (cached !== undefined) return cached;
    if (!rig) return '';
    const influence = skin(v, rig);
    const key = JSON.stringify([influence.indices, influence.weights]);
    poseKeys.set(v, key);
    return key;
  };
  const chunks = new Map<string, GeometryBuilder>();
  const getChunk = (v: Voxel) => {
    const coords: [number, number, number] = size
      ? [Math.floor(v.x / size), Math.floor(v.y / size), Math.floor(v.z / size)]
      : [0, 0, 0];
    const key = coords.join(',');
    let target = chunks.get(key);
    if (!target) {
      target = builder(size ? (coords.map((n) => n * size) as [number, number, number]) : [0, 0, 0]);
      chunks.set(key, target);
    }
    return target;
  };
  for (let mi = 0; mi < materials.length; mi++) {
    const planesByChunk = new Map<GeometryBuilder, Map<string, Plane>>();
    const directFaceStarts = new Map<GeometryBuilder, number>();
    for (const v of voxelsByMaterial.get(materials[mi])!) {
      for (let face = 0; face < 6; face++) {
        const d = neighborDirections[face],
          neighborPosition = { x: v.x + d[0], y: v.y + d[1], z: v.z + d[2] },
          neighbor =
            grid.get(`${neighborPosition.x},${neighborPosition.y},${neighborPosition.z}`) ??
            neighborAt?.(neighborPosition);
        if (
          neighbor &&
          (neighbor.materialType ?? 'STANDARD') !== 'GLASS' &&
          (!rig || poseKey(neighbor) === poseKey(v))
        )
          continue;

        const target = getChunk(v);
        // Keep transparent faces and rig seams separate; merge only rigid opaque faces.
        if (rig || materials[mi] === 'GLASS') {
          if (!directFaceStarts.has(target)) directFaceStarts.set(target, target.indices.length);
          emit(target, v, face, 1, 1);
          continue;
        }
        let planes = planesByChunk.get(target);
        if (!planes) {
          planes = new Map<string, Plane>();
          planesByChunk.set(target, planes);
        }
        const axis = Math.floor(face / 2),
          u = (axis + 1) % 3,
          w = (axis + 2) % 3,
          xyz = [v.x, v.y, v.z],
          key = `${face}:${xyz[axis]}:${v.color}`;
        if (!planes.has(key)) planes.set(key, new Map());
        planes.get(key)!.set(`${xyz[u]},${xyz[w]}`, v);
      }
    }
    for (const [target, planes] of planesByChunk) {
      const start = target.indices.length;
      for (const [key, cells] of planes) {
        const face = Number(key.split(':')[0]),
          axis = Math.floor(face / 2),
          u = (axis + 1) % 3,
          w = (axis + 2) % 3;
        // Sparse rows avoid a volume-sized mask for widely separated voxels.
        const sorted = [...cells.values()].sort((a, b) => {
          const x = [a.x, a.y, a.z],
            y = [b.x, b.y, b.z];
          return x[w] - y[w] || x[u] - y[u];
        });
        for (const v of sorted) {
          const xyz = [v.x, v.y, v.z],
            x = xyz[u],
            y = xyz[w];
          if (!cells.has(`${x},${y}`)) continue;
          let width = 1,
            height = 1;
          while (cells.has(`${x + width},${y}`)) width++;
          rows: while (true) {
            for (let dx = 0; dx < width; dx++) if (!cells.has(`${x + dx},${y + height}`)) break rows;
            height++;
          }
          for (let dy = 0; dy < height; dy++)
            for (let dx = 0; dx < width; dx++) cells.delete(`${x + dx},${y + dy}`);
          emit(target, v, face, width, height);
        }
      }
      if (target.indices.length > start)
        target.groups.push({ start, count: target.indices.length - start, materialIndex: mi });
    }
    for (const [target, start] of directFaceStarts)
      target.groups.push({ start, count: target.indices.length - start, materialIndex: mi });
  }

  return [...chunks.values()]
    .filter((target) => target.indices.length > 0)
    .map((target) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(target.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(target.normals, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(target.colors, 3));
      geometry.setIndex(target.indices);
      target.groups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex));
      if (rig) {
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(target.skinIndices, 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(target.skinWeights, 4));
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return { origin: target.origin, geometry };
    });

  function emit(target: GeometryBuilder, v: Voxel, face: number, width: number, height: number) {
    const color = new THREE.Color(v.color),
      axis = Math.floor(face / 2),
      u = (axis + 1) % 3,
      w = (axis + 2) % 3,
      xyz = [v.x, v.y, v.z],
      base = target.positions.length / 3;
    for (let k = 0; k < 4; k++) {
      const vi = face * 4 + k;
      const corner = [positions.getX(vi), positions.getY(vi), positions.getZ(vi)];
      if (corner[u] > 0) corner[u] += width - 1;
      if (corner[w] > 0) corner[w] += height - 1;
      target.positions.push(...corner.map((n, i) => n + xyz[i] - target.origin[i]));
      target.normals.push(normals.getX(vi), normals.getY(vi), normals.getZ(vi));
      target.colors.push(color.r, color.g, color.b);
      if (rig) {
        const weights = skin(v, rig);
        target.skinIndices.push(...weights.indices);
        target.skinWeights.push(...weights.weights);
      }
    }
    for (let k = 0; k < 6; k++) target.indices.push(base + indices.getX(face * 6 + k) - face * 4);
  }
}

export function createVoxelGeometry(asset: Asset, hiddenBones: string[] = []) {
  return createVoxelGeometryChunks(asset, hiddenBones)[0]?.geometry ?? emptyGeometry();
}

/** Aggregate each horizontal terrain cell while retaining its occupied heights and modal palette. */
export function createTerrainLodGeometryChunks(
  asset: Asset,
  chunkSize = VOXEL_CHUNK_SIZE,
  cellSize = TERRAIN_LOD_CELL_SIZE,
): VoxelGeometryChunk[] {
  if (!Number.isInteger(cellSize) || cellSize < 2)
    throw new Error('Terrain LOD cell size must be an integer of at least two.');
  type Sample = { count: number; voxel: Voxel };
  const cells = new Map<string, { x: number; y: number; z: number; samples: Map<string, Sample> }>();
  for (const voxel of asset.model.voxels) {
    const x = Math.floor((voxel.x + 0.5) / cellSize),
      z = Math.floor((voxel.z + 0.5) / cellSize),
      key = `${x},${voxel.y},${z}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { x, y: voxel.y, z, samples: new Map() };
      cells.set(key, cell);
    }
    const sampleKey = `${voxel.color}:${voxel.materialType ?? 'STANDARD'}`;
    const sample = cell.samples.get(sampleKey);
    if (sample) sample.count++;
    else cell.samples.set(sampleKey, { count: 1, voxel });
  }
  const voxels = [...cells.values()].map((cell) => {
    const sample = [...cell.samples.entries()].sort(
      ([aKey, a], [bKey, b]) => b.count - a.count || aKey.localeCompare(bKey),
    )[0][1].voxel;
    return { ...sample, x: cell.x, y: cell.y, z: cell.z };
  });
  return createVoxelGeometryChunks({ ...asset, model: { ...asset.model, voxels } }, [], chunkSize);
}
