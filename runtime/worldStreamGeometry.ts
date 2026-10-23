import * as THREE from 'three';
import {
  createTerrainCaveNetworkPath,
  createTerrainCaveNetworkConnectorSampler,
  createTerrainCaveFieldVoidSampler,
  createTerrainSurfaceSampler,
  terrainCaveNetworkBranches,
  terrainCaveEntrance,
  terrainCaveEntrancesIn,
  TERRAIN_CAVE_BRANCH_LIMIT,
  TERRAIN_CAVE_NETWORK_BRANCH_RADIUS,
  TERRAIN_CAVE_NETWORK_LATERAL_RADIUS,
  TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS,
  TERRAIN_CAVE_NETWORK_MAX_CONNECTORS_PER_TILE,
  TERRAIN_CAVE_NETWORK_VERTICAL_RADIUS,
  TERRAIN_CAVE_ENTRANCE_LIMIT,
  TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT,
  TERRAIN_OVERHANG_HEIGHT_LIMIT,
  type TerrainCaveNetworkConnector,
} from '../services/terrainNoise';
import type { WorldCell, WorldDocument } from '../services/worldDocument';
import { VOXEL_CHUNK_SIZE } from './voxelGeometry';
import type { TileCoordinate } from './worldStreamWorkerProtocol';

const TILE_SIZE = VOXEL_CHUNK_SIZE;
export const MAXIMUM_APERTURE_COARSE_CELLS = 16;
export const MAXIMUM_APERTURE_OPEN_CELLS = 36;
export const MAXIMUM_APERTURE_WALLS = MAXIMUM_APERTURE_OPEN_CELLS * 4;
export const COARSE_CAVE_NETWORK_TUNNEL_SIDES = 8;
const MAXIMUM_COARSE_CAVE_FIELD_SHAFTS_PER_TILE = TERRAIN_CAVE_ENTRANCE_LIMIT * 2;
const MINIMUM_COARSE_CAVE_FIELD_SHAFT_DEPTH = 8;
const MAXIMUM_COARSE_CAVE_FIELD_SHAFT_DEPTH = 256;
export const MAXIMUM_COARSE_CAVE_VOLUME_SAMPLE_LAYERS = 32;
export const MAXIMUM_COARSE_CAVE_VOLUME_FACES_PER_TILE = 2048;
const MAXIMUM_HORIZON_CAVE_BOUNDARY_PROBES_PER_TILE = 512;
export const MAXIMUM_COARSE_OVERHANG_WALLS_PER_TILE = TILE_SIZE * TILE_SIZE * 2;
export const COARSE_CAVE_VOLUME_BUFFER_BYTES =
  MAXIMUM_COARSE_CAVE_VOLUME_FACES_PER_TILE *
  (4 * 9 * Float32Array.BYTES_PER_ELEMENT + 6 * Uint32Array.BYTES_PER_ELEMENT);
export const COARSE_OVERHANG_VOLUME_BUFFER_BYTES =
  MAXIMUM_COARSE_OVERHANG_WALLS_PER_TILE *
  (4 * 9 * Float32Array.BYTES_PER_ELEMENT + 6 * Uint32Array.BYTES_PER_ELEMENT);
// Mesh the boundary between open and solid source-cell centers, not the center-to-center occupancy radius.
export const COARSE_CAVE_NETWORK_CONNECTOR_MESH_RADIUS = TERRAIN_CAVE_NETWORK_CONNECTOR_RADIUS - 0.5;
export const COARSE_CAVE_NETWORK_TUNNEL_BUFFER_BYTES =
  TILE_SIZE *
  COARSE_CAVE_NETWORK_TUNNEL_SIDES *
  (4 * 9 * Float32Array.BYTES_PER_ELEMENT + 6 * Uint32Array.BYTES_PER_ELEMENT);
export const COARSE_CAVE_NETWORK_BRANCH_BUFFER_BYTES =
  TERRAIN_CAVE_BRANCH_LIMIT *
  (TILE_SIZE *
    COARSE_CAVE_NETWORK_TUNNEL_SIDES *
    (4 * 9 * Float32Array.BYTES_PER_ELEMENT + 6 * Uint32Array.BYTES_PER_ELEMENT) +
    COARSE_CAVE_NETWORK_TUNNEL_SIDES *
      (3 * 9 * Float32Array.BYTES_PER_ELEMENT + 3 * Uint32Array.BYTES_PER_ELEMENT));
export const COARSE_CAVE_NETWORK_CONNECTOR_BUFFER_BYTES =
  TERRAIN_CAVE_NETWORK_MAX_CONNECTORS_PER_TILE *
  2 *
  COARSE_CAVE_NETWORK_TUNNEL_SIDES *
  (4 * 9 * Float32Array.BYTES_PER_ELEMENT + 6 * Uint32Array.BYTES_PER_ELEMENT);
const materials = ['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE'] as const;
type MaterialType = (typeof materials)[number];
export type ColumnBand = { start: number; end: number; value: WorldCell };
type ColumnTop = { top: number; value: WorldCell };
type FaceBuilder = { positions: number[]; normals: number[]; colors: number[]; indices: number[] };
type TileBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
type SurfaceNormal = [number, number, number];
// Halfway toward the sampled heightfield normal softens far faceting without erasing relief.
const COARSE_NORMAL_SMOOTHING = 0.5;
const editColumnKey = (x: number, z: number) => x + ',' + z;
const normalizeNormal = ([x, y, z]: SurfaceNormal): SurfaceNormal => {
  const magnitude = Math.hypot(x, y, z);
  return [x / magnitude, y / magnitude, z / magnitude];
};

/** Builds near and coarse heightfield tile geometry from cached source columns. */
export class WorldStreamGeometryBuilder {
  constructor(
    private readonly world: WorldDocument,
    private readonly columnAt: (x: number, z: number) => ColumnBand[],
    private readonly columnTopAt: (x: number, z: number) => ColumnTop | null,
    private readonly authoredCellAt: (x: number, y: number, z: number) => boolean = () => false,
    private readonly caveOpeningAt: (x: number, z: number) => boolean = () => false,
    private readonly editedColumnsIn: (bounds: TileBounds) => { x: number; z: number }[] = () => [],
    private readonly surfaceAt: (x: number, z: number) => number = createTerrainSurfaceSampler(world),
    private readonly volumeAt?: (x: number, y: number, z: number) => boolean,
    private readonly caveFieldVoidAt: (
      x: number,
      y: number,
      z: number,
    ) => boolean = createTerrainCaveFieldVoidSampler(world, surfaceAt),
    private readonly hasEditedOverridesIn: (bounds: TileBounds) => boolean = () => false,
    private readonly editedOverrideColumnsIn: (bounds: TileBounds) => { x: number; z: number }[] = () => [],
    private readonly editedCaveSamplesIn: (
      bounds: TileBounds,
      spacing: number,
      minY: number,
      verticalStep: number,
    ) => { x: number; y: number; z: number }[] = () => [],
  ) {
    this.caveNetworkConnectorSampler = createTerrainCaveNetworkConnectorSampler(world, surfaceAt);
  }

  private readonly caveNetworkConnectorSampler: ReturnType<typeof createTerrainCaveNetworkConnectorSampler>;

  buildNearTileGeometry({ x, z }: TileCoordinate, nearBounds: TileBounds, excludedY?: [number, number]) {
    // Cache only this tile's 1-cell neighbor border; neighbor data comes directly from
    // the descriptor and edit index, so either side is correct as soon as its tile meshes.
    const startX = x * TILE_SIZE;
    const startZ = z * TILE_SIZE;
    const faces = materials.map((): FaceBuilder => ({ positions: [], normals: [], colors: [], indices: [] }));
    for (let localZ = 0; localZ < TILE_SIZE; localZ++) {
      for (let localX = 0; localX < TILE_SIZE; localX++) {
        const cellX = startX + localX;
        const cellZ = startZ + localZ;
        const column = this.columnAt(cellX, cellZ);
        if (!column.length) continue;
        for (let bandIndex = 0; bandIndex < column.length; bandIndex++) {
          const source = column[bandIndex];
          if (excludedY && source.start >= excludedY[0] && source.end <= excludedY[1]) continue;
          const parts = excludedY
            ? [
                { ...source, end: Math.min(source.end, excludedY[0]) },
                { ...source, start: Math.max(source.start, excludedY[1]) },
              ].filter((part) => part.end > part.start)
            : [source];
          for (const band of parts) {
            if (band.end === source.end && column[bandIndex + 1]?.start !== source.end) {
              this.emit(
                faces,
                band.value,
                [
                  [localX - 0.5, band.end - 0.5, localZ - 0.5],
                  [localX - 0.5, band.end - 0.5, localZ + 0.5],
                  [localX + 0.5, band.end - 0.5, localZ + 0.5],
                  [localX + 0.5, band.end - 0.5, localZ - 0.5],
                ],
                [0, 1, 0],
              );
            }
            if (band.start === source.start && column[bandIndex - 1]?.end !== source.start) {
              this.emit(
                faces,
                band.value,
                [
                  [localX - 0.5, band.start - 0.5, localZ - 0.5],
                  [localX + 0.5, band.start - 0.5, localZ - 0.5],
                  [localX + 0.5, band.start - 0.5, localZ + 0.5],
                  [localX - 0.5, band.start - 0.5, localZ + 0.5],
                ],
                [0, -1, 0],
              );
            }

            const left = this.columnAt(cellX - 1, cellZ);
            const right = this.columnAt(cellX + 1, cellZ);
            const back = this.columnAt(cellX, cellZ - 1);
            const front = this.columnAt(cellX, cellZ + 1);
            // The coarse neighbor supplies the LOD transition surface, so a
            // detailed cliff against its unsampled columns would form a skirt.
            if (!(cellX === nearBounds.minX && left.length))
              this.emitSideDifferences(faces, band, left, 'left', localX, localZ);
            if (!(cellX === nearBounds.maxX - 1 && right.length))
              this.emitSideDifferences(faces, band, right, 'right', localX, localZ);
            if (!(cellZ === nearBounds.minZ && back.length))
              this.emitSideDifferences(faces, band, back, 'back', localX, localZ);
            if (!(cellZ === nearBounds.maxZ - 1 && front.length))
              this.emitSideDifferences(faces, band, front, 'front', localX, localZ);
          }
        }
      }
    }

    return this.geometryFromFaces(faces);
  }

