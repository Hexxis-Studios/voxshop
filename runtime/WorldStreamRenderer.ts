import * as THREE from 'three';
import {
  createTerrainCaveFieldVoidSampler,
  createTerrainSurfaceSampler,
  createTerrainVolumeSampler,
  sampleTerrainOverhangHeightMap,
  TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT,
} from '../services/terrainNoise';
import { createTerrainBiomeSampler } from '../services/terrainBiomeField';
import type { WorldCell, WorldDocument, WorldEdit } from '../services/worldDocument';
import { createVoxelMaterials } from './assetMesh';
import { geometryArrayBytes } from './geometryArrayBytes';
import {
  COARSE_CAVE_NETWORK_BRANCH_BUFFER_BYTES,
  COARSE_CAVE_NETWORK_CONNECTOR_BUFFER_BYTES,
  COARSE_CAVE_NETWORK_TUNNEL_BUFFER_BYTES,
  COARSE_CAVE_VOLUME_BUFFER_BYTES,
  COARSE_OVERHANG_VOLUME_BUFFER_BYTES,
  MAXIMUM_APERTURE_COARSE_CELLS,
  MAXIMUM_APERTURE_OPEN_CELLS,
  MAXIMUM_APERTURE_WALLS,
  WorldStreamGeometryBuilder,
  type ColumnBand,
} from './worldStreamGeometry';
import { sameEdit, summarizeDurations } from './worldRenderHelpers';
import { VOXEL_CHUNK_SIZE } from './voxelGeometry';
import { deserializeTileGeometry } from './worldStreamWorkerProtocol';
import type {
  TileBuildRequest,
  TileBuildResponse,
  TileCoordinate,
  TileLevel,
} from './worldStreamWorkerProtocol';

const TILE_SIZE = VOXEL_CHUNK_SIZE;
const CORE_RADIUS = 2;
const MEDIUM_CELL_SPACING = 2;
const MEDIUM_TILE_SIZE = TILE_SIZE * MEDIUM_CELL_SPACING;
const MEDIUM_TILE_RADIUS = 2;
const FAR_CELL_SPACING = 4;
const FAR_TILE_SIZE = TILE_SIZE * FAR_CELL_SPACING;
const FAR_TILE_RADIUS = 2;
const HORIZON_CELL_SPACING = FAR_CELL_SPACING * 4;
const HORIZON_TILE_SIZE = TILE_SIZE * HORIZON_CELL_SPACING;
const HORIZON_TILE_RADIUS = 2;
const MAXIMUM_RESIDENT_TILES = (CORE_RADIUS * 2 + 1) ** 2;
const MAXIMUM_RESIDENT_MEDIUM_TILES = (MEDIUM_TILE_RADIUS * 2 + 1) ** 2;
const MAXIMUM_RESIDENT_FAR_TILES = (FAR_TILE_RADIUS * 2 + 1) ** 2;
const MAXIMUM_RESIDENT_HORIZON_TILES = (HORIZON_TILE_RADIUS * 2 + 1) ** 2;
const MAXIMUM_RESIDENT_GEOMETRIES =
  MAXIMUM_RESIDENT_TILES +
  MAXIMUM_RESIDENT_MEDIUM_TILES +
  MAXIMUM_RESIDENT_FAR_TILES +
  MAXIMUM_RESIDENT_HORIZON_TILES;
// A regular coarse cell can emit 128 vertices; estimate 32-bit indices because
// the worst-case cave connectors can take a tile past 65,535 vertices.
const COARSE_CELL_VERTEX_BUDGET = 128;
const COARSE_CELL_INDEX_BUDGET = 126;
const BASE_COARSE_TILE_BUFFER_BYTES =
  TILE_SIZE ** 2 *
  (COARSE_CELL_VERTEX_BUDGET * 9 * Float32Array.BYTES_PER_ELEMENT +
    COARSE_CELL_INDEX_BUDGET * Uint32Array.BYTES_PER_ELEMENT);
const apertureExtraBufferBytes = (spacing: number) => {
  const vertexBudget =
    MAXIMUM_APERTURE_COARSE_CELLS * spacing ** 2 * 6 +
    MAXIMUM_APERTURE_OPEN_CELLS * 4 +
    MAXIMUM_APERTURE_WALLS * 4;
  const indexBudget =
    MAXIMUM_APERTURE_COARSE_CELLS * spacing ** 2 * 6 +
    MAXIMUM_APERTURE_OPEN_CELLS * 6 +
    MAXIMUM_APERTURE_WALLS * 6;
  return (
    (vertexBudget - MAXIMUM_APERTURE_COARSE_CELLS * COARSE_CELL_VERTEX_BUDGET) *
      9 *
      Float32Array.BYTES_PER_ELEMENT +
    (indexBudget - MAXIMUM_APERTURE_COARSE_CELLS * COARSE_CELL_INDEX_BUDGET) * Uint32Array.BYTES_PER_ELEMENT
  );
};
const FAR_APERTURE_EXTRA_BUFFER_BYTES =
  apertureExtraBufferBytes(FAR_CELL_SPACING) +
  COARSE_CAVE_NETWORK_TUNNEL_BUFFER_BYTES +
  COARSE_CAVE_NETWORK_BRANCH_BUFFER_BYTES +
  COARSE_CAVE_NETWORK_CONNECTOR_BUFFER_BYTES +
  COARSE_CAVE_VOLUME_BUFFER_BYTES +
  COARSE_OVERHANG_VOLUME_BUFFER_BYTES;
const HORIZON_APERTURE_EXTRA_BUFFER_BYTES =
  apertureExtraBufferBytes(HORIZON_CELL_SPACING) +
  COARSE_CAVE_NETWORK_TUNNEL_BUFFER_BYTES +
  COARSE_CAVE_NETWORK_BRANCH_BUFFER_BYTES +
  COARSE_CAVE_NETWORK_CONNECTOR_BUFFER_BYTES +
  COARSE_CAVE_VOLUME_BUFFER_BYTES +
  COARSE_OVERHANG_VOLUME_BUFFER_BYTES;
const MAXIMUM_COARSE_TILE_BUFFER_BYTES = BASE_COARSE_TILE_BUFFER_BYTES + HORIZON_APERTURE_EXTRA_BUFFER_BYTES;
const MAXIMUM_RESIDENT_COARSE_BUFFER_BYTES =
  MAXIMUM_RESIDENT_MEDIUM_TILES * BASE_COARSE_TILE_BUFFER_BYTES +
  MAXIMUM_RESIDENT_FAR_TILES * (BASE_COARSE_TILE_BUFFER_BYTES + FAR_APERTURE_EXTRA_BUFFER_BYTES) +
  MAXIMUM_RESIDENT_HORIZON_TILES * (BASE_COARSE_TILE_BUFFER_BYTES + HORIZON_APERTURE_EXTRA_BUFFER_BYTES);
