import * as THREE from 'three';
import type { Asset } from '../services/projectDocument';
import {
  createTerrainCaveNetworkPath,
  createTerrainSurfaceSampler,
  terrainCaveNetworkContains,
  terrainCaveNetworkBranchContains,
  terrainCaveNetworkBranches,
} from '../services/terrainNoise';
import type { WorldCell, WorldDocument } from '../services/worldDocument';
import type { VoxelMaterial } from '../types';
import { createVoxelGeometryChunks } from './voxelGeometry';
import type { VoxelChunkCoordinate } from './worldVoxelWorkerProtocol';

const SOURCE_CHUNK_SIZE = 16;
export const WORLD_VOXEL_LOD_FACTOR = 2;
export const FAR_WORLD_VOXEL_LOD_FACTOR = 4;
export const VERY_FAR_WORLD_VOXEL_LOD_FACTOR = 8;
export const ULTRA_FAR_WORLD_VOXEL_LOD_FACTOR = 16;
export type WorldVoxelLodFactor =
  | typeof WORLD_VOXEL_LOD_FACTOR
  | typeof FAR_WORLD_VOXEL_LOD_FACTOR
  | typeof VERY_FAR_WORLD_VOXEL_LOD_FACTOR
  | typeof ULTRA_FAR_WORLD_VOXEL_LOD_FACTOR;
type CellAt = (position: { x: number; y: number; z: number }) => WorldCell | undefined;
type CoarseCell = WorldCell & { x: number; y: number; z: number };
const OPEN_NEIGHBORS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

type CaveCellFace = 0 | 1 | 2 | 3 | 4 | 5;

function inspectOpenCaveComponents(
  cells: Uint8Array,
  size: number,
  continuesOutside?: (face: CaveCellFace, x: number, y: number, z: number) => boolean,
) {
  const visited = new Uint8Array(cells.length);
  const queue = new Uint16Array(cells.length);
  const area = size * size;
  const minimumCavernCells = Math.ceil(cells.length / 16);
  const minimumCavernSpans = [Math.ceil(size / 4), Math.ceil(size / 2), Math.ceil(size / 2)];
  let hasBroadCavern = false;
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || visited[start]) continue;
    let head = 0,
      tail = 0,
      faces = 0,
      minX = size,
      minY = size,
      minZ = size,
      maxX = -1,
      maxY = -1,
      maxZ = -1;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / area);
      const remainder = index - y * area;
      const z = Math.floor(remainder / size);
      const x = remainder - z * size;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      if (x === 0) faces |= 1 << 0;
      if (x === size - 1) faces |= 1 << 1;
      if (y === 0) faces |= 1 << 2;
      if (y === size - 1) faces |= 1 << 3;
      if (z === 0) faces |= 1 << 4;
      if (z === size - 1) faces |= 1 << 5;
      if (
        (faces & 0b000011) === 0b000011 ||
        (faces & 0b001100) === 0b001100 ||
        (faces & 0b110000) === 0b110000
      )
        return { hasThroughPassage: true, hasBroadCavern: false };
      // A real tunnel can turn between adjacent faces inside one coarse cell.
      if (tail >= size && (faces & (faces - 1)) !== 0)
        return { hasThroughPassage: true, hasBroadCavern: false };

      for (const [dx, dy, dz] of OPEN_NEIGHBORS) {
        const nextX = x + dx,
          nextY = y + dy,
          nextZ = z + dz;
        if (nextX < 0 || nextX >= size || nextY < 0 || nextY >= size || nextZ < 0 || nextZ >= size) continue;
        const next = nextY * area + nextZ * size + nextX;
        if (!cells[next] || visited[next]) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    const spans = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1].sort((a, b) => a - b);
    if (tail < size && continuesOutside && (faces & (faces - 1)) !== 0) {
      let continuedFaces = 0;
      for (let entry = 0; entry < tail && (continuedFaces & (continuedFaces - 1)) === 0; entry++) {
        const index = queue[entry];
        const y = Math.floor(index / area);
        const remainder = index - y * area;
        const z = Math.floor(remainder / size);
        const x = remainder - z * size;
        if (x === 0 && continuesOutside(0, x, y, z)) continuedFaces |= 1 << 0;
        if (x === size - 1 && continuesOutside(1, x, y, z)) continuedFaces |= 1 << 1;
        if (y === 0 && continuesOutside(2, x, y, z)) continuedFaces |= 1 << 2;
        if (y === size - 1 && continuesOutside(3, x, y, z)) continuedFaces |= 1 << 3;
        if (z === 0 && continuesOutside(4, x, y, z)) continuedFaces |= 1 << 4;
        if (z === size - 1 && continuesOutside(5, x, y, z)) continuedFaces |= 1 << 5;
      }
      // A short bend is a real tunnel only when it connects to open source cells on both sides.
      if ((continuedFaces & (continuedFaces - 1)) !== 0)
        return { hasThroughPassage: true, hasBroadCavern: false };
    }
    if (tail >= minimumCavernCells && spans[0] >= minimumCavernSpans[0] && spans[1] >= minimumCavernSpans[1])
      hasBroadCavern = true;
    if (hasBroadCavern) break;
  }
  return { hasThroughPassage: false, hasBroadCavern };
}