  buildCoarseTileGeometry(
    { x, z }: TileCoordinate,
    spacing: number,
    lowerTierSpacing: number,
    excludedBounds: TileBounds,
    preserveCaveAperture = false,
    preserveApertureFanProfile = false,
  ) {
    const { generator } = this.world;
    const caveNetworkPath = preserveCaveAperture ? createTerrainCaveNetworkPath(this.world) : null;
    const caveNetworkBranches = caveNetworkPath
      ? terrainCaveNetworkBranches(this.world, caveNetworkPath)
      : [];
    const tileWidth = TILE_SIZE * spacing;
    const tileBounds = {
      minX: x * tileWidth,
      maxX: (x + 1) * tileWidth,
      minZ: z * tileWidth,
      maxZ: (z + 1) * tileWidth,
    };
    const generatedEntrances =
      preserveCaveAperture && generator.mode === 'voxel3d'
        ? terrainCaveEntrancesIn(this.world, tileBounds, this.surfaceAt)
        : [];
    const caveNetworkConnectors =
      caveNetworkPath && generator.caveDensity ? this.caveNetworkConnectorSampler(tileBounds) : [];
    const entrance = generator.mode === 'voxel3d' ? terrainCaveEntrance(this.world) : null;
    const entranceX = entrance?.x ?? null;
    const entranceZ = entrance?.z ?? null;
    const entranceColumn =
      entranceX === null || entranceZ === null ? null : this.columnTopAt(entranceX, entranceZ);
    const entranceSurfaceEnd =
      entranceX === null || entranceZ === null ? undefined : this.columnAt(entranceX, entranceZ).at(-1)?.end;
    const entranceSurface = entranceSurfaceEnd === undefined ? undefined : entranceSurfaceEnd - 1;
    const hasEntranceOpening =
      entranceColumn !== null && entranceSurface !== undefined && entranceColumn.top < entranceSurface;
    const apertureOpenings = new Map<string, Map<string, ColumnTop>>();
    if (preserveCaveAperture) {
      const startX = x * TILE_SIZE * spacing,
        startZ = z * TILE_SIZE * spacing;
      const candidates = new Map<string, { x: number; z: number }>();
      for (const position of this.editedColumnsIn({
        minX: startX,
        maxX: startX + TILE_SIZE * spacing,
        minZ: startZ,
        maxZ: startZ + TILE_SIZE * spacing,
      }))
        candidates.set(editColumnKey(position.x, position.z), position);
      const addEntranceCells = (caveEntrance: { x: number; z: number }) => {
        for (let sourceZ = caveEntrance.z - 1; sourceZ <= caveEntrance.z + 1; sourceZ++)
          for (let sourceX = caveEntrance.x - 1; sourceX <= caveEntrance.x + 1; sourceX++)
            candidates.set(editColumnKey(sourceX, sourceZ), { x: sourceX, z: sourceZ });
      };
      if (
        entranceX !== null &&
        entranceZ !== null &&
        entranceX >= startX - 1 &&
        entranceX <= startX + TILE_SIZE * spacing &&
        entranceZ >= startZ - 1 &&
        entranceZ <= startZ + TILE_SIZE * spacing
      )
        addEntranceCells({ x: entranceX, z: entranceZ });
      for (const caveEntrance of generatedEntrances) addEntranceCells(caveEntrance);

      const groups = new Map<string, { x: number; z: number; openings: Map<string, ColumnTop> }>();
      for (const { x: sourceX, z: sourceZ } of candidates.values()) {
        if (!this.caveOpeningAt(sourceX, sourceZ)) continue;
        const floor = this.columnTopAt(sourceX, sourceZ);
        if (!floor) continue;
        const cellX = Math.floor(sourceX / spacing),
          cellZ = Math.floor(sourceZ / spacing),
          key = editColumnKey(cellX, cellZ);
        let group = groups.get(key);
        if (!group) groups.set(key, (group = { x: cellX, z: cellZ, openings: new Map() }));
        group.openings.set(editColumnKey(sourceX, sourceZ), floor);
      }
      const centerX = startX + (TILE_SIZE * spacing) / 2,
        centerZ = startZ + (TILE_SIZE * spacing) / 2;
      const orderedGroups = [...groups.values()].sort(
        (a, b) =>
          b.openings.size - a.openings.size ||
          Math.hypot(a.x * spacing + spacing / 2 - centerX, a.z * spacing + spacing / 2 - centerZ) -
            Math.hypot(b.x * spacing + spacing / 2 - centerX, b.z * spacing + spacing / 2 - centerZ) ||
          a.z - b.z ||
          a.x - b.x,
      );
      let openCellBudget = MAXIMUM_APERTURE_OPEN_CELLS;
      const selectedGroups = orderedGroups.slice(0, MAXIMUM_APERTURE_COARSE_CELLS);
      let remainingOpenings = selectedGroups.reduce((total, group) => total + group.openings.size, 0);
      const preserveAllSelectedOpenings = remainingOpenings <= openCellBudget;
      for (const [groupIndex, group] of selectedGroups.entries()) {
        // Preserve every cave mouth when it fits; otherwise share the fixed budget
        // across coarse cells so one dense edited opening cannot consume it all.
        const groupBudget = preserveAllSelectedOpenings
          ? group.openings.size
          : Math.min(group.openings.size, Math.ceil(openCellBudget / (selectedGroups.length - groupIndex)));
        const openings = [...group.openings.entries()]
          .sort((a, b) => {
            const [ax, az] = a[0].split(',').map(Number),
              [bx, bz] = b[0].split(',').map(Number);
            return (
              Math.hypot(
                ax - (group.x * spacing + (spacing - 1) / 2),
                az - (group.z * spacing + (spacing - 1) / 2),
              ) -
                Math.hypot(
                  bx - (group.x * spacing + (spacing - 1) / 2),
                  bz - (group.z * spacing + (spacing - 1) / 2),
                ) ||
              az - bz ||
              ax - bx
            );
          })
          .slice(0, groupBudget);
        if (!openings.length) continue;
        apertureOpenings.set(editColumnKey(group.x, group.z), new Map(openings));
        openCellBudget -= openings.length;
        if (!openCellBudget) break;
      }
    }
    const coarseSampler = (cellSpacing: number, preserveFanProfile = false) => {
      const coarseColumns = new Map<string, ColumnTop | null>();
      const cornerHeights = new Map<string, number>();
      const columnAt = (cellX: number, cellZ: number): ColumnTop | null => {
        const key = editColumnKey(cellX, cellZ);
        if (coarseColumns.has(key)) return coarseColumns.get(key)!;
        let highest: ColumnTop | null = null;
        const colorTotal = new THREE.Color(0);
        const sampleColor = new THREE.Color(0);
        let colorSamples = 0;
        let highestAuthored: ColumnTop | null = null;
        const sourceX = cellX * cellSpacing;
        const sourceZ = cellZ * cellSpacing;
        for (let zOffset = 0; zOffset < cellSpacing; zOffset++) {
          for (let xOffset = 0; xOffset < cellSpacing; xOffset++) {
            const sampleX = sourceX + xOffset;
            const sampleZ = sourceZ + zOffset;
            const top = this.columnTopAt(sampleX, sampleZ);
            if (!top) continue;
            const fanTop =
              preserveFanProfile &&
              apertureOpenings.get(editColumnKey(cellX, cellZ))?.has(editColumnKey(sampleX, sampleZ))
                ? { ...top, top: this.surfaceAt(sampleX, sampleZ) }
                : top;
            if (!highest || fanTop.top > highest.top) highest = fanTop;
            sampleColor.setHex(top.value.color);
            colorTotal.add(sampleColor);
            colorSamples++;
            if (
              this.authoredCellAt(sourceX + xOffset, top.top, sourceZ + zOffset) &&
              (!highestAuthored || top.top > highestAuthored.top)
            )
              highestAuthored = top;
          }
        }
        // Keep the single generated voxel3d entrance from vanishing under the coarse max-height sample.
        if (
          !preserveCaveAperture &&
          hasEntranceOpening &&
          sourceX <= entranceX! &&
          entranceX! < sourceX + cellSpacing &&
          sourceZ <= entranceZ! &&
          entranceZ! < sourceZ + cellSpacing
        )
          highest = entranceColumn;
        if (highest && highestAuthored) highest = { ...highest, value: highestAuthored.value };
        else if (highest && colorSamples)
          highest = {
            ...highest,
            value: { ...highest.value, color: colorTotal.multiplyScalar(1 / colorSamples).getHex() },
          };
        coarseColumns.set(key, highest);
        return highest;
      };
      const cornerHeightAt = (cornerX: number, cornerZ: number) => {
        const key = editColumnKey(cornerX, cornerZ);
        if (cornerHeights.has(key)) return cornerHeights.get(key)!;
        let total = 0;
        let samples = 0;
        for (let zOffset = -1; zOffset <= 0; zOffset++) {
          for (let xOffset = -1; xOffset <= 0; xOffset++) {
            const column = columnAt(cornerX + xOffset, cornerZ + zOffset);
            if (!column) continue;
            total += column.top + 0.5;
            samples++;
          }
        }
        const height = samples ? total / samples : this.world.generator.minY - 0.5;
        cornerHeights.set(key, height);
        return height;
      };
      return { columnAt, cornerHeightAt };
    };
    const { columnAt: farColumnAt, cornerHeightAt: coarseCornerHeightAt } = coarseSampler(
      spacing,
      preserveApertureFanProfile,
    );
    const lowerTier = coarseSampler(lowerTierSpacing);
    const transitionBlendAt = (worldX: number, worldZ: number) => {
      const distanceToEdge = (value: number, minimum: number, maximum: number) =>
        value < minimum ? minimum - value : value > maximum ? value - maximum : 0;
      const distanceX = distanceToEdge(worldX, excludedBounds.minX, excludedBounds.maxX);
      const distanceZ = distanceToEdge(worldZ, excludedBounds.minZ, excludedBounds.maxZ);
      const distance = Math.max(distanceX, distanceZ);
      const linear = Math.min(1, distance / (spacing * 2));
      return linear * linear * (3 - 2 * linear);
    };
    const sharedCornerHeightAt = (cornerX: number, cornerZ: number) => {
      const worldX = cornerX * spacing;
      const worldZ = cornerZ * spacing;
      const blend = transitionBlendAt(worldX, worldZ);
      const coarseHeight = coarseCornerHeightAt(cornerX, cornerZ);
      if (blend === 1) return coarseHeight;
      const detailedHeight = lowerTier.cornerHeightAt(worldX / lowerTierSpacing, worldZ / lowerTierSpacing);
      return detailedHeight + (coarseHeight - detailedHeight) * blend;
    };
    const cornerNormals = new Map<string, SurfaceNormal>();
    const normalAtCorner = (cornerX: number, cornerZ: number): SurfaceNormal => {
      const key = editColumnKey(cornerX, cornerZ);
      const cached = cornerNormals.get(key);
      if (cached) return cached;
      const transitionBlend = transitionBlendAt(cornerX * spacing, cornerZ * spacing);
      const normal = normalizeNormal([
        ((sharedCornerHeightAt(cornerX - 1, cornerZ) - sharedCornerHeightAt(cornerX + 1, cornerZ)) /
          (2 * spacing)) *
          transitionBlend,
        1,
        ((sharedCornerHeightAt(cornerX, cornerZ - 1) - sharedCornerHeightAt(cornerX, cornerZ + 1)) /
          (2 * spacing)) *
          transitionBlend,
      ]);
      cornerNormals.set(key, normal);
      return normal;
    };

    const faces = materials.map((): FaceBuilder => ({ positions: [], normals: [], colors: [], indices: [] }));
    const tileStartX = x * TILE_SIZE;
    const tileStartZ = z * TILE_SIZE;
    const isCoarseCell = (cellX: number, cellZ: number) => {
      const startX = cellX * spacing;
      const startZ = cellZ * spacing;
      return !(
        startX >= excludedBounds.minX &&
        startX + spacing <= excludedBounds.maxX &&
        startZ >= excludedBounds.minZ &&
        startZ + spacing <= excludedBounds.maxZ
      );
    };
    const inset = 0.5 / spacing;
    const lowX = (localX: number) => localX - inset;
    const highX = (localX: number) => localX + 1 - inset;
    const lowZ = (localZ: number) => localZ - inset;
    const highZ = (localZ: number) => localZ + 1 - inset;
    const normalAtPoint = (
      cellX: number,
      cellZ: number,
      localX: number,
      localZ: number,
      point: number[],
    ): SurfaceNormal => {
      const x = point[0] - lowX(localX);
      const z = point[2] - lowZ(localZ);
      const lowerLeft = normalAtCorner(cellX, cellZ);
      const upperLeft = normalAtCorner(cellX, cellZ + 1);
      const upperRight = normalAtCorner(cellX + 1, cellZ + 1);
      const lowerRight = normalAtCorner(cellX + 1, cellZ);
      return normalizeNormal([
        lowerLeft[0] * (1 - x) * (1 - z) +
          upperLeft[0] * (1 - x) * z +
          upperRight[0] * x * z +
          lowerRight[0] * x * (1 - z),
        lowerLeft[1] * (1 - x) * (1 - z) +
          upperLeft[1] * (1 - x) * z +
          upperRight[1] * x * z +
          lowerRight[1] * x * (1 - z),
        lowerLeft[2] * (1 - x) * (1 - z) +
          upperLeft[2] * (1 - x) * z +
          upperRight[2] * x * z +
          lowerRight[2] * x * (1 - z),
      ]);
    };
    const boundarySegments = (
      direction: 'left' | 'right' | 'back' | 'front',
      cellX: number,
      cellZ: number,
      localX: number,
      localZ: number,
      morphToCoarse = false,
    ) => {
      const segmentCount = spacing / lowerTierSpacing;
      const sourceX = cellX * spacing;
      const sourceZ = cellZ * spacing;
      const segments: [number[], number[]][] = [];
      for (let segment = 0; segment < segmentCount; segment++) {
        let startY: number;
        let endY: number;
        if (morphToCoarse) {
          const alongX = direction === 'back' || direction === 'front';
          const firstCornerX = direction === 'right' ? cellX + 1 : cellX;
          const firstCornerZ = direction === 'front' ? cellZ + 1 : cellZ;
          const secondCornerX = firstCornerX + (alongX ? 1 : 0);
          const secondCornerZ = firstCornerZ + (alongX ? 0 : 1);
          const heightAt = (fraction: number) => {
            const worldX =
              sourceX + (direction === 'right' ? spacing : 0) + (alongX ? fraction * spacing : 0);
            const worldZ =
              sourceZ + (direction === 'front' ? spacing : 0) + (alongX ? 0 : fraction * spacing);
            const detailedHeight = lowerTier.cornerHeightAt(
              worldX / lowerTierSpacing,
              worldZ / lowerTierSpacing,
            );
            const coarseStart = coarseCornerHeightAt(firstCornerX, firstCornerZ);
            const coarseEnd = coarseCornerHeightAt(secondCornerX, secondCornerZ);
            const coarseHeight = coarseStart + (coarseEnd - coarseStart) * fraction;
            const blend = transitionBlendAt(worldX, worldZ);
            return detailedHeight + (coarseHeight - detailedHeight) * blend;
          };
          startY = heightAt(segment / segmentCount);
          endY = heightAt((segment + 1) / segmentCount);
        } else if (lowerTierSpacing === 1) {
          const sourceColumn =
            direction === 'left'
              ? this.columnAt(sourceX - 1, sourceZ + segment)
              : direction === 'right'
                ? this.columnAt(sourceX + spacing, sourceZ + segment)
                : direction === 'back'
                  ? this.columnAt(sourceX + segment, sourceZ - 1)
                  : this.columnAt(sourceX + segment, sourceZ + spacing);
          const top = sourceColumn.at(-1)?.end;
          startY = endY = top === undefined ? this.world.generator.minY - 0.5 : top - 0.5;
        } else {
          const cornerX = (sourceX + (direction === 'right' ? spacing : 0)) / lowerTierSpacing;
          const cornerZ = (sourceZ + (direction === 'front' ? spacing : 0)) / lowerTierSpacing;
          const alongX = direction === 'back' || direction === 'front';
          const firstCornerX = cornerX + (alongX ? segment : 0);
          const firstCornerZ = cornerZ + (alongX ? 0 : segment);
          const secondCornerX = firstCornerX + (alongX ? 1 : 0);
          const secondCornerZ = firstCornerZ + (alongX ? 0 : 1);
          startY = lowerTier.cornerHeightAt(firstCornerX, firstCornerZ);
          endY = lowerTier.cornerHeightAt(secondCornerX, secondCornerZ);
        }
        const start = segment / segmentCount;
        const end = (segment + 1) / segmentCount;
        let first: number[];
        let second: number[];
        if (direction === 'left') {
          first = [lowX(localX), startY, lowZ(localZ) + start];
          second = [lowX(localX), endY, lowZ(localZ) + end];
        } else if (direction === 'right') {
          first = [highX(localX), startY, lowZ(localZ) + start];
          second = [highX(localX), endY, lowZ(localZ) + end];
        } else if (direction === 'back') {
          first = [lowX(localX) + start, startY, lowZ(localZ)];
          second = [lowX(localX) + end, endY, lowZ(localZ)];
        } else {
          first = [lowX(localX) + start, startY, highZ(localZ)];
          second = [lowX(localX) + end, endY, highZ(localZ)];
        }
        segments.push([first, second]);
      }
      return direction === 'right' || direction === 'back'
        ? segments.reverse().map(([first, second]) => [second, first] as [number[], number[]])
        : segments;
    };

    for (let localZ = 0; localZ < TILE_SIZE; localZ++) {
      for (let localX = 0; localX < TILE_SIZE; localX++) {
        const cellX = tileStartX + localX;
        const cellZ = tileStartZ + localZ;
        if (!isCoarseCell(cellX, cellZ)) continue;
        const column = farColumnAt(cellX, cellZ);
        if (!column) continue;
        const topY = column.top + 0.5;
        const centerBlend = transitionBlendAt((cellX + 0.5) * spacing, (cellZ + 0.5) * spacing);
        const transitionCell =
          centerBlend < 1 ||
          [
            [cellX, cellZ],
            [cellX, cellZ + 1],
            [cellX + 1, cellZ + 1],
            [cellX + 1, cellZ],
          ].some(([cornerX, cornerZ]) => transitionBlendAt(cornerX * spacing, cornerZ * spacing) < 1);
        let centerHeight = topY;
        if (centerBlend < 1) {
          let lowerHeight = 0;
          let samples = 0;
          const lowerCellX = cellX * (spacing / lowerTierSpacing);
          const lowerCellZ = cellZ * (spacing / lowerTierSpacing);
          for (let offsetZ = 0; offsetZ < spacing / lowerTierSpacing; offsetZ++) {
            for (let offsetX = 0; offsetX < spacing / lowerTierSpacing; offsetX++) {
              const lowerColumn = lowerTier.columnAt(lowerCellX + offsetX, lowerCellZ + offsetZ);
              if (!lowerColumn) continue;
              lowerHeight += lowerColumn.top + 0.5;
              samples++;
            }
          }
          if (samples) {
            const detailedHeight = lowerHeight / samples;
            centerHeight = detailedHeight + (topY - detailedHeight) * centerBlend;
          }
        }
        const surface = (neighbor: ColumnTop | null) =>
          neighbor ? neighbor.top + 0.5 : this.world.generator.minY - 0.5;
        const left = farColumnAt(cellX - 1, cellZ);
        const right = farColumnAt(cellX + 1, cellZ);
        const back = farColumnAt(cellX, cellZ - 1);
        const front = farColumnAt(cellX, cellZ + 1);
        const corners = [
          [lowX(localX), sharedCornerHeightAt(cellX, cellZ), lowZ(localZ)],
          [lowX(localX), sharedCornerHeightAt(cellX, cellZ + 1), highZ(localZ)],
          [highX(localX), sharedCornerHeightAt(cellX + 1, cellZ + 1), highZ(localZ)],
          [highX(localX), sharedCornerHeightAt(cellX + 1, cellZ), lowZ(localZ)],
        ];
        const center = [(lowX(localX) + highX(localX)) / 2, centerHeight, (lowZ(localZ) + highZ(localZ)) / 2];
        const leftLow = sharedCornerHeightAt(cellX, cellZ);
        const leftHigh = sharedCornerHeightAt(cellX, cellZ + 1);
        const leftBase = surface(left);
        const rightLow = sharedCornerHeightAt(cellX + 1, cellZ);
        const rightHigh = sharedCornerHeightAt(cellX + 1, cellZ + 1);
        const rightBase = surface(right);
        const backLow = sharedCornerHeightAt(cellX, cellZ);
        const backHigh = sharedCornerHeightAt(cellX + 1, cellZ);
        const backBase = surface(back);
        const frontLow = sharedCornerHeightAt(cellX, cellZ + 1);
        const frontHigh = sharedCornerHeightAt(cellX + 1, cellZ + 1);
        const frontBase = surface(front);
        const transitionEdges = [
          Boolean(left && !isCoarseCell(cellX - 1, cellZ)),
          Boolean(front && !isCoarseCell(cellX, cellZ + 1)),
          Boolean(right && !isCoarseCell(cellX + 1, cellZ)),
          Boolean(back && !isCoarseCell(cellX, cellZ - 1)),
        ];
        const edges = [
          transitionEdges[0]
            ? boundarySegments('left', cellX, cellZ, localX, localZ)
            : transitionCell
              ? boundarySegments('left', cellX, cellZ, localX, localZ, true)
              : [[corners[0], corners[1]]],
          transitionEdges[1]
            ? boundarySegments('front', cellX, cellZ, localX, localZ)
            : transitionCell
              ? boundarySegments('front', cellX, cellZ, localX, localZ, true)
              : [[corners[1], corners[2]]],
          transitionEdges[2]
            ? boundarySegments('right', cellX, cellZ, localX, localZ)
            : transitionCell
              ? boundarySegments('right', cellX, cellZ, localX, localZ, true)
              : [[corners[2], corners[3]]],
          transitionEdges[3]
            ? boundarySegments('back', cellX, cellZ, localX, localZ)
            : transitionCell
              ? boundarySegments('back', cellX, cellZ, localX, localZ, true)
              : [[corners[3], corners[0]]],
        ];
        const perimeter: number[][] = [];
        const samePoint = (first: number[], second: number[]) =>
          first.every((coordinate, index) => Math.abs(coordinate - second[index]) <= 1e-8);
        for (const edge of edges) {
          for (const [start, end] of edge) {
            if (!perimeter.length) perimeter.push(start);
            else if (!samePoint(perimeter.at(-1)!, start)) perimeter.push(start);
            perimeter.push(end);
          }
        }
        if (perimeter.length && !samePoint(perimeter.at(-1)!, perimeter[0])) perimeter.push(perimeter[0]);
        const sourceStartX = cellX * spacing;
        const sourceStartZ = cellZ * spacing;
        const openings = apertureOpenings.get(editColumnKey(cellX, cellZ)) ?? new Map<string, ColumnTop>();

        if (!openings.size) {
          for (let point = 0; point + 1 < perimeter.length; point++) {
            const triangle = [center, perimeter[point], perimeter[point + 1]];
            const normals = triangle.map((vertex) => normalAtPoint(cellX, cellZ, localX, localZ, vertex));
            this.emitTriangle(faces, column.value, triangle, normals, spacing);
          }
        } else {
          const fanHeightAt = (x: number, z: number) => {
            for (let point = 0; point + 1 < perimeter.length; point++) {
              const [a, b, c] = [center, perimeter[point], perimeter[point + 1]];
              const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
              if (Math.abs(denominator) < 1e-10) continue;
              const weightA = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
              const weightB = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
              const weightC = 1 - weightA - weightB;
              if (weightA >= -1e-7 && weightB >= -1e-7 && weightC >= -1e-7)
                return a[1] * weightA + b[1] * weightB + c[1] * weightC;
            }
            return center[1];
          };
          const pointAt = (offsetX: number, offsetZ: number) => {
            const x = lowX(localX) + offsetX / spacing;
            const z = lowZ(localZ) + offsetZ / spacing;
            return [x, fanHeightAt(x, z), z];
          };
          for (let offsetZ = 0; offsetZ < spacing; offsetZ++) {
            for (let offsetX = 0; offsetX < spacing; offsetX++) {
              const p00 = pointAt(offsetX, offsetZ);
              const p01 = pointAt(offsetX, offsetZ + 1);
              const p11 = pointAt(offsetX + 1, offsetZ + 1);
              const p10 = pointAt(offsetX + 1, offsetZ);
              const sourceX = sourceStartX + offsetX;
              const sourceZ = sourceStartZ + offsetZ;
              const floor = openings.get(editColumnKey(sourceX, sourceZ));
              if (!floor) {
                for (const triangle of [
                  [p00, p01, p11],
                  [p00, p11, p10],
                ]) {
                  const normals = triangle.map((vertex) =>
                    normalAtPoint(cellX, cellZ, localX, localZ, vertex),
                  );
                  this.emitTriangle(faces, column.value, triangle, normals, spacing);
                }
                continue;
              }

              const floorY = floor.top + 0.5;
              const floorPoint = (x: number, z: number) => [x, floorY, z];
              this.emit(
                faces,
                floor.value,
                [
                  floorPoint(p00[0], p00[2]),
                  floorPoint(p01[0], p01[2]),
                  floorPoint(p11[0], p11[2]),
                  floorPoint(p10[0], p10[2]),
                ],
                [0, 1, 0],
              );

              const neighbors = [
                { dx: -1, dz: 0, direction: 'left' as const, edge: [p00, p01] as [number[], number[]] },
                { dx: 1, dz: 0, direction: 'right' as const, edge: [p10, p11] as [number[], number[]] },
                { dx: 0, dz: -1, direction: 'back' as const, edge: [p00, p10] as [number[], number[]] },
                { dx: 0, dz: 1, direction: 'front' as const, edge: [p01, p11] as [number[], number[]] },
              ];
              for (const neighbor of neighbors) {
                const neighborX = sourceX + neighbor.dx;
                const neighborZ = sourceZ + neighbor.dz;
                const neighborKey = editColumnKey(neighborX, neighborZ);
                const neighborFloor =
                  openings.get(neighborKey) ??
                  (this.caveOpeningAt(neighborX, neighborZ)
                    ? (this.columnTopAt(neighborX, neighborZ) ?? undefined)
                    : undefined);
                const edgeLow = neighbor.edge[0];
                const edgeHigh = neighbor.edge[1];
                if (neighborFloor) {
                  const otherFloorY = neighborFloor.top + 0.5;
                  // The lower column owns a shared step wall, including across a tile seam.
                  if (floorY < otherFloorY - 1e-8)
                    this.emitApertureWall(
                      faces,
                      floor.value,
                      neighbor.direction,
                      edgeLow[0],
                      edgeHigh[0],
                      edgeLow[2],
                      edgeHigh[2],
                      floorY,
                      floorY,
                      otherFloorY,
                      otherFloorY,
                      true,
                    );
                  continue;
                }
                this.emitApertureWall(
                  faces,
                  floor.value,
                  neighbor.direction,
                  edgeLow[0],
                  edgeHigh[0],
                  edgeLow[2],
                  edgeHigh[2],
                  floorY,
                  floorY,
                  edgeLow[1],
                  edgeHigh[1],
                  true,
                );
              }
            }
          }
        }

        if (!left && Math.max(leftLow, leftHigh) > leftBase)
          this.emitCoarseSide(
            faces,
            column.value,
            'left',
            localX,
            localZ,
            inset,
            1 - inset,
            leftBase,
            Math.max(leftLow, leftBase),
            Math.max(leftHigh, leftBase),
          );
        if (!right && Math.max(rightLow, rightHigh) > rightBase)
          this.emitCoarseSide(
            faces,
            column.value,
            'right',
            localX,
            localZ,
            inset,
            1 - inset,
            rightBase,
            Math.max(rightLow, rightBase),
            Math.max(rightHigh, rightBase),
          );
        if (!back && Math.max(backLow, backHigh) > backBase)
          this.emitCoarseSide(
            faces,
            column.value,
            'back',
            localX,
            localZ,
            inset,
            1 - inset,
            backBase,
            Math.max(backLow, backBase),
            Math.max(backHigh, backBase),
          );
        if (!front && Math.max(frontLow, frontHigh) > frontBase)
          this.emitCoarseSide(
            faces,
            column.value,
            'front',
            localX,
            localZ,
            inset,
            1 - inset,
            frontBase,
            Math.max(frontLow, frontBase),
            Math.max(frontHigh, frontBase),
          );
      }
    }
    if (caveNetworkPath) {
      this.emitCoarseCaveNetworkTunnel(faces, caveNetworkPath, spacing, x, z, excludedBounds);
      this.emitCoarseCaveNetworkBranches(
        faces,
        caveNetworkPath,
        caveNetworkBranches,
        spacing,
        x,
        z,
        excludedBounds,
      );
      this.emitCoarseCaveNetworkConnectors(
        faces,
        caveNetworkConnectors,
        caveNetworkPath.axis,
        spacing,
        x,
        z,
        excludedBounds,
      );
    }
    this.emitCoarseCaveFieldShafts(
      faces,
      generatedEntrances,
      caveNetworkConnectors,
      spacing,
      x,
      z,
      excludedBounds,
    );
    if (preserveCaveAperture)
      this.emitCoarseCaveVolume(
        faces,
        generatedEntrances,
        spacing,
        x,
        z,
        excludedBounds,
        Boolean(caveNetworkPath),
      );
    if (
      generator.mode === 'voxel3d' &&
      this.volumeAt &&
      (generator.overhangHeightMap || (generator.overhangDensity ?? 0) > 0)
    )
      this.emitCoarseOverhangWalls(faces, spacing, x, z, excludedBounds);
    return this.geometryFromFaces(faces);
  }