type TileRecord = { mesh: THREE.Mesh | null; dirty?: boolean };
type FarTileRecord = TileRecord & { dirty: boolean };
type TileRequest = { level: TileLevel; coordinate: TileCoordinate };
type SourceBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
type PendingTileRequest = TileRequest & {
  distanceSquared: number;
  centered: boolean;
  dirty: boolean;
  visible: boolean;
};

const keyOf = ({ x, z }: TileCoordinate) => `${x},${z}`;
const editColumnKey = (x: number, z: number) => `${x},${z}`;
const cellKey = ({ x, y, z }: Pick<WorldEdit, 'x' | 'y' | 'z'>) => `${x},${y},${z}`;

/** Streams bounded near, medium, far and horizon heightfields, building at most one mesh per update. */
export class WorldStreamRenderer {
  readonly group = new THREE.Group();
  private readonly tileEdits = new Map<string, Map<number, WorldCell | null>>();
  private readonly currentEdits = new Map<string, WorldEdit>();
  private readonly workerKnownEdits = new Map<string, WorldEdit>();
  private readonly workerEditUpdates = new Map<string, WorldEdit | null>();
  private readonly editedTiles = new Set<string>();
  private readonly editedOverrideChunks = new Set<string>();
  private readonly editedOverrideColumnsByTile = new Map<string, Set<string>>();
  private readonly editedSurfaceColumnsByTile = new Map<string, Set<string>>();
  private readonly materials = createVoxelMaterials();
  private readonly resident = new Map<string, TileRecord>();
  private readonly mediumResident = new Map<string, FarTileRecord>();
  private readonly farResident = new Map<string, FarTileRecord>();
  private readonly horizonResident = new Map<string, FarTileRecord>();
  private readonly desired = new Set<string>();
  private readonly mediumDesired = new Set<string>();
  private readonly farDesired = new Set<string>();
  private readonly horizonDesired = new Set<string>();
  private readonly tileBuildDurations: Record<TileLevel, number[]> = {
    near: [],
    medium: [],
    far: [],
    horizon: [],
  };
  private readonly workerBuildDurations: Record<TileLevel, number[]> = {
    near: [],
    medium: [],
    far: [],
    horizon: [],
  };
  private readonly tileInstallDurations: Record<TileLevel, number[]> = {
    near: [],
    medium: [],
    far: [],
    horizon: [],
  };
  private readonly updateDurations: number[] = [];
  private readonly surfaceAt: (x: number, z: number) => number;
  private readonly volumeAt: ((x: number, y: number, z: number) => boolean) | null;
  private readonly paletteAt: (x: number, z: number) => WorldDocument['generator']['palette'];
  private readonly voxelSize: number;
  private worker: Worker | null = null;
  private workerPending: {
    id: number;
    revision: number;
    level: TileLevel;
    coordinate: TileCoordinate;
  } | null = null;
  private workerSentWorld = false;
  private workerFailed = false;
  private disposed = false;
  private workerRequestId = 0;
  private windowRevision = 0;
  private latestTarget = new THREE.Vector3();
  private center: TileCoordinate | null = null;
  private verticalCenter: number | null = null;
  private mediumCenter: TileCoordinate | null = null;
  private farCenter: TileCoordinate | null = null;

  static view(world: WorldDocument) {
    const { generator } = world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    const mapRadius = (Math.min(width, depth) * world.voxelSize) / 2;
    return {
      target: new THREE.Vector3(
        (originX + (width - 1) / 2) * world.voxelSize,
        generator.baseHeight * world.voxelSize,
        (originZ + (depth - 1) / 2) * world.voxelSize,
      ),
      distance: Math.max(
        0.001,
        Math.min(
          mapRadius * 0.45,
          Math.max(TILE_SIZE * world.voxelSize * 3, (generator.maxY - generator.minY) * world.voxelSize),
        ),
      ),
      horizonDistance: HORIZON_TILE_SIZE * world.voxelSize * (HORIZON_TILE_RADIUS + 1),
    };
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldDocument,
    private readonly nearTileCutout?: (coordinate: TileCoordinate) => [number, number] | undefined,
    private readonly createWorker?: () => Worker,
  ) {
    this.voxelSize = world.voxelSize;
    this.surfaceAt = createTerrainSurfaceSampler(world);
    this.volumeAt =
      world.generator.mode === 'voxel3d' ? createTerrainVolumeSampler(world, this.surfaceAt) : null;
    this.paletteAt = createTerrainBiomeSampler(
      world.seed,
      world.voxelSize,
      world.generator.palette,
      world.generator.biomeField,
    );
    this.geometryBuilder = new WorldStreamGeometryBuilder(
      world,
      (x, z) => this.columnAt(x, z),
      (x, z) => this.columnTopAt(x, z),
      (x, y, z) => {
        const edit = this.currentEdits.get(`${x},${y},${z}`);
        return edit !== undefined && edit.value !== null;
      },
      (x, z) => {
        const surface = this.surfaceAt(x, z);
        const top = this.columnTopAt(x, z);
        return Boolean(top && top.top < surface);
      },
      (bounds) => this.editedColumnsIn(bounds),
      (x, z) => this.surfaceAt(x, z),
      (x, y, z) => {
        const edit = this.currentEdits.get(`${x},${y},${z}`);
        if (edit !== undefined) return edit.value !== null;
        return this.volumeAt?.(x, y, z) ?? false;
      },
      createTerrainCaveFieldVoidSampler(world, this.surfaceAt),
      (bounds) => this.hasEditedOverridesIn(bounds),
      (bounds) => this.editedOverrideColumnsIn(bounds),
      (bounds, spacing, minY, verticalStep) => this.editedCaveSamplesIn(bounds, spacing, minY, verticalStep),
    );
    for (const edit of world.edits) {
      this.currentEdits.set(cellKey(edit), edit);
      const key = editColumnKey(edit.x, edit.z);
      let column = this.tileEdits.get(key);
      if (!column) this.tileEdits.set(key, (column = new Map()));
      column.set(edit.y, edit.value);
      const tile = keyOf({ x: Math.floor(edit.x / TILE_SIZE), z: Math.floor(edit.z / TILE_SIZE) });
      this.editedOverrideChunks.add(tile);
      let overrideColumns = this.editedOverrideColumnsByTile.get(tile);
      if (!overrideColumns) this.editedOverrideColumnsByTile.set(tile, (overrideColumns = new Set()));
      overrideColumns.add(key);
      if (edit.value)
        this.editedTiles.add(keyOf({ x: Math.floor(edit.x / TILE_SIZE), z: Math.floor(edit.z / TILE_SIZE) }));
    }
    this.rebuildSurfaceOpeningIndex();
    this.group.name = `world:${world.id}`;
    scene.add(this.group);
  }