/** Builds one source-chunk-aligned coarse mesh whose cells cover factor³ source cells. */
export function buildCoarseWorldVoxelChunk(
  world: WorldDocument,
  coordinate: VoxelChunkCoordinate,
  cellAt: CellAt,
  coarseFactor: WorldVoxelLodFactor = WORLD_VOXEL_LOD_FACTOR,
): { geometry: THREE.BufferGeometry; voxelCellCount: number } | null {
  const coarseChunkSize = SOURCE_CHUNK_SIZE / coarseFactor;
  const origin = {
    x: coordinate.x * SOURCE_CHUNK_SIZE,
    y: coordinate.y * SOURCE_CHUNK_SIZE,
    z: coordinate.z * SOURCE_CHUNK_SIZE,
  };
  const { generator } = world;
  const surfaceAt = generator.mode === 'voxel3d' ? createTerrainSurfaceSampler(world) : null;
  const caveNetworkPath = createTerrainCaveNetworkPath(world);
  const caveNetworkBranches = terrainCaveNetworkBranches(world, caveNetworkPath);
  const sourceSurfaceCache = new Map<string, number>();
  const surfaceAtColumn = (x: number, z: number) => {
    const key = `${x},${z}`;
    const cached = sourceSurfaceCache.get(key);
    if (cached !== undefined) return cached;
    const surface = surfaceAt!(x, z);
    sourceSurfaceCache.set(key, surface);
    return surface;
  };
  const cache = new Map<string, WorldCell | undefined>();
  const sampleCoarseCell = ({ x, y, z }: { x: number; y: number; z: number }): WorldCell | undefined => {
    const key = `${x},${y},${z}`;
    if (cache.has(key)) return cache.get(key);
    const sampleX = origin.x + x * coarseFactor + (coarseFactor - 1) / 2;
    const sampleY = origin.y + y * coarseFactor + (coarseFactor - 1) / 2;
    const sampleZ = origin.z + z * coarseFactor + (coarseFactor - 1) / 2;
    const insideWorld =
      sampleX >= generator.origin[0] &&
      sampleX < generator.origin[0] + generator.size[0] &&
      sampleZ >= generator.origin[1] &&
      sampleZ < generator.origin[1] + generator.size[1];
    const belowSurface =
      surfaceAt !== null &&
      insideWorld &&
      sampleY <= surfaceAtColumn(Math.floor(sampleX), Math.floor(sampleZ)) - 3;
    const openCaveCells = belowSurface ? new Uint8Array(coarseFactor ** 3) : null;
    const counts = new Map<
      string,
      { color: number; materialType: WorldCell['materialType']; count: number }
    >();
    let occupiedSamples = 0;
    let hasNetworkOpening = false;
    let hasNetworkBranchOpening = false;
    let sampleIndex = 0;
    for (let dy = 0; dy < coarseFactor; dy++)
      for (let dz = 0; dz < coarseFactor; dz++)
        for (let dx = 0; dx < coarseFactor; dx++) {
          const sourceX = origin.x + x * coarseFactor + dx;
          const sourceY = origin.y + y * coarseFactor + dy;
          const sourceZ = origin.z + z * coarseFactor + dz;
          const cell = cellAt({
            x: sourceX,
            y: sourceY,
            z: sourceZ,
          });
          if (!cell) {
            if (
              openCaveCells &&
              sourceY >= generator.minY &&
              sourceY <= generator.maxY &&
              sourceX >= generator.origin[0] &&
              sourceX < generator.origin[0] + generator.size[0] &&
              sourceZ >= generator.origin[1] &&
              sourceZ < generator.origin[1] + generator.size[1] &&
              sourceY <= surfaceAtColumn(sourceX, sourceZ) - 3
            ) {
              openCaveCells[sampleIndex] = 1;
              if (
                coarseFactor === 16 &&
                caveNetworkPath &&
                terrainCaveNetworkContains(caveNetworkPath, sourceX, sourceY, sourceZ)
              )
                hasNetworkOpening = true;
              if (
                caveNetworkPath &&
                caveNetworkBranches.some((branch) =>
                  terrainCaveNetworkBranchContains(caveNetworkPath, branch, sourceX, sourceY, sourceZ),
                )
              )
                hasNetworkBranchOpening = true;
            }
            sampleIndex++;
            continue;
          }
          occupiedSamples++;
          const key = `${cell.color}:${cell.materialType}`;
          const sample = counts.get(key);
          if (sample) sample.count++;
          else counts.set(key, { color: cell.color, materialType: cell.materialType, count: 1 });
          sampleIndex++;
        }
    const selected = [...counts.values()].sort(
      (a, b) =>
        b.count - a.count ||
        a.color - b.color ||
        (a.materialType < b.materialType ? -1 : a.materialType > b.materialType ? 1 : 0),
    )[0];
    const majoritySolid = occupiedSamples * 2 >= coarseFactor ** 3;
    const openCaveComponents =
      belowSurface && majoritySolid && openCaveCells !== null
        ? inspectOpenCaveComponents(openCaveCells, coarseFactor, (face, localX, localY, localZ) => {
            const source = {
              x: origin.x + x * coarseFactor + localX,
              y: origin.y + y * coarseFactor + localY,
              z: origin.z + z * coarseFactor + localZ,
            };
            if (face === 0) source.x--;
            else if (face === 1) source.x++;
            else if (face === 2) source.y--;
            else if (face === 3) source.y++;
            else if (face === 4) source.z--;
            else source.z++;
            return (
              source.y >= generator.minY &&
              source.y <= generator.maxY &&
              source.x >= generator.origin[0] &&
              source.x < generator.origin[0] + generator.size[0] &&
              source.z >= generator.origin[1] &&
              source.z < generator.origin[1] + generator.size[1] &&
              source.y <= surfaceAtColumn(source.x, source.z) - 3 &&
              !cellAt(source)
            );
          })
        : null;
    const connectedPassage = openCaveComponents?.hasThroughPassage ?? false;
    // At the coarsest tier, retain substantial enclosed rooms as empty cells. Smaller pockets
    // still collapse into solid to prevent isolated noise from eroding distant terrain.
    const broadCavern = coarseFactor === 16 && (openCaveComponents?.hasBroadCavern ?? false);
    // Preserve authored branch endpoints as empty cells even when the passage does not cross this coarse cell.
    const result =
      selected &&
      (!belowSurface ||
        (majoritySolid &&
          !connectedPassage &&
          !broadCavern &&
          !hasNetworkOpening &&
          !hasNetworkBranchOpening))
        ? { color: selected.color, materialType: selected.materialType }
        : undefined;
    cache.set(key, result);
    return result;
  };

  const voxels: CoarseCell[] = [];
  for (let y = 0; y < coarseChunkSize; y++)
    for (let z = 0; z < coarseChunkSize; z++)
      for (let x = 0; x < coarseChunkSize; x++) {
        const cell = sampleCoarseCell({ x, y, z });
        if (cell) voxels.push({ x, y, z, ...cell, materialType: cell.materialType as VoxelMaterial });
      }
  if (!voxels.length) return null;

  const asset = {
    id: world.id,
    name: world.name,
    model: { voxels },
    rig: null,
  } as unknown as Asset;
  const geometry = createVoxelGeometryChunks(asset, [], 0, (position) => {
    const cell = sampleCoarseCell(position);
    return (
      cell && {
        ...cell,
        x: position.x,
        y: position.y,
        z: position.z,
        materialType: cell.materialType as VoxelMaterial,
      }
    );
  })[0]?.geometry;
  if (!geometry) return null;

  // Source cells are centered at integers; align each coarse cell to the source-cell group center.
  geometry.translate(
    (coarseFactor - 1) / (2 * coarseFactor),
    (coarseFactor - 1) / (2 * coarseFactor),
    (coarseFactor - 1) / (2 * coarseFactor),
  );
  return { geometry, voxelCellCount: voxels.length };
}