  private emitCoarseOverhangWalls(
    faces: FaceBuilder[],
    spacing: number,
    tileX: number,
    tileZ: number,
    excludedBounds: TileBounds,
  ) {
    const { generator } = this.world;
    if (!this.volumeAt) return;
    const [originX, originZ] = generator.origin;
    const [worldWidth, worldDepth] = generator.size;
    const maximumHeight = Math.max(
      1,
      Math.min(
        TERRAIN_OVERHANG_HEIGHT_LIMIT,
        Math.floor(generator.overhangMaxHeight ?? TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT),
      ),
    );
    const tileStartX = tileX * TILE_SIZE;
    const tileStartZ = tileZ * TILE_SIZE;
    const sourceOffset = Math.floor((spacing - 1) / 2);
    type OverhangColumn = { surface: number; top: number };
    const columns = new Map<string, OverhangColumn | null>();
    const columnAt = (localX: number, localZ: number) => {
      const key = `${localX},${localZ}`;
      if (columns.has(key)) return columns.get(key)!;
      const sourceX = (tileStartX + localX) * spacing + sourceOffset;
      const sourceZ = (tileStartZ + localZ) * spacing + sourceOffset;
      if (
        sourceX < originX ||
        sourceX >= originX + worldWidth ||
        sourceZ < originZ ||
        sourceZ >= originZ + worldDepth
      ) {
        columns.set(key, null);
        return null;
      }
      const surface = this.surfaceAt(sourceX, sourceZ);
      let top = surface;
      for (let y = surface + 1; y <= Math.min(generator.maxY, surface + maximumHeight); y++) {
        if (!this.volumeAt!(sourceX, y, sourceZ)) break;
        top = y;
      }
      const result = { surface, top };
      columns.set(key, result);
      return result;
    };
    const excluded = (x: number, z: number) =>
      x >= excludedBounds.minX &&
      x < excludedBounds.maxX &&
      z >= excludedBounds.minZ &&
      z < excludedBounds.maxZ;
    const value = { color: generator.palette.subsurface, materialType: generator.palette.materialType };
    let wallCount = 0;
    const emitWall = (
      first: OverhangColumn | null,
      second: OverhangColumn | null,
      axis: 'x' | 'z',
      localX: number,
      localZ: number,
      edgeX: number,
      edgeZ: number,
    ) => {
      if (!first || !second || wallCount >= MAXIMUM_COARSE_OVERHANG_WALLS_PER_TILE || excluded(edgeX, edgeZ))
        return;
      const high = first.top > second.top ? first : second;
      const low = high === first ? second : first;
      if (high.top <= high.surface) return;
      const bottom = Math.max(high.surface, low.top) + 0.5;
      const top = high.top + 0.5;
      if (top <= bottom) return;
      const side = high === first ? 1 : -1;
      const points =
        axis === 'x'
          ? [
              [localX + 1, bottom, localZ],
              [localX + 1, top, localZ],
              [localX + 1, top, localZ + 1],
              [localX + 1, bottom, localZ + 1],
            ]
          : [
              [localX, bottom, localZ + 1],
              [localX + 1, bottom, localZ + 1],
              [localX + 1, top, localZ + 1],
              [localX, top, localZ + 1],
            ];
      const orientedPoints = side < 0 ? [points[0], points[3], points[2], points[1]] : points;
      this.emit(faces, value, orientedPoints, axis === 'x' ? [side, 0, 0] : [0, 0, side]);
      wallCount++;
    };

    for (let localZ = 0; localZ < TILE_SIZE; localZ++)
      for (let localX = 0; localX < TILE_SIZE; localX++) {
        const current = columnAt(localX, localZ);
        const centerX = (tileStartX + localX) * spacing + sourceOffset;
        const centerZ = (tileStartZ + localZ) * spacing + sourceOffset;
        emitWall(current, columnAt(localX + 1, localZ), 'x', localX, localZ, centerX + spacing / 2, centerZ);
        emitWall(current, columnAt(localX, localZ + 1), 'z', localX, localZ, centerX, centerZ + spacing / 2);
      }
  }