  update(target: THREE.Vector3, camera?: THREE.Camera, buildMesh = true, forceWindow = false) {
    if (this.disposed) return;
    const startedAt = performance.now();
    try {
      this.updateWindow(target, forceWindow);
      this.hasViewFrustum = Boolean(camera);
      if (camera) {
        camera.updateMatrixWorld(true);
        this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.viewFrustum.setFromProjectionMatrix(this.viewProjection);
      }
      if (!buildMesh) return;
      this.latestTarget.copy(target);
      if (this.createWorker && !this.workerFailed) this.requestWorkerTile();
      else this.buildOneTile();
    } finally {
      this.recordDuration(this.updateDurations, performance.now() - startedAt);
    }
  }

  /** Reindexes sparse edits and queues only resident heightfield tiles touched by those columns. */
  updateWorldEdits(edits: readonly WorldEdit[], changed: readonly Pick<WorldEdit, 'x' | 'y' | 'z'>[]) {
    this.currentEdits.clear();
    for (const edit of edits) this.currentEdits.set(cellKey(edit), edit);
    this.tileEdits.clear();
    this.editedTiles.clear();
    this.editedOverrideChunks.clear();
    this.editedOverrideColumnsByTile.clear();
    this.editedSurfaceColumnsByTile.clear();
    for (const edit of edits) {
      const key = editColumnKey(edit.x, edit.z);
      let column = this.tileEdits.get(key);
      if (!column) this.tileEdits.set(key, (column = new Map()));
      column.set(edit.y, edit.value);
      const tile = keyOf({ x: Math.floor(edit.x / TILE_SIZE), z: Math.floor(edit.z / TILE_SIZE) });
      this.editedOverrideChunks.add(tile);
      let overrideColumns = this.editedOverrideColumnsByTile.get(tile);
      if (!overrideColumns) this.editedOverrideColumnsByTile.set(tile, (overrideColumns = new Set()));
      overrideColumns.add(key);
      if (edit.value)
        this.editedTiles.add(keyOf({ x: Math.floor(edit.x / TILE_SIZE), z: Math.floor(edit.z / TILE_SIZE) }));
    }
    this.rebuildSurfaceOpeningIndex();
    this.tileGeometryColumns.clear();
    this.updateWindow(this.latestTarget, true);
    for (const position of changed) {
      const key = cellKey(position);
      this.queueWorkerEdit(key, this.currentEdits.get(key) ?? null);
      this.markResidentTilesDirty(position);
    }
  }

  /** Applies incremental sparse edits received by the terrain worker. */
  applyWorldEditPatch(
    edits: readonly WorldEdit[],
    clearedEdits: readonly Pick<WorldEdit, 'x' | 'y' | 'z'>[],
  ) {
    const changed: Pick<WorldEdit, 'x' | 'y' | 'z'>[] = [];
    for (const position of clearedEdits) {
      if (this.currentEdits.delete(cellKey(position))) changed.push(position);
    }
    for (const edit of edits) {
      const key = cellKey(edit);
      if (sameEdit(this.currentEdits.get(key), edit)) continue;
      this.currentEdits.set(key, edit);
      changed.push(edit);
    }
    if (changed.length) this.updateWorldEdits([...this.currentEdits.values()], changed);
  }

  private markResidentTilesDirty(position: Pick<WorldEdit, 'x' | 'y' | 'z'>) {
    const touched = (cell: number, tileSize: number, margin: number) => {
      const tile = Math.floor(cell / tileSize),
        offset = cell - tile * tileSize,
        tiles = new Set([tile]);
      if (offset < margin) tiles.add(tile - 1);
      if (tileSize - 1 - offset < margin) tiles.add(tile + 1);
      return [...tiles];
    };
    const levels = [
      { spacing: 1, resident: this.resident },
      { spacing: MEDIUM_CELL_SPACING, resident: this.mediumResident },
      { spacing: FAR_CELL_SPACING, resident: this.farResident },
      { spacing: HORIZON_CELL_SPACING, resident: this.horizonResident },
    ];
    for (const { spacing, resident } of levels) {
      const tileSize = TILE_SIZE * spacing;
      for (const x of touched(position.x, tileSize, spacing))
        for (const z of touched(position.z, tileSize, spacing)) {
          const record = resident.get(keyOf({ x, z }));
          if (record) record.dirty = true;
        }
    }
  }

  private rebuildSurfaceOpeningIndex() {
    this.editedSurfaceColumnsByTile.clear();
    for (const [key, edits] of this.tileEdits) {
      const [x, z] = key.split(',').map(Number);
      if (edits.get(this.surfaceAt(x, z)) !== null) continue;
      const tile = keyOf({ x: Math.floor(x / TILE_SIZE), z: Math.floor(z / TILE_SIZE) });
      let columns = this.editedSurfaceColumnsByTile.get(tile);
      if (!columns) this.editedSurfaceColumnsByTile.set(tile, (columns = new Set()));
      columns.add(key);
    }
  }

  private editedColumnsIn({ minX, maxX, minZ, maxZ }: SourceBounds) {
    const columns: { x: number; z: number }[] = [];
    const firstTileX = Math.floor(minX / TILE_SIZE),
      lastTileX = Math.floor((maxX - 1) / TILE_SIZE),
      firstTileZ = Math.floor(minZ / TILE_SIZE),
      lastTileZ = Math.floor((maxZ - 1) / TILE_SIZE);
    for (let tileZ = firstTileZ; tileZ <= lastTileZ; tileZ++)
      for (let tileX = firstTileX; tileX <= lastTileX; tileX++)
        for (const key of this.editedSurfaceColumnsByTile.get(keyOf({ x: tileX, z: tileZ })) ?? []) {
          const [x, z] = key.split(',').map(Number);
          if (x >= minX && x < maxX && z >= minZ && z < maxZ) columns.push({ x, z });
        }
    return columns;
  }

  private editedOverrideColumnsIn({ minX, maxX, minZ, maxZ }: SourceBounds) {
    const columns: { x: number; z: number }[] = [];
    const firstTileX = Math.floor(minX / TILE_SIZE),
      lastTileX = Math.floor((maxX - 1) / TILE_SIZE),
      firstTileZ = Math.floor(minZ / TILE_SIZE),
      lastTileZ = Math.floor((maxZ - 1) / TILE_SIZE);
    for (let tileZ = firstTileZ; tileZ <= lastTileZ; tileZ++)
      for (let tileX = firstTileX; tileX <= lastTileX; tileX++)
        for (const key of this.editedOverrideColumnsByTile.get(keyOf({ x: tileX, z: tileZ })) ?? []) {
          const [x, z] = key.split(',').map(Number);
          if (x >= minX && x < maxX && z >= minZ && z < maxZ) columns.push({ x, z });
        }
    return columns;
  }

  private editedCaveSamplesIn(bounds: SourceBounds, spacing: number, minY: number, verticalStep: number) {
    const samples = new Map<string, { x: number; y: number; z: number }>();
    for (const { x, z } of this.editedOverrideColumnsIn(bounds)) {
      for (const [y, value] of this.tileEdits.get(editColumnKey(x, z)) ?? []) {
        if (value !== null || y < minY + 2 || y > this.surfaceAt(x, z) - 3) continue;
        const layer = Math.floor((y - minY) / verticalStep);
        const key = `${Math.floor(x / spacing)},${layer},${Math.floor(z / spacing)}`;
        if (!samples.has(key)) samples.set(key, { x, y, z });
      }
    }
    return [...samples.values()];
  }

  private hasEditedOverridesIn({ minX, maxX, minZ, maxZ }: SourceBounds) {
    const firstTileX = Math.floor(minX / TILE_SIZE),
      lastTileX = Math.floor((maxX - 1) / TILE_SIZE),
      firstTileZ = Math.floor(minZ / TILE_SIZE),
      lastTileZ = Math.floor((maxZ - 1) / TILE_SIZE);
    for (let tileZ = firstTileZ; tileZ <= lastTileZ; tileZ++)
      for (let tileX = firstTileX; tileX <= lastTileX; tileX++)
        if (this.editedOverrideChunks.has(keyOf({ x: tileX, z: tileZ }))) return true;
    return false;
  }

  /** Builds one exact tile for the worker without installing it into a scene. */
  buildTileGeometry(
    level: TileLevel,
    coordinate: TileCoordinate,
    target: THREE.Vector3,
    excludedY = this.nearTileCutout?.(coordinate),
  ) {
    this.updateWindow(target);
    this.tileGeometryColumns.clear();
    if (level === 'near')
      return this.geometryBuilder.buildNearTileGeometry(coordinate, this.nearBounds(this.center!), excludedY);
    if (level === 'medium')
      return this.geometryBuilder.buildCoarseTileGeometry(
        coordinate,
        MEDIUM_CELL_SPACING,
        1,
        this.nearBounds(this.center!),
      );
    if (level === 'far')
      return this.geometryBuilder.buildCoarseTileGeometry(
        coordinate,
        FAR_CELL_SPACING,
        MEDIUM_CELL_SPACING,
        this.mediumBounds(this.mediumCenter!),
        true,
        true,
      );
    return this.geometryBuilder.buildCoarseTileGeometry(
      coordinate,
      HORIZON_CELL_SPACING,
      FAR_CELL_SPACING,
      this.farBounds(this.farCenter!),
      true,
    );
  }

  private updateWindow(target: THREE.Vector3, force = false) {
    const tileWorldSize = TILE_SIZE * this.voxelSize;
    const center = {
      x: Math.floor(target.x / tileWorldSize),
      z: Math.floor(target.z / tileWorldSize),
    };
    const verticalCenter = Math.floor(target.y / tileWorldSize);
    const cutoutMoved = Boolean(this.nearTileCutout && verticalCenter !== this.verticalCenter);
    if (this.center && keyOf(this.center) === keyOf(center) && !cutoutMoved && !force) return;
    this.verticalCenter = verticalCenter;
    this.windowRevision++;
    const previousBounds = this.center ? this.nearBounds(this.center) : null;
    const previousMediumBounds = this.mediumCenter ? this.mediumBounds(this.mediumCenter) : null;
    const previousFarBounds = this.farCenter ? this.farBounds(this.farCenter) : null;
    this.center = center;
    const currentBounds = this.nearBounds(center);
    this.desired.clear();
    for (let z = -CORE_RADIUS; z <= CORE_RADIUS; z++) {
      for (let x = -CORE_RADIUS; x <= CORE_RADIUS; x++) {
        const coordinate = { x: center.x + x, z: center.z + z };
        if (!this.tileMayContainCells(coordinate)) continue;
        this.desired.add(keyOf(coordinate));
      }
    }
    const mediumTileWorldSize = MEDIUM_TILE_SIZE * this.voxelSize;
    const mediumCenter = {
      x: Math.floor(target.x / mediumTileWorldSize),
      z: Math.floor(target.z / mediumTileWorldSize),
    };
    this.mediumCenter = mediumCenter;
    const currentMediumBounds = this.mediumBounds(mediumCenter);
    this.mediumDesired.clear();
    for (let z = -MEDIUM_TILE_RADIUS; z <= MEDIUM_TILE_RADIUS; z++) {
      for (let x = -MEDIUM_TILE_RADIUS; x <= MEDIUM_TILE_RADIUS; x++) {
        const coordinate = { x: mediumCenter.x + x, z: mediumCenter.z + z };
        if (this.coarseTileInsideBounds(coordinate, MEDIUM_CELL_SPACING, currentBounds)) continue;
        if (!this.coarseTileMayContainCells(coordinate, MEDIUM_CELL_SPACING)) continue;
        this.mediumDesired.add(keyOf(coordinate));
      }
    }
    const farTileWorldSize = FAR_TILE_SIZE * this.voxelSize;
    const farCenter = {
      x: Math.floor(target.x / farTileWorldSize),
      z: Math.floor(target.z / farTileWorldSize),
    };
    this.farCenter = farCenter;
    const currentFarBounds = this.farBounds(farCenter);
    this.farDesired.clear();
    for (let z = -FAR_TILE_RADIUS; z <= FAR_TILE_RADIUS; z++) {
      for (let x = -FAR_TILE_RADIUS; x <= FAR_TILE_RADIUS; x++) {
        const coordinate = { x: farCenter.x + x, z: farCenter.z + z };
        if (this.coarseTileInsideBounds(coordinate, FAR_CELL_SPACING, currentMediumBounds)) continue;
        if (!this.farTileMayContainCells(coordinate)) continue;
        this.farDesired.add(keyOf(coordinate));
      }
    }
    const horizonTileWorldSize = HORIZON_TILE_SIZE * this.voxelSize;
    const horizonCenter = {
      x: Math.floor(target.x / horizonTileWorldSize),
      z: Math.floor(target.z / horizonTileWorldSize),
    };
    this.horizonDesired.clear();
    for (let z = -HORIZON_TILE_RADIUS; z <= HORIZON_TILE_RADIUS; z++) {
      for (let x = -HORIZON_TILE_RADIUS; x <= HORIZON_TILE_RADIUS; x++) {
        const coordinate = { x: horizonCenter.x + x, z: horizonCenter.z + z };
        if (!this.coarseTileMayContainCells(coordinate, HORIZON_CELL_SPACING)) continue;
        this.horizonDesired.add(keyOf(coordinate));
      }
    }
    for (const [key, record] of this.resident) {
      if (!this.desired.has(key)) {
        this.removeMesh(record);
        this.resident.delete(key);
        continue;
      }
      const [x, z] = key.split(',').map(Number);
      const coordinate = { x, z };
      if (
        this.nearTileCutout ||
        (record.mesh &&
          ((previousBounds && this.nearTileTouchesBounds(coordinate, previousBounds)) ||
            this.nearTileTouchesBounds(coordinate, currentBounds)))
      )
        record.dirty = true;
    }
    for (const [key, record] of this.mediumResident) {
      if (!this.mediumDesired.has(key)) {
        this.removeMesh(record);
        this.mediumResident.delete(key);
        continue;
      }
      const [x, z] = key.split(',').map(Number);
      const coordinate = { x, z };
      if (
        record.mesh &&
        ((previousBounds &&
          this.coarseTileAffectedByBounds(coordinate, MEDIUM_CELL_SPACING, previousBounds)) ||
          this.coarseTileAffectedByBounds(coordinate, MEDIUM_CELL_SPACING, currentBounds))
      )
        record.dirty = true;
    }
    for (const [key, record] of this.farResident) {
      if (!this.farDesired.has(key)) {
        this.removeMesh(record);
        this.farResident.delete(key);
        continue;
      }
      const [x, z] = key.split(',').map(Number);
      const coordinate = { x, z };
      if (
        record.mesh &&
        ((previousMediumBounds &&
          this.coarseTileAffectedByBounds(coordinate, FAR_CELL_SPACING, previousMediumBounds)) ||
          this.coarseTileAffectedByBounds(coordinate, FAR_CELL_SPACING, currentMediumBounds))
      )
        record.dirty = true;
    }
    for (const [key, record] of this.horizonResident) {
      if (!this.horizonDesired.has(key)) {
        this.removeMesh(record);
        this.horizonResident.delete(key);
        continue;
      }
      const [x, z] = key.split(',').map(Number);
      const coordinate = { x, z };
      if (
        record.mesh &&
        ((previousFarBounds &&
          this.coarseTileAffectedByBounds(coordinate, HORIZON_CELL_SPACING, previousFarBounds)) ||
          this.coarseTileAffectedByBounds(coordinate, HORIZON_CELL_SPACING, currentFarBounds))
      )
        record.dirty = true;
    }
  }