  private emitCoarseCaveNetworkTunnel(
    faces: FaceBuilder[],
    path: NonNullable<ReturnType<typeof createTerrainCaveNetworkPath>>,
    spacing: number,
    tileX: number,
    tileZ: number,
    excludedBounds: TileBounds,
  ) {
    const { generator } = this.world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    const alongOrigin = path.axis === 'x' ? originX : originZ;
    const alongEnd = alongOrigin + (path.axis === 'x' ? width : depth) - 1;
    const tileWidth = TILE_SIZE * spacing;
    const alongTile = path.axis === 'x' ? tileX : tileZ;
    const crossTile = path.axis === 'x' ? tileZ : tileX;
    const tileStart = alongTile * tileWidth;
    const start = Math.max(tileStart, alongOrigin);
    const end = Math.min(tileStart + tileWidth, alongEnd);
    if (end <= start) return;

    const samples = [start];
    for (let along = start + spacing; along < end; along += spacing) samples.push(along);
    samples.push(end);

    const palette = generator.palette;
    const wall = { color: palette.deep, materialType: palette.materialType };
    const localTileX = tileX * TILE_SIZE;
    const localTileZ = tileZ * TILE_SIZE;
    const sides = COARSE_CAVE_NETWORK_TUNNEL_SIDES;
    const lateralScale = spacing / TERRAIN_CAVE_NETWORK_LATERAL_RADIUS;
    const verticalScale = 1 / TERRAIN_CAVE_NETWORK_VERTICAL_RADIUS;

    for (let segment = 0; segment + 1 < samples.length; segment++) {
      const firstAlong = samples[segment];
      const secondAlong = samples[segment + 1];
      const midpoint = path.at((firstAlong + secondAlong) / 2);
      const midpointCross = path.axis === 'x' ? midpoint.z : midpoint.x;
      if (Math.floor(midpointCross / tileWidth) !== crossTile) continue;
      const midpointX = path.axis === 'x' ? (firstAlong + secondAlong) / 2 : midpointCross;
      const midpointZ = path.axis === 'x' ? midpointCross : (firstAlong + secondAlong) / 2;
      if (
        midpointX >= excludedBounds.minX &&
        midpointX < excludedBounds.maxX &&
        midpointZ >= excludedBounds.minZ &&
        midpointZ < excludedBounds.maxZ
      )
        continue;

      const first = path.at(firstAlong);
      const second = path.at(secondAlong);
      for (let side = 0; side < sides; side++) {
        const angle = (side / sides) * Math.PI * 2;
        const nextAngle = ((side + 1) / sides) * Math.PI * 2;
        const middleAngle = (angle + nextAngle) / 2;
        const ringPoint = (point: { x: number; y: number; z: number }, along: number, theta: number) => {
          const lateral = (Math.cos(theta) * TERRAIN_CAVE_NETWORK_LATERAL_RADIUS) / spacing;
          const y = point.y + Math.sin(theta) * TERRAIN_CAVE_NETWORK_VERTICAL_RADIUS;
          return path.axis === 'x'
            ? [along / spacing - localTileX, y, point.z / spacing - localTileZ + lateral]
            : [point.x / spacing - localTileX + lateral, y, along / spacing - localTileZ];
        };
        const firstAtAngle = ringPoint(first, firstAlong, angle);
        const firstAtNextAngle = ringPoint(first, firstAlong, nextAngle);
        const secondAtAngle = ringPoint(second, secondAlong, angle);
        const secondAtNextAngle = ringPoint(second, secondAlong, nextAngle);
        const points =
          path.axis === 'x'
            ? [firstAtAngle, firstAtNextAngle, secondAtNextAngle, secondAtAngle]
            : [firstAtAngle, secondAtAngle, secondAtNextAngle, firstAtNextAngle];
        const lateralNormal = -Math.cos(middleAngle) * lateralScale;
        const verticalNormal = -Math.sin(middleAngle) * verticalScale;
        const magnitude = Math.hypot(lateralNormal, verticalNormal);
        const normal: [number, number, number] =
          path.axis === 'x'
            ? [0, verticalNormal / magnitude, lateralNormal / magnitude]
            : [lateralNormal / magnitude, verticalNormal / magnitude, 0];
        this.emit(faces, wall, points, normal);
      }
    }
  }

  private emitCoarseCaveNetworkBranches(
    faces: FaceBuilder[],
    path: NonNullable<ReturnType<typeof createTerrainCaveNetworkPath>>,
    branches: ReturnType<typeof terrainCaveNetworkBranches>,
    spacing: number,
    tileX: number,
    tileZ: number,
    excludedBounds: TileBounds,
  ) {
    const tileWidth = TILE_SIZE * spacing;
    const primaryTile = path.axis === 'x' ? tileX : tileZ;
    const crossTile = path.axis === 'x' ? tileZ : tileX;
    const crossTileStart = crossTile * tileWidth;
    const localTileX = tileX * TILE_SIZE;
    const localTileZ = tileZ * TILE_SIZE;
    const radius = TERRAIN_CAVE_NETWORK_BRANCH_RADIUS;
    const palette = this.world.generator.palette;
    const wall = { color: palette.deep, materialType: palette.materialType };
    const horizontalNormalScale = spacing / radius;
    const verticalNormalScale = 1 / radius;

    for (const branch of branches) {
      if (Math.floor(branch.along / tileWidth) !== primaryTile) continue;
      const center = path.at(branch.along);
      const centerCross = path.axis === 'x' ? center.z : center.x;
      const branchMin = branch.direction > 0 ? centerCross - 2 : centerCross - branch.length;
      const branchMax = branch.direction > 0 ? centerCross + branch.length : centerCross + 2;
      const start = Math.max(branchMin, crossTileStart);
      const end = Math.min(branchMax, crossTileStart + tileWidth);
      if (end <= start) continue;

      const samples = [start];
      for (let cross = start + spacing; cross < end; cross += spacing) samples.push(cross);
      samples.push(end);
      const ringPoint = (cross: number, theta: number) => {
        const lateral = (Math.cos(theta) * radius) / spacing;
        const y = center.y + Math.sin(theta) * radius;
        return path.axis === 'x'
          ? [branch.along / spacing - localTileX + lateral, y, cross / spacing - localTileZ]
          : [cross / spacing - localTileX, y, branch.along / spacing - localTileZ + lateral];
      };
      for (let segment = 0; segment + 1 < samples.length; segment++) {
        const firstCross = samples[segment];
        const secondCross = samples[segment + 1];
        const midpointCross = (firstCross + secondCross) / 2;
        const midpointX = path.axis === 'x' ? branch.along : midpointCross;
        const midpointZ = path.axis === 'x' ? midpointCross : branch.along;
        if (
          midpointX >= excludedBounds.minX &&
          midpointX < excludedBounds.maxX &&
          midpointZ >= excludedBounds.minZ &&
          midpointZ < excludedBounds.maxZ
        )
          continue;

        for (let side = 0; side < COARSE_CAVE_NETWORK_TUNNEL_SIDES; side++) {
          const angle = (side / COARSE_CAVE_NETWORK_TUNNEL_SIDES) * Math.PI * 2;
          const nextAngle = ((side + 1) / COARSE_CAVE_NETWORK_TUNNEL_SIDES) * Math.PI * 2;
          const middleAngle = (angle + nextAngle) / 2;
          const firstAtAngle = ringPoint(firstCross, angle);
          const firstAtNextAngle = ringPoint(firstCross, nextAngle);
          const secondAtAngle = ringPoint(secondCross, angle);
          const secondAtNextAngle = ringPoint(secondCross, nextAngle);
          const points =
            path.axis === 'x'
              ? [firstAtAngle, secondAtAngle, secondAtNextAngle, firstAtNextAngle]
              : [firstAtAngle, firstAtNextAngle, secondAtNextAngle, secondAtAngle];
          const lateralNormal = -Math.cos(middleAngle) * horizontalNormalScale;
          const verticalNormal = -Math.sin(middleAngle) * verticalNormalScale;
          const magnitude = Math.hypot(lateralNormal, verticalNormal);
          const normal: [number, number, number] =
            path.axis === 'x'
              ? [lateralNormal / magnitude, verticalNormal / magnitude, 0]
              : [0, verticalNormal / magnitude, lateralNormal / magnitude];
          this.emit(faces, wall, points, normal);
        }
      }

      const endpoint = branch.direction > 0 ? branchMax : branchMin;
      if (
        Math.floor(endpoint / tileWidth) !== crossTile ||
        (path.axis === 'x'
          ? branch.along >= excludedBounds.minX &&
            branch.along < excludedBounds.maxX &&
            endpoint >= excludedBounds.minZ &&
            endpoint < excludedBounds.maxZ
          : endpoint >= excludedBounds.minX &&
            endpoint < excludedBounds.maxX &&
            branch.along >= excludedBounds.minZ &&
            branch.along < excludedBounds.maxZ)
      )
        continue;
      const centerPoint =
        path.axis === 'x'
          ? [branch.along / spacing - localTileX, center.y, endpoint / spacing - localTileZ]
          : [endpoint / spacing - localTileX, center.y, branch.along / spacing - localTileZ];
      const reverse = path.axis === 'x' ? branch.direction > 0 : branch.direction < 0;
      for (let side = 0; side < COARSE_CAVE_NETWORK_TUNNEL_SIDES; side++) {
        const angle = (side / COARSE_CAVE_NETWORK_TUNNEL_SIDES) * Math.PI * 2;
        const nextAngle = ((side + 1) / COARSE_CAVE_NETWORK_TUNNEL_SIDES) * Math.PI * 2;
        const first = ringPoint(endpoint, angle);
        const second = ringPoint(endpoint, nextAngle);
        this.emitTriangle(
          faces,
          wall,
          reverse ? [centerPoint, second, first] : [centerPoint, first, second],
          undefined,
          spacing,
        );
      }
    }
  }