  private nearBounds(center: TileCoordinate) {
    return {
      minX: (center.x - CORE_RADIUS) * TILE_SIZE,
      maxX: (center.x + CORE_RADIUS + 1) * TILE_SIZE,
      minZ: (center.z - CORE_RADIUS) * TILE_SIZE,
      maxZ: (center.z + CORE_RADIUS + 1) * TILE_SIZE,
    };
  }

  private farBounds(center: TileCoordinate) {
    return {
      minX: (center.x - FAR_TILE_RADIUS) * FAR_TILE_SIZE,
      maxX: (center.x + FAR_TILE_RADIUS + 1) * FAR_TILE_SIZE,
      minZ: (center.z - FAR_TILE_RADIUS) * FAR_TILE_SIZE,
      maxZ: (center.z + FAR_TILE_RADIUS + 1) * FAR_TILE_SIZE,
    };
  }

  private mediumBounds(center: TileCoordinate) {
    return {
      minX: (center.x - MEDIUM_TILE_RADIUS) * MEDIUM_TILE_SIZE,
      maxX: (center.x + MEDIUM_TILE_RADIUS + 1) * MEDIUM_TILE_SIZE,
      minZ: (center.z - MEDIUM_TILE_RADIUS) * MEDIUM_TILE_SIZE,
      maxZ: (center.z + MEDIUM_TILE_RADIUS + 1) * MEDIUM_TILE_SIZE,
    };
  }

  private coarseTileIntersectsBounds(
    { x, z }: TileCoordinate,
    spacing: number,
    bounds: ReturnType<typeof this.nearBounds>,
  ) {
    const tileSize = TILE_SIZE * spacing;
    const startX = x * tileSize;
    const startZ = z * tileSize;
    return (
      startX < bounds.maxX &&
      startX + tileSize > bounds.minX &&
      startZ < bounds.maxZ &&
      startZ + tileSize > bounds.minZ
    );
  }

  private nearTileTouchesBounds({ x, z }: TileCoordinate, bounds: ReturnType<typeof this.nearBounds>) {
    const startX = x * TILE_SIZE;
    const startZ = z * TILE_SIZE;
    return (
      ((startX === bounds.minX || startX + TILE_SIZE === bounds.maxX) &&
        startZ < bounds.maxZ &&
        startZ + TILE_SIZE > bounds.minZ) ||
      ((startZ === bounds.minZ || startZ + TILE_SIZE === bounds.maxZ) &&
        startX < bounds.maxX &&
        startX + TILE_SIZE > bounds.minX)
    );
  }

  private coarseTileAffectedByBounds(
    coordinate: TileCoordinate,
    spacing: number,
    bounds: ReturnType<typeof this.nearBounds>,
  ) {
    const margin = spacing * 2;
    const tileSize = TILE_SIZE * spacing;
    const startX = coordinate.x * tileSize;
    const startZ = coordinate.z * tileSize;
    const overlaps = (start: number, end: number, minimum: number, maximum: number) =>
      start < maximum && end > minimum;
    const touchesTransitionStrip = (start: number, end: number, minimum: number, maximum: number) =>
      overlaps(start, end, minimum - margin, minimum) || overlaps(start, end, maximum, maximum + margin);
    return (
      this.coarseTileIntersectsBounds(coordinate, spacing, bounds) ||
      touchesTransitionStrip(startX, startX + tileSize, bounds.minX, bounds.maxX) ||
      touchesTransitionStrip(startZ, startZ + tileSize, bounds.minZ, bounds.maxZ)
    );
  }

  private coarseTileInsideBounds(
    { x, z }: TileCoordinate,
    spacing: number,
    bounds: ReturnType<typeof this.nearBounds>,
  ) {
    const tileSize = TILE_SIZE * spacing;
    const startX = x * tileSize;
    const startZ = z * tileSize;
    return (
      startX >= bounds.minX &&
      startX + tileSize <= bounds.maxX &&
      startZ >= bounds.minZ &&
      startZ + tileSize <= bounds.maxZ
    );
  }

  private tileMayContainCells({ x, z }: TileCoordinate) {
    const startX = x * TILE_SIZE;
    const startZ = z * TILE_SIZE;
    const [originX, originZ] = this.world.generator.origin;
    const [width, depth] = this.world.generator.size;
    const intersectsGenerator =
      startX <= originX + width - 1 &&
      startX + TILE_SIZE - 1 >= originX &&
      startZ <= originZ + depth - 1 &&
      startZ + TILE_SIZE - 1 >= originZ;
    if (intersectsGenerator) return true;
    return this.editedTiles.has(keyOf({ x, z }));
  }

  private farTileMayContainCells({ x, z }: TileCoordinate) {
    return this.coarseTileMayContainCells({ x, z }, FAR_CELL_SPACING);
  }

  private coarseTileMayContainCells({ x, z }: TileCoordinate, spacing: number) {
    const tileSize = TILE_SIZE * spacing;
    const startX = x * tileSize;
    const startZ = z * tileSize;
    const [originX, originZ] = this.world.generator.origin;
    const [width, depth] = this.world.generator.size;
    const intersectsGenerator =
      startX <= originX + width - 1 &&
      startX + tileSize - 1 >= originX &&
      startZ <= originZ + depth - 1 &&
      startZ + tileSize - 1 >= originZ;
    if (intersectsGenerator) return true;
    const firstTileX = x * spacing;
    const firstTileZ = z * spacing;
    for (let tileZ = 0; tileZ < spacing; tileZ++)
      for (let tileX = 0; tileX < spacing; tileX++)
        if (this.editedTiles.has(keyOf({ x: firstTileX + tileX, z: firstTileZ + tileZ }))) return true;
    return false;
  }

  private buildOneTile() {
    const request = this.nextTileRequest();
    if (!request) return;
    const startedAt = performance.now();
    this.installTileGeometry(
      request,
      this.buildTileGeometry(request.level, request.coordinate, this.latestTarget),
    );
    this.recordTileBuildDuration(request.level, startedAt);
  }

  private nextTileRequest(): TileRequest | null {
    const candidates: PendingTileRequest[] = [];
    const collect = (
      level: TileLevel,
      desired: Set<string>,
      residents: Map<string, TileRecord>,
      spacing: number,
      excludedBounds?: ReturnType<WorldStreamRenderer['nearBounds']>,
    ) => {
      for (const key of desired) {
        const record = residents.get(key);
        if (record && !record.dirty) continue;
        const coordinate = this.coordinateFromKey(key);
        candidates.push({
          level,
          coordinate,
          distanceSquared: this.tileDistanceSquared(coordinate, spacing, excludedBounds),
          centered: this.tileIsCurrentCenter(coordinate, spacing),
          dirty: Boolean(record?.dirty),
          visible: this.tileInView(coordinate, spacing),
        });
      }
    };
    collect('near', this.desired, this.resident, 1);
    collect(
      'medium',
      this.mediumDesired,
      this.mediumResident,
      MEDIUM_CELL_SPACING,
      this.nearBounds(this.center!),
    );
    collect(
      'far',
      this.farDesired,
      this.farResident,
      FAR_CELL_SPACING,
      this.mediumBounds(this.mediumCenter!),
    );
    collect(
      'horizon',
      this.horizonDesired,
      this.horizonResident,
      HORIZON_CELL_SPACING,
      this.farBounds(this.farCenter!),
    );
    const levelOrder: Record<TileLevel, number> = { near: 0, medium: 1, far: 2, horizon: 3 };
    candidates.sort(
      (a, b) =>
        Number(b.visible) - Number(a.visible) ||
        a.distanceSquared - b.distanceSquared ||
        levelOrder[a.level] - levelOrder[b.level] ||
        Number(b.centered) - Number(a.centered) ||
        Number(b.dirty) - Number(a.dirty) ||
        a.coordinate.z - b.coordinate.z ||
        a.coordinate.x - b.coordinate.x,
    );
    const candidate = candidates[0];
    return candidate ? { level: candidate.level, coordinate: candidate.coordinate } : null;
  }

  private tileInView({ x, z }: TileCoordinate, spacing: number) {
    if (!this.hasViewFrustum) return true;
    const tileSize = TILE_SIZE * spacing * this.voxelSize;
    const padding = this.voxelSize / 2;
    const { generator } = this.world;
    this.frustumBounds.min.set(
      x * tileSize - padding,
      generator.minY * this.voxelSize - padding,
      z * tileSize - padding,
    );
    this.frustumBounds.max.set(
      (x + 1) * tileSize + padding,
      generator.maxY * this.voxelSize + padding,
      (z + 1) * tileSize + padding,
    );
    return this.viewFrustum.intersectsBox(this.frustumBounds);
  }

  private coordinateFromKey(key: string): TileCoordinate {
    const [x, z] = key.split(',').map(Number);
    return { x, z };
  }