  private emitCoarseCaveNetworkConnectors(
    faces: FaceBuilder[],
    connectors: TerrainCaveNetworkConnector[],
    axis: 'x' | 'z',
    spacing: number,
    tileX: number,
    tileZ: number,
    excludedBounds: TileBounds,
  ) {
    const tileWidth = TILE_SIZE * spacing;
    const localTileX = tileX * TILE_SIZE;
    const localTileZ = tileZ * TILE_SIZE;
    const crossTileStart = (axis === 'x' ? tileZ : tileX) * tileWidth;
    const crossTileEnd = crossTileStart + tileWidth;
    const palette = this.world.generator.palette;
    const wall = { color: palette.deep, materialType: palette.materialType };
    const excluded = (point: [number, number, number]) =>
      point[0] >= excludedBounds.minX &&
      point[0] < excludedBounds.maxX &&
      point[2] >= excludedBounds.minZ &&
      point[2] < excludedBounds.maxZ;

    for (const connector of connectors) {
      const mouth = connector.shaft[0];
      if (Math.floor(mouth[0] / tileWidth) === tileX && Math.floor(mouth[2] / tileWidth) === tileZ) {
        const midpoint: [number, number, number] = [
          mouth[0],
          (connector.shaft[0][1] + connector.shaft[1][1]) / 2,
          mouth[2],
        ];
        if (!excluded(midpoint))
          this.emitCoarseConnectorTube(
            faces,
            wall,
            connector.shaft[0],
            connector.shaft[1],
            'y',
            spacing,
            localTileX,
            localTileZ,
          );
      }

      const startCross = axis === 'x' ? connector.tunnel[0][2] : connector.tunnel[0][0];
      const endCross = axis === 'x' ? connector.tunnel[1][2] : connector.tunnel[1][0];
      const clippedLow = Math.max(Math.min(startCross, endCross), crossTileStart);
      const clippedHigh = Math.min(Math.max(startCross, endCross), crossTileEnd);
      if (clippedHigh <= clippedLow || startCross === endCross) continue;
      const pointAtCross = (cross: number): [number, number, number] => {
        const amount = (cross - startCross) / (endCross - startCross);
        return connector.tunnel[0].map(
          (start, index) => start + (connector.tunnel[1][index] - start) * amount,
        ) as [number, number, number];
      };
      const start = pointAtCross(startCross < endCross ? clippedLow : clippedHigh);
      const end = pointAtCross(startCross < endCross ? clippedHigh : clippedLow);
      const midpoint: [number, number, number] = [
        (start[0] + end[0]) / 2,
        (start[1] + end[1]) / 2,
        (start[2] + end[2]) / 2,
      ];
      if (!excluded(midpoint))
        this.emitCoarseConnectorTube(
          faces,
          wall,
          start,
          end,
          axis === 'x' ? 'z' : 'x',
          spacing,
          localTileX,
          localTileZ,
        );
    }
  }