  private installTileGeometry(
    { level, coordinate: { x, z } }: TileRequest,
    geometry: THREE.BufferGeometry | null,
  ) {
    const key = keyOf({ x, z });
    let record: TileRecord;
    if (level === 'near') {
      record = this.resident.get(key) ?? { mesh: null };
      this.resident.set(key, record);
    } else {
      const residents =
        level === 'medium' ? this.mediumResident : level === 'far' ? this.farResident : this.horizonResident;
      record = residents.get(key) ?? { mesh: null, dirty: false };
      residents.set(key, record as FarTileRecord);
    }
    this.removeMesh(record);
    record.dirty = false;
    if (!geometry) return;

    const mesh = new THREE.Mesh(geometry, this.materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    if (level === 'near') {
      mesh.scale.setScalar(this.voxelSize);
      mesh.position.set(x * TILE_SIZE * this.voxelSize, 0, z * TILE_SIZE * this.voxelSize);
      mesh.userData.worldTile = { x, z };
    } else {
      const spacing =
        level === 'medium' ? MEDIUM_CELL_SPACING : level === 'far' ? FAR_CELL_SPACING : HORIZON_CELL_SPACING;
      const tileSize = TILE_SIZE * spacing;
      mesh.scale.set(spacing * this.voxelSize, this.voxelSize, spacing * this.voxelSize);
      mesh.position.set(x * tileSize * this.voxelSize, 0, z * tileSize * this.voxelSize);
      mesh.userData[
        level === 'medium' ? 'worldMediumTile' : level === 'far' ? 'worldFarTile' : 'worldHorizonTile'
      ] = { x, z };
    }
    mesh.userData.worldLod = level;
    record.mesh = mesh;
    this.group.add(mesh);
  }

  private requestWorkerTile() {
    if (this.disposed || this.workerFailed || this.workerPending) return;
    const request = this.nextTileRequest();
    if (!request) return;
    try {
      this.worker ??= this.createWorker!();
      this.worker.onmessage = (event: MessageEvent<TileBuildResponse>) => this.receiveWorkerTile(event.data);
      this.worker.onerror = () => this.failWorker();
      const id = ++this.workerRequestId;
      const revision = this.windowRevision;
      const message: TileBuildRequest = {
        id,
        revision,
        level: request.level,
        coordinate: request.coordinate,
        target: this.latestTarget.toArray() as [number, number, number],
        ...(request.level === 'near' && { excludedY: this.nearTileCutout?.(request.coordinate) }),
        ...(!this.workerSentWorld && {
          world: { ...this.world, edits: [...this.currentEdits.values()] },
        }),
        ...(this.workerSentWorld &&
          this.workerEditUpdates.size > 0 && {
            edits: [...this.workerEditUpdates.values()].filter((edit): edit is WorldEdit => edit !== null),
            clearedEdits: [...this.workerEditUpdates.entries()]
              .filter(([, edit]) => edit === null)
              .map(([key]) => {
                const [x, y, z] = key.split(',').map(Number);
                return { x, y, z };
              }),
          }),
      };
      this.workerPending = { id, revision, level: request.level, coordinate: request.coordinate };
      this.worker.postMessage(message);
      if (!this.workerSentWorld) {
        this.workerKnownEdits.clear();
        for (const edit of this.currentEdits.values()) this.workerKnownEdits.set(cellKey(edit), edit);
      } else {
        for (const [key, edit] of this.workerEditUpdates) {
          if (edit === null) this.workerKnownEdits.delete(key);
          else this.workerKnownEdits.set(key, edit);
        }
      }
      this.workerEditUpdates.clear();
      this.workerSentWorld = true;
    } catch {
      this.failWorker();
      this.buildOneTile();
    }
  }

  private receiveWorkerTile(response: TileBuildResponse) {
    const pending = this.workerPending;
    if (this.disposed || !pending || response.id !== pending.id) return;
    this.workerPending = null;
    if (response.error) {
      this.failWorker();
      return;
    }
    if (
      response.level !== pending.level ||
      response.coordinate.x !== pending.coordinate.x ||
      response.coordinate.z !== pending.coordinate.z
    ) {
      this.failWorker();
      return;
    }
    if (response.revision !== this.windowRevision) {
      this.requestWorkerTile();
      return;
    }
    const key = keyOf(response.coordinate);
    const desired =
      response.level === 'near'
        ? this.desired
        : response.level === 'medium'
          ? this.mediumDesired
          : response.level === 'far'
            ? this.farDesired
            : this.horizonDesired;
    if (!desired.has(key)) {
      this.requestWorkerTile();
      return;
    }
    this.recordDuration(this.workerBuildDurations[response.level], response.meshMs);
    const installStarted = performance.now();
    this.installTileGeometry(
      { level: response.level, coordinate: response.coordinate },
      response.geometry ? deserializeTileGeometry(response.geometry) : null,
    );
    this.recordTileInstallDuration(response.level, installStarted);
    this.requestWorkerTile();
  }

  private failWorker() {
    this.terminateWorker();
    this.workerPending = null;
    this.workerSentWorld = false;
    this.workerKnownEdits.clear();
    this.workerEditUpdates.clear();
    this.workerFailed = true;
  }

  private terminateWorker() {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  private queueWorkerEdit(key: string, edit: WorldEdit | null) {
    if (!this.workerSentWorld || this.workerFailed) return;
    const known = this.workerKnownEdits.get(key);
    if (edit === null ? known === undefined : sameEdit(known, edit)) this.workerEditUpdates.delete(key);
    else this.workerEditUpdates.set(key, edit);
  }

  private recordDuration(samples: number[], duration: number) {
    samples.push(duration);
    if (samples.length > 256) samples.shift();
  }

  private recordTileBuildDuration(level: TileLevel, startedAt: number) {
    this.recordDuration(this.tileBuildDurations[level], performance.now() - startedAt);
  }

  private recordTileInstallDuration(level: TileLevel, startedAt: number) {
    this.recordDuration(this.tileInstallDurations[level], performance.now() - startedAt);
  }

  private tileDistanceSquared(
    { x, z }: TileCoordinate,
    spacing: number,
    excludedBounds?: ReturnType<WorldStreamRenderer['nearBounds']>,
  ) {
    const tileSize = TILE_SIZE * spacing * this.voxelSize;
    const tile = {
      minX: x * tileSize,
      maxX: (x + 1) * tileSize,
      minZ: z * tileSize,
      maxZ: (z + 1) * tileSize,
    };
    const distanceToRect = (minX: number, maxX: number, minZ: number, maxZ: number) => {
      if (minX > maxX || minZ > maxZ) return Infinity;
      const dx = Math.max(minX - this.latestTarget.x, 0, this.latestTarget.x - maxX);
      const dz = Math.max(minZ - this.latestTarget.z, 0, this.latestTarget.z - maxZ);
      return dx * dx + dz * dz;
    };
    if (!excludedBounds) return distanceToRect(tile.minX, tile.maxX, tile.minZ, tile.maxZ);

    const inner = {
      minX: excludedBounds.minX * this.voxelSize,
      maxX: excludedBounds.maxX * this.voxelSize,
      minZ: excludedBounds.minZ * this.voxelSize,
      maxZ: excludedBounds.maxZ * this.voxelSize,
    };
    if (
      inner.maxX <= tile.minX ||
      inner.minX >= tile.maxX ||
      inner.maxZ <= tile.minZ ||
      inner.minZ >= tile.maxZ
    )
      return distanceToRect(tile.minX, tile.maxX, tile.minZ, tile.maxZ);

    return Math.min(
      distanceToRect(tile.minX, Math.min(tile.maxX, inner.minX), tile.minZ, tile.maxZ),
      distanceToRect(Math.max(tile.minX, inner.maxX), tile.maxX, tile.minZ, tile.maxZ),
      distanceToRect(Math.max(tile.minX, inner.minX), Math.min(tile.maxX, inner.maxX), tile.minZ, inner.minZ),
      distanceToRect(Math.max(tile.minX, inner.minX), Math.min(tile.maxX, inner.maxX), inner.maxZ, tile.maxZ),
    );
  }

  private tileIsCurrentCenter({ x, z }: TileCoordinate, spacing: number) {
    const tileSize = TILE_SIZE * spacing * this.voxelSize;
    return (
      x === Math.floor(this.latestTarget.x / tileSize) && z === Math.floor(this.latestTarget.z / tileSize)
    );
  }

  private tileGeometryColumns = new Map<string, ColumnBand[]>();
  private readonly geometryBuilder: WorldStreamGeometryBuilder;
  private readonly viewFrustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly frustumBounds = new THREE.Box3();
  private hasViewFrustum = false;

  private columnAt(x: number, z: number) {
    const key = editColumnKey(x, z);
    const cached = this.tileGeometryColumns.get(key);
    if (cached) return cached;

    const { generator } = this.world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    let surface: number | null = null;
    if (x >= originX && x < originX + width && z >= originZ && z < originZ + depth) {
      surface = this.surfaceAt(x, z);
    }

    const edits = this.tileEdits.get(key);
    const palette = surface === null ? generator.palette : this.paletteAt(x, z);
    const breakpoints = new Set<number>();
    if (surface !== null) {
      breakpoints.add(generator.minY);
      breakpoints.add(surface + 1);
      breakpoints.add(Math.max(generator.minY, surface - palette.surfaceDepth + 1));
      breakpoints.add(Math.max(generator.minY, surface - palette.surfaceDepth - palette.subsurfaceDepth + 1));
    }
    if (edits)
      for (const y of edits.keys()) {
        breakpoints.add(y);
        breakpoints.add(y + 1);
      }
    const sorted = [...breakpoints].sort((a, b) => a - b);
    const bands: ColumnBand[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
      const start = sorted[i];
      const end = sorted[i + 1];
      if (end <= start) continue;
      let value: WorldCell | null | undefined;
      if (edits?.has(start)) value = edits.get(start);
      else if (surface !== null && start >= generator.minY && start <= surface) {
        const layer = surface - start;
        value = {
          color:
            layer < palette.surfaceDepth
              ? palette.surface
              : layer < palette.surfaceDepth + palette.subsurfaceDepth
                ? palette.subsurface
                : palette.deep,
          materialType: palette.materialType,
        };
      }
      if (!value) continue;
      const previous = bands.at(-1);
      if (
        previous &&
        previous.end === start &&
        previous.value.color === value.color &&
        previous.value.materialType === value.materialType
      )
        previous.end = end;
      else bands.push({ start, end, value });
    }
    this.tileGeometryColumns.set(key, bands);
    return bands;
  }

  // Coarse max scans need only the top block; avoid allocating full bands per source cell.
  private columnTopAt(x: number, z: number) {
    const { generator } = this.world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    const surface =
      x >= originX && x < originX + width && z >= originZ && z < originZ + depth
        ? this.surfaceAt(x, z)
        : null;
    const edits = this.tileEdits.get(editColumnKey(x, z));
    const overhangHeight =
      generator.mode !== 'voxel3d'
        ? 0
        : generator.overhangHeightMap
          ? sampleTerrainOverhangHeightMap(this.world, x, z)
          : (generator.overhangDensity ?? 0) > 0
            ? (generator.overhangMaxHeight ?? TERRAIN_OVERHANG_DEFAULT_MAX_HEIGHT)
            : 0;
    let top = surface === null ? null : Math.min(generator.maxY, surface + overhangHeight);
    while (top !== null && top >= generator.minY) {
      const edit = edits?.get(top);
      // Coarse LOD must not close a generated voxel3d shaft; explicit sparse edits still win.
      if (edit === undefined ? !this.volumeAt || this.volumeAt(x, top, z) : edit !== null) break;
      top--;
    }
    if (top !== null && top < generator.minY) top = null;
    for (const [y, value] of edits ?? []) if (value && (top === null || y > top)) top = y;
    if (top === null) return null;

    const editedValue = edits?.get(top);
    if (editedValue) return { top, value: editedValue };
    const palette = surface === null ? generator.palette : this.paletteAt(x, z);
    const layer = surface! - top;
    return {
      top,
      value: {
        color:
          layer < palette.surfaceDepth
            ? palette.surface
            : layer < palette.surfaceDepth + palette.subsurfaceDepth
              ? palette.subsurface
              : palette.deep,
        materialType: palette.materialType,
      },
    };
  }

  private removeMesh(record: TileRecord) {
    if (!record.mesh) return;
    this.group.remove(record.mesh);
    record.mesh.geometry.dispose();
    record.mesh = null;
  }

  stats() {
    const coarseMeshes = [
      ...this.mediumResident.values(),
      ...this.farResident.values(),
      ...this.horizonResident.values(),
    ]
      .map((tile) => tile.mesh)
      .filter((mesh): mesh is THREE.Mesh => mesh !== null);
    const residentCoarseBufferBytes = coarseMeshes.reduce((total, mesh) => {
      return total + geometryArrayBytes(mesh.geometry);
    }, 0);
    const residentGeometryArrayBytes = [
      ...this.resident.values(),
      ...this.mediumResident.values(),
      ...this.farResident.values(),
      ...this.horizonResident.values(),
    ].reduce((total, tile) => total + (tile.mesh ? geometryArrayBytes(tile.mesh.geometry) : 0), 0);
    return {
      worldId: this.world.id,
      residentChunks: this.resident.size,
      loadedChunks: this.resident.size,
      renderedChunks: [...this.resident.values()].filter((tile) => tile.mesh).length,
      renderChunkSize: TILE_SIZE,
      maximumResidentChunks: MAXIMUM_RESIDENT_TILES,
      residentMediumChunks: this.mediumResident.size,
      renderedMediumChunks: [...this.mediumResident.values()].filter((tile) => tile.mesh).length,
      maximumResidentMediumChunks: MAXIMUM_RESIDENT_MEDIUM_TILES,
      residentFarChunks: this.farResident.size,
      renderedFarChunks: [...this.farResident.values()].filter((tile) => tile.mesh).length,
      maximumResidentFarChunks: MAXIMUM_RESIDENT_FAR_TILES,
      residentHorizonChunks: this.horizonResident.size,
      renderedHorizonChunks: [...this.horizonResident.values()].filter((tile) => tile.mesh).length,
      maximumResidentHorizonChunks: MAXIMUM_RESIDENT_HORIZON_TILES,
      residentGeometries: [
        ...this.resident.values(),
        ...this.mediumResident.values(),
        ...this.farResident.values(),
        ...this.horizonResident.values(),
      ].filter((tile) => tile.mesh).length,
      maximumResidentGeometries: MAXIMUM_RESIDENT_GEOMETRIES,
      residentCoarseBufferBytes,
      residentGeometryArrayBytes,
      updateMs: summarizeDurations(this.updateDurations),
      maximumCoarseBufferBytesPerTile: MAXIMUM_COARSE_TILE_BUFFER_BYTES,
      maximumResidentCoarseBufferBytes: MAXIMUM_RESIDENT_COARSE_BUFFER_BYTES,
      tileBuildMs: Object.fromEntries(
        Object.entries(this.tileBuildDurations).map(([level, samples]) => [
          level,
          summarizeDurations(samples),
        ]),
      ),
      workerTileBuildMs: Object.fromEntries(
        Object.entries(this.workerBuildDurations).map(([level, samples]) => [
          level,
          summarizeDurations(samples),
        ]),
      ),
      tileInstallMs: Object.fromEntries(
        Object.entries(this.tileInstallDurations).map(([level, samples]) => [
          level,
          summarizeDurations(samples),
        ]),
      ),
      verticalMode: 'heightfield' as const,
    };
  }

  dispose() {
    this.disposed = true;
    this.terminateWorker();
    this.workerPending = null;
    for (const record of this.resident.values()) this.removeMesh(record);
    this.resident.clear();
    for (const record of this.mediumResident.values()) this.removeMesh(record);
    this.mediumResident.clear();
    for (const record of this.farResident.values()) this.removeMesh(record);
    this.farResident.clear();
    for (const record of this.horizonResident.values()) this.removeMesh(record);
    this.horizonResident.clear();
    this.materials.forEach((material) => material.dispose());
    this.group.removeFromParent();
  }
}