  private emitCoarseConnectorTube(
    faces: FaceBuilder[],
    wall: WorldCell,
    start: [number, number, number],
    end: [number, number, number],
    tubeAxis: 'x' | 'y' | 'z',
    spacing: number,
    localTileX: number,
    localTileZ: number,
  ) {
    const radius = COARSE_CAVE_NETWORK_CONNECTOR_MESH_RADIUS;
    const ringPoint = (point: [number, number, number], angle: number) => {
      const horizontal = Math.cos(angle) * radius;
      const vertical = Math.sin(angle) * radius;
      if (tubeAxis === 'y')
        return [
          (point[0] + horizontal) / spacing - localTileX,
          point[1],
          (point[2] + vertical) / spacing - localTileZ,
        ];
      if (tubeAxis === 'x')
        return [
          point[0] / spacing - localTileX,
          point[1] + vertical,
          (point[2] + horizontal) / spacing - localTileZ,
        ];
      return [
        (point[0] + horizontal) / spacing - localTileX,
        point[1] + vertical,
        point[2] / spacing - localTileZ,
      ];
    };
    const axisDelta =
      tubeAxis === 'x' ? end[0] - start[0] : tubeAxis === 'y' ? end[1] - start[1] : end[2] - start[2];
    if (axisDelta === 0) return;
    const reverse = axisDelta < 0;
    const sides = COARSE_CAVE_NETWORK_TUNNEL_SIDES;
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const nextAngle = ((side + 1) / sides) * Math.PI * 2;
      const middleAngle = (angle + nextAngle) / 2;
      const firstAtAngle = ringPoint(start, angle);
      const firstAtNextAngle = ringPoint(start, nextAngle);
      const secondAtAngle = ringPoint(end, angle);
      const secondAtNextAngle = ringPoint(end, nextAngle);
      const quad =
        tubeAxis === 'z'
          ? [firstAtAngle, secondAtAngle, secondAtNextAngle, firstAtNextAngle]
          : [firstAtAngle, firstAtNextAngle, secondAtNextAngle, secondAtAngle];
      const points = reverse ? [quad[0], quad[3], quad[2], quad[1]] : quad;
      const inward: [number, number, number] =
        tubeAxis === 'y'
          ? [(-Math.cos(middleAngle) * spacing) / radius, 0, (-Math.sin(middleAngle) * spacing) / radius]
          : tubeAxis === 'x'
            ? [0, -Math.sin(middleAngle) / radius, (-Math.cos(middleAngle) * spacing) / radius]
            : [(-Math.cos(middleAngle) * spacing) / radius, -Math.sin(middleAngle) / radius, 0];
      this.emit(faces, wall, points, normalizeNormal(inward));
    }
  }

  private emitCoarseCaveFieldShafts(
    faces: FaceBuilder[],
    entrances: ReturnType<typeof terrainCaveEntrancesIn>,
    connected: TerrainCaveNetworkConnector[],
    spacing: number,
    tileX: number,
    tileZ: number,
    excludedBounds: TileBounds,
  ) {
    const { generator } = this.world;
    if ((generator.caveDensity ?? 0) <= 0 || !this.volumeAt) return;
    const tileWidth = TILE_SIZE * spacing;
    const localTileX = tileX * TILE_SIZE;
    const localTileZ = tileZ * TILE_SIZE;
    const connectedMouths = new Set(connected.map(({ shaft }) => `${shaft[0][0]},${shaft[0][2]}`));
    const wall = { color: generator.palette.deep, materialType: generator.palette.materialType };
    let emitted = 0;
    for (const entrance of entrances) {
      if (emitted >= MAXIMUM_COARSE_CAVE_FIELD_SHAFTS_PER_TILE) break;
      if (
        Math.floor(entrance.x / tileWidth) !== tileX ||
        Math.floor(entrance.z / tileWidth) !== tileZ ||
        connectedMouths.has(`${entrance.x},${entrance.z}`) ||
        (entrance.x >= excludedBounds.minX &&
          entrance.x < excludedBounds.maxX &&
          entrance.z >= excludedBounds.minZ &&
          entrance.z < excludedBounds.maxZ)
      )
        continue;

      const surface = this.surfaceAt(entrance.x, entrance.z);
      const top = surface - 3;
      const maximumDepth = Math.min(MAXIMUM_COARSE_CAVE_FIELD_SHAFT_DEPTH, top - generator.minY - 1);
      let bottom = top;
      let depth = 0;
      let endedAtSolid = false;
      for (; depth < maximumDepth; depth++) {
        const y = top - depth;
        if (!this.volumeAt(entrance.x, y, entrance.z)) bottom = y;
        else {
          endedAtSolid = true;
          break;
        }
      }
      if (depth < MINIMUM_COARSE_CAVE_FIELD_SHAFT_DEPTH) continue;
      this.emitCoarseConnectorTube(
        faces,
        wall,
        [entrance.x, surface + 0.5, entrance.z],
        [entrance.x, bottom - 0.5, entrance.z],
        'y',
        spacing,
        localTileX,
        localTileZ,
      );
      if (endedAtSolid) {
        let sideExit = false;
        for (let offsetZ = -1; offsetZ <= 1 && !sideExit; offsetZ++)
          for (let offsetX = -1; offsetX <= 1 && !sideExit; offsetX++) {
            if (!offsetX && !offsetZ) continue;
            const x = entrance.x + offsetX;
            const z = entrance.z + offsetZ;
            if (
              x < generator.origin[0] ||
              x >= generator.origin[0] + generator.size[0] ||
              z < generator.origin[1] ||
              z >= generator.origin[1] + generator.size[1]
            )
              continue;
            sideExit = !this.volumeAt(x, bottom, z);
          }
        if (!sideExit) {
          const center: number[] = [
            entrance.x / spacing - localTileX,
            bottom - 0.5,
            entrance.z / spacing - localTileZ,
          ];
          for (let side = 0; side < COARSE_CAVE_NETWORK_TUNNEL_SIDES; side++) {
            const angle = (side / COARSE_CAVE_NETWORK_TUNNEL_SIDES) * Math.PI * 2;
            const nextAngle = ((side + 1) / COARSE_CAVE_NETWORK_TUNNEL_SIDES) * Math.PI * 2;
            const pointAt = (theta: number) => [
              (entrance.x + Math.cos(theta) * COARSE_CAVE_NETWORK_CONNECTOR_MESH_RADIUS) / spacing -
                localTileX,
              bottom - 0.5,
              (entrance.z + Math.sin(theta) * COARSE_CAVE_NETWORK_CONNECTOR_MESH_RADIUS) / spacing -
                localTileZ,
            ];
            this.emitTriangle(faces, wall, [center, pointAt(nextAngle), pointAt(angle)]);
          }
        }
      }
      emitted++;
    }
  }

  private emitCoarseCaveVolume(
    faces: FaceBuilder[],
    entrances: ReturnType<typeof terrainCaveEntrancesIn>,
    spacing: number,
    tileX: number,
    tileZ: number,
    excludedBounds: TileBounds,
    hasExplicitCaveNetwork: boolean,
  ) {
    const { generator } = this.world;
    const [originX, originZ] = generator.origin;
    const [worldWidth, worldDepth] = generator.size;
    const worldHeight = generator.maxY - generator.minY + 1;
    if (generator.mode !== 'voxel3d' || !this.volumeAt || worldHeight <= 0) return;

    const minimumVerticalStep = Math.ceil(worldHeight / MAXIMUM_COARSE_CAVE_VOLUME_SAMPLE_LAYERS);
    // Keep horizon height detail finer than its horizontal spacing without exceeding the layer cap.
    const verticalStep = spacing >= 16 ? minimumVerticalStep : Math.max(spacing, minimumVerticalStep);
    const verticalLayers = Math.ceil(worldHeight / verticalStep);
    const gridWidth = TILE_SIZE + 2;
    const gridDepth = TILE_SIZE + 2;
    const occupancy = new Uint8Array(verticalLayers * gridDepth * gridWidth);
    const refinedCells = new Uint8Array(occupancy.length);
    const occupancyIndex = (layer: number, z: number, x: number) => (layer * gridDepth + z) * gridWidth + x;
    const sourceOffset = Math.floor((spacing - 1) / 2);
    const quarterOffset = Math.floor((spacing - 1) / 4);
    const threeQuarterOffset = Math.floor((3 * (spacing - 1)) / 4);
    const tileStartX = tileX * TILE_SIZE;
    const tileStartZ = tileZ * TILE_SIZE;
    const editedProbeBounds = {
      minX: (tileStartX - 1) * spacing,
      maxX: (tileStartX + TILE_SIZE + 1) * spacing,
      minZ: (tileStartZ - 1) * spacing,
      maxZ: (tileStartZ + TILE_SIZE + 1) * spacing,
    };
    const hasEditedOverrides = spacing >= 16 && this.hasEditedOverridesIn(editedProbeBounds);
    const editedCaveSamples = hasEditedOverrides
      ? this.editedCaveSamplesIn(editedProbeBounds, spacing, generator.minY, verticalStep)
      : [];
    const refineHorizonCaveFaces =
      spacing >= 16 && ((generator.caveDensity ?? 0) > 0 || editedCaveSamples.length > 0);
    const hasProceduralOverhang =
      Boolean(generator.overhangHeightMap) || (generator.overhangDensity ?? 0) > 0;
    const authoredMaximumOverhangHeight = Math.max(
      1,
      Math.min(
        TERRAIN_OVERHANG_HEIGHT_LIMIT,
        Math.floor(generator.overhangMaxHeight ?? TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT),
      ),
    );
    // Procedural columns cannot exceed their authored cap; sparse edits may extend farther.
    const maximumOverhangHeight = hasEditedOverrides
      ? TERRAIN_OVERHANG_HEIGHT_LIMIT
      : authoredMaximumOverhangHeight;
    // Skip 25-point probes on horizon tiles where neither the generator nor edits can add overhangs.
    const refineHorizonUndercuts = spacing >= 16 && (hasProceduralOverhang || hasEditedOverrides);
    const undercutCoordinates = [0, quarterOffset, sourceOffset, threeQuarterOffset, spacing - 1];
    const undercutOffsets: [number, number][] = refineHorizonUndercuts
      ? undercutCoordinates.flatMap((offsetZ) =>
          undercutCoordinates.map((offsetX) => [offsetX, offsetZ] as [number, number]),
        )
      : [];
    const editedUndercutOffsetsByCell = new Map<string, [number, number][]>();
    if (refineHorizonUndercuts && hasEditedOverrides) {
      const sampledOffsets = new Set(undercutOffsets.map(([offsetX, offsetZ]) => `${offsetX},${offsetZ}`));
      for (const { x: sourceX, z: sourceZ } of this.editedOverrideColumnsIn(editedProbeBounds)) {
        const cellX = Math.floor(sourceX / spacing);
        const cellZ = Math.floor(sourceZ / spacing);
        const offsetX = sourceX - cellX * spacing;
        const offsetZ = sourceZ - cellZ * spacing;
        if (sampledOffsets.has(`${offsetX},${offsetZ}`)) continue;
        const key = editColumnKey(cellX, cellZ);
        let offsets = editedUndercutOffsetsByCell.get(key);
        if (!offsets) editedUndercutOffsetsByCell.set(key, (offsets = []));
        offsets.push([offsetX, offsetZ]);
      }
    }
    const sampleCenter = (cell: number) => cell * spacing + sourceOffset;
    // Vertical slabs revisit the same center and edge columns; keep this cache tile-local.
    const sampledSurfaces = new Map<number, number>();
    const surfaceAt = (x: number, z: number) => {
      const key = (z - originZ) * worldWidth + (x - originX);
      const cached = sampledSurfaces.get(key);
      if (cached !== undefined) return cached;
      const surface = this.surfaceAt(x, z);
      sampledSurfaces.set(key, surface);
      return surface;
    };
    const entranceCells = new Set<string>();
    const addEntranceCells = (entrance: { x: number; z: number }) => {
      for (let z = entrance.z - 1; z <= entrance.z + 1; z++)
        for (let x = entrance.x - 1; x <= entrance.x + 1; x++)
          entranceCells.add(`${Math.floor(x / spacing)},${Math.floor(z / spacing)}`);
    };
    addEntranceCells(terrainCaveEntrance(this.world));
    for (const entrance of entrances) addEntranceCells(entrance);
    const isOpenCaveSample = (sampleX: number, sampleY: number, sampleZ: number) => {
      if (
        sampleX < originX ||
        sampleX >= originX + worldWidth ||
        sampleZ < originZ ||
        sampleZ >= originZ + worldDepth ||
        sampleY < generator.minY + 2 ||
        sampleY > generator.maxY ||
        sampleY > surfaceAt(sampleX, sampleZ) - 3 ||
        entranceCells.has(`${Math.floor(sampleX / spacing)},${Math.floor(sampleZ / spacing)}`)
      )
        return false;
      return hasExplicitCaveNetwork
        ? !this.authoredCellAt(sampleX, sampleY, sampleZ) && this.caveFieldVoidAt(sampleX, sampleY, sampleZ)
        : !this.volumeAt!(sampleX, sampleY, sampleZ);
    };
    const editedCaveSamplesByCell = new Map<number, [number, number, number]>();
    if (refineHorizonCaveFaces) {
      for (const { x, y, z } of editedCaveSamples) {
        const layer = Math.floor((y - generator.minY) / verticalStep);
        const gridX = Math.floor(x / spacing) - tileStartX + 1;
        const gridZ = Math.floor(z / spacing) - tileStartZ + 1;
        if (
          layer < 0 ||
          layer >= verticalLayers ||
          gridX < 0 ||
          gridX >= gridWidth ||
          gridZ < 0 ||
          gridZ >= gridDepth
        )
          continue;
        if (!isOpenCaveSample(x, y, z)) continue;
        const index = occupancyIndex(layer, gridZ, gridX);
        if (!editedCaveSamplesByCell.has(index)) editedCaveSamplesByCell.set(index, [x, y, z]);
      }
    }
    const coarseCaveCoordinates = [0, sourceOffset, spacing - 1];
    const coarseCaveCoordinateSet = new Set(coarseCaveCoordinates);

    for (let layer = 0; layer < verticalLayers; layer++) {
      const groupStart = generator.minY + layer * verticalStep;
      const groupHeight = Math.min(verticalStep, generator.maxY - groupStart + 1);
      const middleYOffset = Math.floor((groupHeight - 1) / 2);
      const y = groupStart + middleYOffset;
      let verticalCaveOffsets: number[] = [];
      const refinedVerticalCaveOffsets: number[] = [];
      if (refineHorizonCaveFaces) {
        const coarseCaveHeightOffsets = new Set([0, middleYOffset, groupHeight - 1]);
        verticalCaveOffsets = [
          ...new Set([Math.floor((groupHeight - 1) / 4), Math.floor((3 * (groupHeight - 1)) / 4)]),
        ].filter((offsetY) => !coarseCaveHeightOffsets.has(offsetY));
        const sampledVerticalOffsets = new Set([...coarseCaveHeightOffsets, ...verticalCaveOffsets]);
        let verticalRefinementSource = [...sampledVerticalOffsets].sort((a, b) => a - b);
        const refinedVerticalOffsetSet = new Set<number>();
        for (let refinement = 0; refinement < 2; refinement++) {
          for (let sample = 0; sample + 1 < verticalRefinementSource.length; sample++) {
            const start = verticalRefinementSource[sample];
            const end = verticalRefinementSource[sample + 1];
            if (end - start <= 1) continue;
            const midpoint = Math.floor((start + end) / 2);
            if (!sampledVerticalOffsets.has(midpoint)) {
              sampledVerticalOffsets.add(midpoint);
              refinedVerticalOffsetSet.add(midpoint);
            }
          }
          verticalRefinementSource = [...sampledVerticalOffsets].sort((a, b) => a - b);
        }
        refinedVerticalCaveOffsets.push(...[...refinedVerticalOffsetSet].sort((a, b) => a - b));
      }
      for (let gridZ = 0; gridZ < gridDepth; gridZ++) {
        const cellZ = tileStartZ + gridZ - 1;
        const sourceZ = sampleCenter(cellZ);
        if (sourceZ < originZ || sourceZ >= originZ + worldDepth) continue;
        for (let gridX = 0; gridX < gridWidth; gridX++) {
          const cellX = tileStartX + gridX - 1;
          if (entranceCells.has(`${cellX},${cellZ}`)) continue;
          const sourceX = sampleCenter(cellX);
          if (sourceX < originX || sourceX >= originX + worldWidth) continue;
          const index = occupancyIndex(layer, gridZ, gridX);
          if (this.volumeAt(sourceX, y, sourceZ)) occupancy[index] = 1;
          else if (
            y >= generator.minY + 2 &&
            y <= surfaceAt(sourceX, sourceZ) - 3 &&
            (!hasExplicitCaveNetwork || this.caveFieldVoidAt(sourceX, y, sourceZ))
          )
            occupancy[index] = 2;

          if (occupancy[index] === 1 && refineHorizonUndercuts) {
            const editedOffsets = editedUndercutOffsetsByCell.get(editColumnKey(cellX, cellZ)) ?? [];
            const probeCount = undercutOffsets.length + editedOffsets.length;
            for (let probe = 0; probe < probeCount; probe++) {
              const [offsetX, offsetZ] =
                probe < undercutOffsets.length
                  ? undercutOffsets[probe]
                  : editedOffsets[probe - undercutOffsets.length];
              const sampleX = cellX * spacing + offsetX;
              const sampleZ = cellZ * spacing + offsetZ;
              if (
                sampleX < originX ||
                sampleX >= originX + worldWidth ||
                sampleZ < originZ ||
                sampleZ >= originZ + worldDepth
              )
                continue;
              const surface = surfaceAt(sampleX, sampleZ);
              const firstGapY = Math.max(groupStart, surface + 2, generator.minY + 2);
              const lastGapY = Math.min(
                groupStart + groupHeight - 1,
                surface + maximumOverhangHeight - 1,
                generator.maxY - 1,
              );
              if (firstGapY <= lastGapY) {
                let belowIsSolid = this.volumeAt(sampleX, firstGapY - 1, sampleZ);
                let gapIsSolid = this.volumeAt(sampleX, firstGapY, sampleZ);
                for (let gapY = firstGapY; gapY <= lastGapY; gapY++) {
                  const aboveIsSolid = this.volumeAt(sampleX, gapY + 1, sampleZ);
                  if (!gapIsSolid && belowIsSolid && aboveIsSolid) {
                    // Preserve a bounded one-cell undercut missed by the layer-center sample.
                    occupancy[index] = 2;
                    break;
                  }
                  belowIsSolid = gapIsSolid;
                  gapIsSolid = aboveIsSolid;
                }
              }
              if (occupancy[index] === 2) break;
            }
          }

          if (occupancy[index] !== 1 || !refineHorizonCaveFaces) continue;
          const refinementSamples: [number, number, number][] = [
            [cellX * spacing, y, sourceZ],
            [(cellX + 1) * spacing - 1, y, sourceZ],
            [sourceX, y, cellZ * spacing],
            [sourceX, y, (cellZ + 1) * spacing - 1],
            [sourceX, groupStart, sourceZ],
            [sourceX, groupStart + groupHeight - 1, sourceZ],
            [cellX * spacing, groupStart, cellZ * spacing],
            [cellX * spacing, groupStart, (cellZ + 1) * spacing - 1],
            [(cellX + 1) * spacing - 1, groupStart, cellZ * spacing],
            [(cellX + 1) * spacing - 1, groupStart, (cellZ + 1) * spacing - 1],
            [cellX * spacing, groupStart + groupHeight - 1, cellZ * spacing],
            [cellX * spacing, groupStart + groupHeight - 1, (cellZ + 1) * spacing - 1],
            [(cellX + 1) * spacing - 1, groupStart + groupHeight - 1, cellZ * spacing],
            [(cellX + 1) * spacing - 1, groupStart + groupHeight - 1, (cellZ + 1) * spacing - 1],
          ];
          if (groupHeight > 2) {
            // The face and corner probes miss air along the twelve edges of the
            // coarse sample cube. Keep these bounded probes so connected caves
            // and undercuts on those edges survive horizon reduction.
            refinementSamples.push(
              [cellX * spacing, y, cellZ * spacing],
              [cellX * spacing, y, (cellZ + 1) * spacing - 1],
              [(cellX + 1) * spacing - 1, y, cellZ * spacing],
              [(cellX + 1) * spacing - 1, y, (cellZ + 1) * spacing - 1],
              [cellX * spacing, groupStart, sourceZ],
              [(cellX + 1) * spacing - 1, groupStart, sourceZ],
              [cellX * spacing, groupStart + groupHeight - 1, sourceZ],
              [(cellX + 1) * spacing - 1, groupStart + groupHeight - 1, sourceZ],
              [sourceX, groupStart, cellZ * spacing],
              [sourceX, groupStart, (cellZ + 1) * spacing - 1],
              [sourceX, groupStart + groupHeight - 1, cellZ * spacing],
              [sourceX, groupStart + groupHeight - 1, (cellZ + 1) * spacing - 1],
            );
          }
          let foundCaveSample = false;
          const editedCaveSample = editedCaveSamplesByCell.get(index);
          if (editedCaveSample && isOpenCaveSample(...editedCaveSample)) {
            occupancy[index] = 2;
            refinedCells[index] = 1;
            foundCaveSample = true;
          }
          if (foundCaveSample) continue;
          for (const [sampleX, sampleY, sampleZ] of refinementSamples) {
            if (!isOpenCaveSample(sampleX, sampleY, sampleZ)) continue;
            occupancy[index] = 2;
            refinedCells[index] = 1;
            foundCaveSample = true;
            break;
          }
          if (foundCaveSample) continue;

          // Only spend the finer horizontal probes when the established 3×3×3 lattice
          // found no opening. This recovers quarter-cell tunnel offsets without running
          // the 5×5 pass on cells already represented by the coarse cave pass.
          for (const offsetZ of undercutCoordinates) {
            for (const offsetX of undercutCoordinates) {
              if (coarseCaveCoordinateSet.has(offsetX) && coarseCaveCoordinateSet.has(offsetZ)) continue;
              const sampleX = cellX * spacing + offsetX;
              const sampleZ = cellZ * spacing + offsetZ;
              if (!isOpenCaveSample(sampleX, y, sampleZ)) continue;
              occupancy[index] = 2;
              refinedCells[index] = 1;
              foundCaveSample = true;
              break;
            }
            if (foundCaveSample) break;
          }
          if (foundCaveSample) continue;

          // Deep worlds can have unsampled source Y cells between coarse slabs. Probe
          // those quarter heights at the established 3×3 horizontal lattice.
          for (const offsetY of verticalCaveOffsets) {
            for (const offsetZ of coarseCaveCoordinates) {
              for (const offsetX of coarseCaveCoordinates) {
                const sampleX = cellX * spacing + offsetX;
                const sampleY = groupStart + offsetY;
                const sampleZ = cellZ * spacing + offsetZ;
                if (!isOpenCaveSample(sampleX, sampleY, sampleZ)) continue;
                occupancy[index] = 2;
                refinedCells[index] = 1;
                foundCaveSample = true;
                break;
              }
              if (foundCaveSample) break;
            }
            if (foundCaveSample) break;
          }
          if (foundCaveSample) continue;

          // Two bounded midpoint passes split remaining vertical gaps. These run only
          // after the center, boundary, quarter and horizontal probes miss.
          for (const offsetY of refinedVerticalCaveOffsets) {
            for (const offsetZ of coarseCaveCoordinates) {
              for (const offsetX of coarseCaveCoordinates) {
                const sampleX = cellX * spacing + offsetX;
                const sampleY = groupStart + offsetY;
                const sampleZ = cellZ * spacing + offsetZ;
                if (!isOpenCaveSample(sampleX, sampleY, sampleZ)) continue;
                occupancy[index] = 2;
                refinedCells[index] = 1;
                foundCaveSample = true;
                break;
              }
              if (foundCaveSample) break;
            }
            if (foundCaveSample) break;
          }
        }
      }
    }

    for (let layer = 0; layer < verticalLayers; layer++) {
      for (let gridZ = 0; gridZ < gridDepth; gridZ++) {
        for (let gridX = 0; gridX < gridWidth; gridX++) {
          const index = occupancyIndex(layer, gridZ, gridX);
          if (refinedCells[index] !== 1) continue;
          const hasCoarseNeighbor =
            (gridX > 0 && occupancy[index - 1] === 2) ||
            (gridX + 1 < gridWidth && occupancy[index + 1] === 2) ||
            (gridZ > 0 && occupancy[index - gridWidth] === 2) ||
            (gridZ + 1 < gridDepth && occupancy[index + gridWidth] === 2) ||
            (layer > 0 && occupancy[index - gridWidth * gridDepth] === 2) ||
            (layer + 1 < verticalLayers && occupancy[index + gridWidth * gridDepth] === 2);
          if (!hasCoarseNeighbor) refinedCells[index] = 2;
        }
      }
    }
    for (let index = 0; index < refinedCells.length; index++)
      if (refinedCells[index] === 2) occupancy[index] = 1;

    if (refineHorizonCaveFaces) {
      const cellCount = occupancy.length;
      const queue = new Uint32Array(cellCount);
      let queueEnd = 0;
      for (let index = 0; index < cellCount; index++) if (occupancy[index] === 2) queue[queueEnd++] = index;

      let remainingBoundaryProbes = MAXIMUM_HORIZON_CAVE_BOUNDARY_PROBES_PER_TILE;
      const openPair = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
        if (remainingBoundaryProbes <= 0) return false;
        remainingBoundaryProbes--;
        return isOpenCaveSample(ax, ay, az) && isOpenCaveSample(bx, by, bz);
      };
      const hasOpenBoundary = (
        layer: number,
        gridZ: number,
        gridX: number,
        layerOffset: number,
        zOffset: number,
        xOffset: number,
      ) => {
        const cellX = tileStartX + gridX - 1;
        const cellZ = tileStartZ + gridZ - 1;
        const groupStart = generator.minY + layer * verticalStep;
        const groupEnd = Math.min(generator.maxY, groupStart + verticalStep - 1);
        const groupHeight = groupEnd - groupStart + 1;
        const boundaryYs = [
          ...new Set([
            0,
            Math.floor((groupHeight - 1) / 4),
            Math.floor((groupHeight - 1) / 2),
            Math.floor((3 * (groupHeight - 1)) / 4),
            groupHeight - 1,
          ]),
        ].map((offset) => groupStart + offset);
        if (xOffset) {
          const boundary = (cellX + Math.max(0, xOffset)) * spacing;
          for (const y of boundaryYs)
            for (let offsetZ = 0; offsetZ < spacing; offsetZ++) {
              const z = cellZ * spacing + offsetZ;
              if (openPair(boundary - 1, y, z, boundary, y, z)) return true;
              if (remainingBoundaryProbes <= 0) return false;
            }
        } else if (zOffset) {
          const boundary = (cellZ + Math.max(0, zOffset)) * spacing;
          for (const y of boundaryYs)
            for (let offsetX = 0; offsetX < spacing; offsetX++) {
              const x = cellX * spacing + offsetX;
              if (openPair(x, y, boundary - 1, x, y, boundary)) return true;
              if (remainingBoundaryProbes <= 0) return false;
            }
        } else if (layerOffset) {
          const lowerLayer = layer + Math.min(0, layerOffset);
          const lowerStart = generator.minY + lowerLayer * verticalStep;
          const lowerY = Math.min(generator.maxY, lowerStart + verticalStep - 1);
          for (const offsetZ of undercutCoordinates)
            for (const offsetX of undercutCoordinates) {
              const x = cellX * spacing + offsetX;
              const z = cellZ * spacing + offsetZ;
              if (openPair(x, lowerY, z, x, lowerY + 1, z)) return true;
              if (remainingBoundaryProbes <= 0) return false;
            }
        }
        return false;
      };
      const directions: [number, number, number][] = [
        [0, 0, -1],
        [0, 0, 1],
        [0, -1, 0],
        [0, 1, 0],
        [-1, 0, 0],
        [1, 0, 0],
      ];
      const layerStride = gridWidth * gridDepth;
      // Follow connected openings across coarse cells, bounded by the tile's pair-probe budget.
      for (let queueStart = 0; queueStart < queueEnd && remainingBoundaryProbes > 0; queueStart++) {
        const index = queue[queueStart];
        const layer = Math.floor(index / layerStride);
        const inLayer = index - layer * layerStride;
        const gridZ = Math.floor(inLayer / gridWidth);
        const gridX = inLayer - gridZ * gridWidth;
        for (const [layerOffset, zOffset, xOffset] of directions) {
          const nextLayer = layer + layerOffset;
          const nextZ = gridZ + zOffset;
          const nextX = gridX + xOffset;
          if (
            nextLayer < 0 ||
            nextLayer >= verticalLayers ||
            nextZ < 0 ||
            nextZ >= gridDepth ||
            nextX < 0 ||
            nextX >= gridWidth
          )
            continue;
          const neighbor = occupancyIndex(nextLayer, nextZ, nextX);
          if (
            occupancy[neighbor] === 1 &&
            hasOpenBoundary(layer, gridZ, gridX, layerOffset, zOffset, xOffset)
          ) {
            occupancy[neighbor] = 2;
            queue[queueEnd++] = neighbor;
          }
          if (remainingBoundaryProbes <= 0) break;
        }
      }
    }

    for (let gridZ = 0; gridZ < gridDepth; gridZ++) {
      const cellZ = tileStartZ + gridZ - 1;
      const sourceZ = sampleCenter(cellZ);
      if (sourceZ < originZ || sourceZ >= originZ + worldDepth) continue;
      for (let gridX = 0; gridX < gridWidth; gridX++) {
        const cellX = tileStartX + gridX - 1;
        if (entranceCells.has(`${cellX},${cellZ}`)) continue;
        const sourceX = sampleCenter(cellX);
        if (sourceX < originX || sourceX >= originX + worldWidth) continue;
        const surface = surfaceAt(sourceX, sourceZ);
        let foundUpperSolid = false;
        let pendingUndercutStart = -1;
        for (let layer = verticalLayers - 1; layer >= 0; layer--) {
          const groupStart = generator.minY + layer * verticalStep;
          const groupHeight = Math.min(verticalStep, generator.maxY - groupStart + 1);
          const y = groupStart + Math.floor((groupHeight - 1) / 2);
          if (y <= surface) break;
          const index = occupancyIndex(layer, gridZ, gridX);
          if (occupancy[index] === 1) {
            if (foundUpperSolid && pendingUndercutStart >= 0)
              for (let pendingLayer = pendingUndercutStart; pendingLayer > layer; pendingLayer--)
                occupancy[occupancyIndex(pendingLayer, gridZ, gridX)] = 2;
            foundUpperSolid = true;
            pendingUndercutStart = -1;
          } else if (foundUpperSolid && occupancy[index] === 0 && pendingUndercutStart < 0)
            pendingUndercutStart = layer;
        }
      }
    }
    const isExcluded = (localX: number, localZ: number) => {
      const centerX = (tileStartX + localX) * spacing + (spacing - 1) / 2;
      const centerZ = (tileStartZ + localZ) * spacing + (spacing - 1) / 2;
      return (
        centerX >= excludedBounds.minX &&
        centerX < excludedBounds.maxX &&
        centerZ >= excludedBounds.minZ &&
        centerZ < excludedBounds.maxZ
      );
    };
    type CaveFaceRectangle = {
      axis: 'x' | 'y' | 'z';
      plane: number;
      u: number;
      v: number;
      width: number;
      height: number;
      side: -1 | 1;
    };
    const rectangles: CaveFaceRectangle[] = [];
    let overBudget = false;
    const collectRectangles = (
      mask: Int8Array,
      width: number,
      height: number,
      axis: CaveFaceRectangle['axis'],
      plane: number,
    ) => {
      for (let v = 0; v < height && !overBudget; v++) {
        for (let u = 0; u < width; u++) {
          const side = mask[v * width + u];
          if (!side) continue;
          let rectangleWidth = 1;
          while (u + rectangleWidth < width && mask[v * width + u + rectangleWidth] === side)
            rectangleWidth++;
          let rectangleHeight = 1;
          for (; v + rectangleHeight < height; rectangleHeight++) {
            let matches = true;
            for (let offset = 0; offset < rectangleWidth; offset++)
              if (mask[(v + rectangleHeight) * width + u + offset] !== side) {
                matches = false;
                break;
              }
            if (!matches) break;
          }
          for (let row = 0; row < rectangleHeight; row++)
            mask.fill(0, (v + row) * width + u, (v + row) * width + u + rectangleWidth);
          rectangles.push({
            axis,
            plane,
            u,
            v,
            width: rectangleWidth,
            height: rectangleHeight,
            side: side as -1 | 1,
          });
          if (rectangles.length > MAXIMUM_COARSE_CAVE_VOLUME_FACES_PER_TILE) {
            overBudget = true;
            break;
          }
        }
      }
    };
    const stateAt = (layer: number, z: number, x: number) => occupancy[occupancyIndex(layer, z, x)];

    for (let plane = 0; plane <= TILE_SIZE && !overBudget; plane++) {
      const mask = new Int8Array(TILE_SIZE * verticalLayers);
      for (let localZ = 0; localZ < TILE_SIZE; localZ++) {
        for (let layer = 0; layer < verticalLayers; layer++) {
          const left = stateAt(layer, localZ + 1, plane);
          const right = stateAt(layer, localZ + 1, plane + 1);
          const side = left === 1 && right === 2 ? 1 : right === 1 && left === 2 ? -1 : 0;
          const solidX = side > 0 ? plane - 1 : plane;
          if (side && !isExcluded(solidX, localZ)) mask[layer * TILE_SIZE + localZ] = side;
        }
      }
      collectRectangles(mask, TILE_SIZE, verticalLayers, 'x', plane);
    }

    for (let plane = 0; plane <= TILE_SIZE && !overBudget; plane++) {
      const mask = new Int8Array(TILE_SIZE * verticalLayers);
      for (let localX = 0; localX < TILE_SIZE; localX++) {
        for (let layer = 0; layer < verticalLayers; layer++) {
          const back = stateAt(layer, plane, localX + 1);
          const front = stateAt(layer, plane + 1, localX + 1);
          const side = back === 1 && front === 2 ? 1 : front === 1 && back === 2 ? -1 : 0;
          const solidZ = side > 0 ? plane - 1 : plane;
          if (side && !isExcluded(localX, solidZ)) mask[layer * TILE_SIZE + localX] = side;
        }
      }
      collectRectangles(mask, TILE_SIZE, verticalLayers, 'z', plane);
    }

    for (let plane = 0; plane + 1 < verticalLayers && !overBudget; plane++) {
      const mask = new Int8Array(TILE_SIZE * TILE_SIZE);
      for (let localZ = 0; localZ < TILE_SIZE; localZ++) {
        for (let localX = 0; localX < TILE_SIZE; localX++) {
          const lower = stateAt(plane, localZ + 1, localX + 1);
          const upper = stateAt(plane + 1, localZ + 1, localX + 1);
          const side = lower === 1 && upper === 2 ? 1 : upper === 1 && lower === 2 ? -1 : 0;
          if (side && !isExcluded(localX, localZ)) mask[localZ * TILE_SIZE + localX] = side;
        }
      }
      collectRectangles(mask, TILE_SIZE, TILE_SIZE, 'y', plane);
    }
    if (overBudget) return;

    const coarseBoundary = (cell: number) => cell - 0.5 / spacing;
    const verticalBoundary = (layer: number) =>
      generator.minY + Math.min(layer * verticalStep, worldHeight) - 0.5;
    const wall = { color: generator.palette.deep, materialType: generator.palette.materialType };
    for (const rectangle of rectangles) {
      const { axis, plane, u, v, width, height, side } = rectangle;
      let points: number[][];
      let normal: [number, number, number];
      if (axis === 'x') {
        const x = plane - 0.5 / spacing;
        const y0 = verticalBoundary(v);
        const y1 = verticalBoundary(v + height);
        const z0 = coarseBoundary(u);
        const z1 = coarseBoundary(u + width);
        points = [
          [x, y0, z0],
          [x, y1, z0],
          [x, y1, z1],
          [x, y0, z1],
        ];
        normal = [side, 0, 0];
      } else if (axis === 'z') {
        const z = plane - 0.5 / spacing;
        const y0 = verticalBoundary(v);
        const y1 = verticalBoundary(v + height);
        const x0 = coarseBoundary(u);
        const x1 = coarseBoundary(u + width);
        points = [
          [x0, y0, z],
          [x1, y0, z],
          [x1, y1, z],
          [x0, y1, z],
        ];
        normal = [0, 0, side];
      } else {
        const y = verticalBoundary(plane + 1);
        const x0 = coarseBoundary(u);
        const x1 = coarseBoundary(u + width);
        const z0 = coarseBoundary(v);
        const z1 = coarseBoundary(v + height);
        points = [
          [x0, y, z0],
          [x0, y, z1],
          [x1, y, z1],
          [x1, y, z0],
        ];
        normal = [0, side, 0];
      }
      if (side < 0) points = [points[0], points[3], points[2], points[1]];
      this.emit(faces, wall, points, normal);
    }
  }

  private emitApertureWall(
    faces: FaceBuilder[],
    value: WorldCell,
    direction: 'left' | 'right' | 'back' | 'front',
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    bottomStart: number,
    bottomEnd: number,
    topStart: number,
    topEnd: number,
    faceTowardCurrent: boolean,
  ) {
    if (direction === 'left')
      this.emit(
        faces,
        value,
        faceTowardCurrent
          ? [
              [x0, bottomStart, z0],
              [x0, topStart, z0],
              [x0, topEnd, z1],
              [x0, bottomEnd, z1],
            ]
          : [
              [x0, bottomEnd, z1],
              [x0, topEnd, z1],
              [x0, topStart, z0],
              [x0, bottomStart, z0],
            ],
        [faceTowardCurrent ? 1 : -1, 0, 0],
      );
    else if (direction === 'right')
      this.emit(
        faces,
        value,
        faceTowardCurrent
          ? [
              [x1, bottomStart, z0],
              [x1, bottomEnd, z1],
              [x1, topEnd, z1],
              [x1, topStart, z0],
            ]
          : [
              [x1, bottomEnd, z1],
              [x1, bottomStart, z0],
              [x1, topStart, z0],
              [x1, topEnd, z1],
            ],
        [faceTowardCurrent ? -1 : 1, 0, 0],
      );
    else if (direction === 'back')
      this.emit(
        faces,
        value,
        faceTowardCurrent
          ? [
              [x0, bottomStart, z0],
              [x1, bottomEnd, z0],
              [x1, topEnd, z0],
              [x0, topStart, z0],
            ]
          : [
              [x1, bottomEnd, z0],
              [x0, bottomStart, z0],
              [x0, topStart, z0],
              [x1, topEnd, z0],
            ],
        [0, 0, faceTowardCurrent ? 1 : -1],
      );
    else
      this.emit(
        faces,
        value,
        faceTowardCurrent
          ? [
              [x0, bottomStart, z1],
              [x0, topStart, z1],
              [x1, topEnd, z1],
              [x1, bottomEnd, z1],
            ]
          : [
              [x0, topStart, z1],
              [x0, bottomStart, z1],
              [x1, bottomEnd, z1],
              [x1, topEnd, z1],
            ],
        [0, 0, faceTowardCurrent ? -1 : 1],
      );
  }

  private emitCoarseSide(
    faces: FaceBuilder[],
    value: WorldCell,
    direction: 'left' | 'right' | 'back' | 'front',
    x: number,
    z: number,
    low: number,
    high: number,
    start: number,
    endLow: number,
    endHigh: number,
  ) {
    if (endLow <= start && endHigh <= start) return;
    if (direction === 'left')
      this.emit(
        faces,
        value,
        [
          [x - low, start, z - low],
          [x - low, start, z + high],
          [x - low, endHigh, z + high],
          [x - low, endLow, z - low],
        ],
        [-1, 0, 0],
      );
    else if (direction === 'right')
      this.emit(
        faces,
        value,
        [
          [x + high, start, z - low],
          [x + high, endLow, z - low],
          [x + high, endHigh, z + high],
          [x + high, start, z + high],
        ],
        [1, 0, 0],
      );
    else if (direction === 'back')
      this.emit(
        faces,
        value,
        [
          [x - low, start, z - low],
          [x - low, endLow, z - low],
          [x + high, endHigh, z - low],
          [x + high, start, z - low],
        ],
        [0, 0, -1],
      );
    else
      this.emit(
        faces,
        value,
        [
          [x - low, start, z + high],
          [x + high, start, z + high],
          [x + high, endHigh, z + high],
          [x - low, endLow, z + high],
        ],
        [0, 0, 1],
      );
  }

  private emitTriangle(
    faces: FaceBuilder[],
    value: WorldCell,
    points: number[][],
    vertexNormals?: SurfaceNormal[],
    horizontalSpacing = 1,
  ) {
    const materialIndex = materials.indexOf(value.materialType as MaterialType);
    const face = faces[materialIndex < 0 ? 0 : materialIndex];
    const [a, b, c] = points;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const color = new THREE.Color(value.color);
    const first = face.positions.length / 3;
    // Blend in physical proportions, then encode for the mesh's nonuniform scale.
    const flatNormal = normalizeNormal([
      normal[0] / horizontalSpacing,
      normal[1],
      normal[2] / horizontalSpacing,
    ]);
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const point = points[pointIndex];
      face.positions.push(...point);
      const smoothNormal = vertexNormals?.[pointIndex];
      const shadedNormal = smoothNormal
        ? flatNormal.map(
            (component, axis) =>
              component * (1 - COARSE_NORMAL_SMOOTHING) + smoothNormal[axis] * COARSE_NORMAL_SMOOTHING,
          )
        : flatNormal;
      face.normals.push(
        ...normalizeNormal([
          shadedNormal[0] * horizontalSpacing,
          shadedNormal[1],
          shadedNormal[2] * horizontalSpacing,
        ]),
      );
      face.colors.push(color.r, color.g, color.b);
    }
    face.indices.push(first, first + 1, first + 2);
  }

  private geometryFromFaces(faces: FaceBuilder[]) {
    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let materialIndex = 0; materialIndex < faces.length; materialIndex++) {
      const face = faces[materialIndex];
      if (!face.indices.length) continue;
      const vertexOffset = positions.length / 3;
      const indexStart = indices.length;
      positions.push(...face.positions);
      normals.push(...face.normals);
      colors.push(...face.colors);
      indices.push(...face.indices.map((index) => index + vertexOffset));
      geometry.addGroup(indexStart, indices.length - indexStart, materialIndex);
    }
    if (!indices.length) {
      geometry.dispose();
      return null;
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private emitSideDifferences(
    faces: FaceBuilder[],
    band: ColumnBand,
    neighbor: ColumnBand[],
    direction: 'left' | 'right' | 'back' | 'front',
    x: number,
    z: number,
  ) {
    let low = 0;
    let high = neighbor.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (neighbor[middle].end <= band.start) low = middle + 1;
      else high = middle;
    }
    let cursor = band.start;
    for (let index = low; index < neighbor.length; index++) {
      const other = neighbor[index];
      if (other.end <= cursor) continue;
      if (other.start >= band.end) break;
      if (other.start > cursor)
        this.emitSide(faces, band.value, direction, x, z, cursor, Math.min(other.start, band.end));
      cursor = Math.max(cursor, other.end);
      if (cursor >= band.end) return;
    }
    if (cursor < band.end) this.emitSide(faces, band.value, direction, x, z, cursor, band.end);
  }

  private emitSide(
    faces: FaceBuilder[],
    value: WorldCell,
    direction: 'left' | 'right' | 'back' | 'front',
    x: number,
    z: number,
    start: number,
    end: number,
  ) {
    if (end <= start) return;
    const low = start - 0.5;
    const high = end - 0.5;
    if (direction === 'left')
      this.emit(
        faces,
        value,
        [
          [x - 0.5, low, z - 0.5],
          [x - 0.5, low, z + 0.5],
          [x - 0.5, high, z + 0.5],
          [x - 0.5, high, z - 0.5],
        ],
        [-1, 0, 0],
      );
    else if (direction === 'right')
      this.emit(
        faces,
        value,
        [
          [x + 0.5, low, z - 0.5],
          [x + 0.5, high, z - 0.5],
          [x + 0.5, high, z + 0.5],
          [x + 0.5, low, z + 0.5],
        ],
        [1, 0, 0],
      );
    else if (direction === 'back')
      this.emit(
        faces,
        value,
        [
          [x - 0.5, low, z - 0.5],
          [x - 0.5, high, z - 0.5],
          [x + 0.5, high, z - 0.5],
          [x + 0.5, low, z - 0.5],
        ],
        [0, 0, -1],
      );
    else
      this.emit(
        faces,
        value,
        [
          [x - 0.5, low, z + 0.5],
          [x + 0.5, low, z + 0.5],
          [x + 0.5, high, z + 0.5],
          [x - 0.5, high, z + 0.5],
        ],
        [0, 0, 1],
      );
  }

  private emit(faces: FaceBuilder[], value: WorldCell, points: number[][], normal: [number, number, number]) {
    const materialIndex = materials.indexOf(value.materialType as MaterialType);
    const face = faces[materialIndex < 0 ? 0 : materialIndex];
    const color = new THREE.Color(value.color);
    const first = face.positions.length / 3;
    for (const point of points) {
      face.positions.push(...point);
      face.normals.push(...normal);
      face.colors.push(color.r, color.g, color.b);
    }
    face.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
}
