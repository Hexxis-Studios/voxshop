import * as THREE from 'three';
import type { Asset } from '../services/projectDocument';
import {
  createTerrainCaveNetworkPath,
  createTerrainSurfaceSampler,
  terrainCaveNetworkBranchContains,
  terrainCaveNetworkBranches,
  terrainCaveNetworkContains,
  terrainCaveBranches,
  terrainCaveCenterY,
  type TerrainCaveBranch,
  type TerrainCaveNetworkBranch,
  type TerrainCaveNetworkPath,
} from '../services/terrainNoise';
import {
  createWorldCellSampler,
  createWorldChunkStore,
  type WorldDocument,
  type WorldEdit,
} from '../services/worldDocument';
import { createVoxelMaterials } from './assetMesh';
import { geometryArrayBytes } from './geometryArrayBytes';
import { createVoxelGeometryChunks, VOXEL_MATERIALS } from './voxelGeometry';
import {
  buildCoarseWorldVoxelChunk,
  FAR_WORLD_VOXEL_LOD_FACTOR,
  ULTRA_FAR_WORLD_VOXEL_LOD_FACTOR,
  VERY_FAR_WORLD_VOXEL_LOD_FACTOR,
  WORLD_VOXEL_LOD_FACTOR,
  type WorldVoxelLodFactor,
} from './worldVoxelLod';
import { WorldStreamRenderer } from './WorldStreamRenderer';
import { sameEdit, summarizeDurations } from './worldRenderHelpers';
import { deserializeVoxelChunkGeometry } from './worldVoxelWorkerProtocol';
import type {
  VoxelChunkBuildRequest,
  VoxelChunkBuildResponse,
  VoxelChunkCoordinate,
} from './worldVoxelWorkerProtocol';

const HORIZONTAL_RADIUS = 1;
const VERTICAL_RADIUS = 1;
const RENDER_CHUNK_SIZE = 16;
const CAVE_LOD_NEAR_RADIUS = 3;
const CAVE_LOD_NEAR_VERTICAL_RADIUS = VERTICAL_RADIUS + 1;
const CAVE_LOD_FAR_RADIUS = 9;
const CAVE_LOD_VERY_FAR_RADIUS = 12;
const CAVE_LOD_ULTRA_FAR_RADIUS = 16;
const MAXIMUM_RESIDENT_CAVE_LOD_CHUNKS =
  ((CAVE_LOD_NEAR_RADIUS * 2 + 1) ** 2 - (HORIZONTAL_RADIUS * 2 + 1) ** 2) *
    (CAVE_LOD_NEAR_VERTICAL_RADIUS * 2 + 1) +
  (CAVE_LOD_FAR_RADIUS * 2 + 1) ** 2 -
  (CAVE_LOD_NEAR_RADIUS * 2 + 1) ** 2 +
  (CAVE_LOD_VERY_FAR_RADIUS * 2 + 1) ** 2 -
  (CAVE_LOD_FAR_RADIUS * 2 + 1) ** 2 +
  (CAVE_LOD_ULTRA_FAR_RADIUS * 2 + 1) ** 2 -
  (CAVE_LOD_VERY_FAR_RADIUS * 2 + 1) ** 2;
const keyOf = ({ x, y, z }: { x: number; y: number; z: number }) => `${x},${y},${z}`;
const tileKeyOf = ({ x, z }: { x: number; z: number }) => `${x},${z}`;
type ChunkCoordinate = VoxelChunkCoordinate;
type ResidentChunk = { mesh: THREE.Mesh | null };
type EditPosition = Pick<WorldEdit, 'x' | 'y' | 'z'>;
type QueuedWorkerEdit = WorldEdit | null;
type CoarseBoundarySide = { name: 'left' | 'right' | 'back' | 'front'; axis: 'x' | 'z'; direction: -1 | 1 };
type PendingChunk = {
  coordinate: ChunkCoordinate;
  distanceSquared: number;
  centered: boolean;
  dirty: boolean;
};
const editKey = ({ x, y, z }: EditPosition) => `${x},${y},${z}`;
function sameWorldExceptEdits(first: WorldDocument, second: WorldDocument) {
  return JSON.stringify({ ...first, edits: [] }) === JSON.stringify({ ...second, edits: [] });
}
export type WorldVoxelChunkBuild = {
  geometry: THREE.BufferGeometry;
  voxelCellCount: number;
  hasCaveFaces: boolean;
};

/** Streams nearby 3D voxel chunks and retains the heightfield's distant terrain silhouette. */
export class WorldVoxelRenderer {
  readonly group = new THREE.Group();
  private readonly chunks;
  private cellAt;
  private surfaceAt;
  private readonly caveBranches: TerrainCaveBranch[];
  private readonly caveNetworkPath: TerrainCaveNetworkPath | null;
  private readonly caveNetworkBranches: TerrainCaveNetworkBranch[];
  private readonly materials = createVoxelMaterials();
  private readonly caveMaterial = this.materials[0].clone();
  private readonly editedChunks = new Set<string>();
  private readonly excludedNearTiles = new Set<string>();
  private readonly caveLodTiles = new Map<string, [number, number]>();
  private readonly resident = new Map<string, ResidentChunk>();
  private readonly caveLodResident = new Map<string, ResidentChunk>();
  private readonly desired = new Set<string>();
  private readonly caveLodDesired = new Map<string, WorldVoxelLodFactor>();
  private readonly dirtyChunks = new Set<string>();
  private readonly dirtyCaveLodChunks = new Set<string>();
  private readonly distantTerrain: WorldStreamRenderer;
  private center: ChunkCoordinate | null = null;
  private caveLodEnabled = false;
  private synchronousCaveLodTurn = true;
  private worker: Worker | null = null;
  private workerPending: {
    id: number;
    revision: number;
    coordinate: ChunkCoordinate;
    coarseFactor?: WorldVoxelLodFactor;
  } | null = null;
  private workerSentWorld = false;
  private workerFailed = false;
  private readonly workerKnownEdits = new Map<string, WorldEdit>();
  private readonly workerEditUpdates = new Map<string, QueuedWorkerEdit>();
  private workerRequestId = 0;
  private windowRevision = 0;
  private disposed = false;
  private readonly latestTarget = new THREE.Vector3();
  private readonly workerBuildDurations: number[] = [];
  private readonly chunkInstallDurations: number[] = [];
  private readonly caveLodChunkBuildDurations: number[] = [];
  private readonly caveLodChunkInstallDurations: number[] = [];
  private readonly updateDurations: number[] = [];

  static view(world: WorldDocument) {
    return WorldStreamRenderer.view(world);
  }

  constructor(
    private readonly scene: THREE.Scene,
    private world: WorldDocument,
    private readonly createWorker?: () => Worker,
    createTerrainWorker?: () => Worker,
  ) {
    this.chunks = createWorldChunkStore(world);
    this.cellAt = createWorldCellSampler(world);
    this.surfaceAt = createTerrainSurfaceSampler(world);
    this.caveBranches = terrainCaveBranches(world);
    this.caveNetworkPath = createTerrainCaveNetworkPath(world);
    this.caveNetworkBranches = terrainCaveNetworkBranches(world, this.caveNetworkPath);
    this.caveMaterial.emissive.set(0xffffff);
    this.caveMaterial.emissiveIntensity = 0.04;
    for (const edit of world.edits)
      if (edit.value)
        this.editedChunks.add(
          `${Math.floor(edit.x / RENDER_CHUNK_SIZE)},${Math.floor(edit.y / RENDER_CHUNK_SIZE)},${Math.floor(edit.z / RENDER_CHUNK_SIZE)}`,
        );
    this.group.name = `voxel-world:${world.id}`;
    scene.add(this.group);
    this.distantTerrain = new WorldStreamRenderer(
      scene,
      world,
      (tile) => {
        if (!this.center) return undefined;
        const key = tileKeyOf(tile);
        const caveLodBounds = this.caveLodTiles.get(key);
        if (caveLodBounds) return caveLodBounds;
        return this.excludedNearTiles.has(key)
          ? [
              (this.center.y - VERTICAL_RADIUS) * RENDER_CHUNK_SIZE,
              (this.center.y + VERTICAL_RADIUS + 1) * RENDER_CHUNK_SIZE,
            ]
          : undefined;
      },
      createTerrainWorker,
    );
  }

  update(target: THREE.Vector3, camera?: THREE.Camera) {
    if (this.disposed) return;
    const startedAt = performance.now();
    try {
      this.latestTarget.copy(target);
      const cellSize = this.world.voxelSize;
      const viewerPosition = camera?.position ?? target;
      const center = {
        x: Math.floor(target.x / cellSize / RENDER_CHUNK_SIZE),
        y: Math.floor(target.y / cellSize / RENDER_CHUNK_SIZE),
        z: Math.floor(target.z / cellSize / RENDER_CHUNK_SIZE),
      };
      const viewerCell = {
        x: Math.floor(viewerPosition.x / cellSize),
        y: Math.floor(viewerPosition.y / cellSize),
        z: Math.floor(viewerPosition.z / cellSize),
      };
      const underground =
        this.world.generator.mode === 'voxel3d' &&
        viewerCell.y < this.surfaceAt(viewerCell.x, viewerCell.z) - 1;
      const caveLodChanged = underground !== this.caveLodEnabled;
      if (caveLodChanged) this.caveLodEnabled = underground;
      if (!this.center || keyOf(center) !== keyOf(this.center) || caveLodChanged) {
        this.center = center;
        this.windowRevision++;
        this.updateDesiredWindow(center);
      }

      this.distantTerrain.update(target, camera, false, caveLodChanged);
      if (this.createWorker && !this.workerFailed) {
        if (this.requestWorkerChunk()) {
          this.distantTerrain.update(target, camera);
          return;
        }
      } else {
        if (this.buildOneChunk()) return;
        if (this.synchronousCaveLodTurn && this.buildOneCaveLodChunk()) {
          this.synchronousCaveLodTurn = false;
          return;
        }
        this.synchronousCaveLodTurn = true;
        this.distantTerrain.update(target, camera);
        return;
      }
      if (this.buildOneCaveLodChunk()) return;
      this.distantTerrain.update(target, camera);
    } finally {
      this.recordDuration(this.updateDurations, performance.now() - startedAt);
    }
  }

  /** Applies a sparse edit snapshot while keeping resident meshes and the streamed window. */
  updateWorld(nextWorld: WorldDocument) {
    if (!sameWorldExceptEdits(this.world, nextWorld))
      throw new Error('A voxel renderer can only update sparse edits on the same world descriptor.');
    const previousEdits = new Map(this.world.edits.map((edit) => [editKey(edit), edit]));
    const nextEdits = new Map(nextWorld.edits.map((edit) => [editKey(edit), edit]));
    const changed: EditPosition[] = [];
    for (const key of new Set([...previousEdits.keys(), ...nextEdits.keys()])) {
      const previous = previousEdits.get(key),
        next = nextEdits.get(key);
      if (!sameEdit(previous, next)) {
        changed.push(next ?? previous!);
        this.queueWorkerEdit(key, next ?? null);
      }
    }
    if (!changed.length) {
      this.world = nextWorld;
      return;
    }
    this.replaceWorld(nextWorld, changed);
    this.windowRevision++;
    if (this.center) this.updateDesiredWindow(this.center);
    for (const position of changed) this.markResidentChunksDirty(position);
  }

  /** Applies incremental edit data received by the module worker before it builds a chunk. */
  applyWorldEditPatch(edits: readonly WorldEdit[], clearedEdits: readonly EditPosition[]) {
    if (!edits.length && !clearedEdits.length) return;
    const nextEdits = new Map(this.world.edits.map((edit) => [editKey(edit), edit]));
    const changed: EditPosition[] = [];
    for (const position of clearedEdits) {
      const key = editKey(position);
      if (nextEdits.delete(key)) changed.push(position);
    }
    for (const edit of edits) {
      const key = editKey(edit);
      if (!sameEdit(nextEdits.get(key), edit)) {
        nextEdits.set(key, edit);
        changed.push(edit);
      }
    }
    if (changed.length) this.replaceWorld({ ...this.world, edits: [...nextEdits.values()] }, changed);
  }

  private replaceWorld(nextWorld: WorldDocument, changed: readonly EditPosition[]) {
    this.world = nextWorld;
    this.chunks.restoreEdits(nextWorld.edits);
    this.cellAt = createWorldCellSampler(nextWorld);
    this.surfaceAt = createTerrainSurfaceSampler(nextWorld);
    this.editedChunks.clear();
    for (const edit of nextWorld.edits)
      if (edit.value)
        this.editedChunks.add(
          `${Math.floor(edit.x / RENDER_CHUNK_SIZE)},${Math.floor(edit.y / RENDER_CHUNK_SIZE)},${Math.floor(edit.z / RENDER_CHUNK_SIZE)}`,
        );
    this.distantTerrain.updateWorldEdits(nextWorld.edits, changed);
  }

  private updateDesiredWindow(center: ChunkCoordinate) {
    this.desired.clear();
    this.caveLodDesired.clear();
    this.excludedNearTiles.clear();
    this.caveLodTiles.clear();
    for (let z = -HORIZONTAL_RADIUS; z <= HORIZONTAL_RADIUS; z++)
      for (let x = -HORIZONTAL_RADIUS; x <= HORIZONTAL_RADIUS; x++)
        this.excludedNearTiles.add(`${center.x + x},${center.z + z}`);
    for (let y = -VERTICAL_RADIUS; y <= VERTICAL_RADIUS; y++)
      for (let z = -HORIZONTAL_RADIUS; z <= HORIZONTAL_RADIUS; z++)
        for (let x = -HORIZONTAL_RADIUS; x <= HORIZONTAL_RADIUS; x++) {
          const coordinate = { x: center.x + x, y: center.y + y, z: center.z + z };
          if (this.chunkMayContainCells(coordinate)) this.desired.add(keyOf(coordinate));
        }
    if (this.caveLodEnabled) {
      for (let y = -CAVE_LOD_NEAR_VERTICAL_RADIUS; y <= CAVE_LOD_NEAR_VERTICAL_RADIUS; y++)
        for (let z = -CAVE_LOD_NEAR_RADIUS; z <= CAVE_LOD_NEAR_RADIUS; z++)
          for (let x = -CAVE_LOD_NEAR_RADIUS; x <= CAVE_LOD_NEAR_RADIUS; x++) {
            if (Math.max(Math.abs(x), Math.abs(z)) <= HORIZONTAL_RADIUS) continue;
            const coordinate = { x: center.x + x, y: center.y + y, z: center.z + z };
            const tileKey = tileKeyOf(coordinate);
            this.caveLodTiles.set(tileKey, [
              (center.y - CAVE_LOD_NEAR_VERTICAL_RADIUS) * RENDER_CHUNK_SIZE,
              (center.y + CAVE_LOD_NEAR_VERTICAL_RADIUS + 1) * RENDER_CHUNK_SIZE,
            ]);
            this.excludedNearTiles.add(tileKey);
            if (this.chunkMayContainCells(coordinate))
              this.caveLodDesired.set(keyOf(coordinate), WORLD_VOXEL_LOD_FACTOR);
          }
      for (let z = -CAVE_LOD_FAR_RADIUS; z <= CAVE_LOD_FAR_RADIUS; z++)
        for (let x = -CAVE_LOD_FAR_RADIUS; x <= CAVE_LOD_FAR_RADIUS; x++) {
          if (Math.max(Math.abs(x), Math.abs(z)) <= CAVE_LOD_NEAR_RADIUS) continue;
          const coordinate = { x: center.x + x, y: center.y, z: center.z + z };
          const key = keyOf(coordinate);
          const tileKey = tileKeyOf(coordinate);
          this.caveLodTiles.set(tileKey, [center.y * RENDER_CHUNK_SIZE, (center.y + 1) * RENDER_CHUNK_SIZE]);
          this.excludedNearTiles.add(tileKey);
          if (this.chunkMayContainCells(coordinate)) this.caveLodDesired.set(key, FAR_WORLD_VOXEL_LOD_FACTOR);
        }
      for (let z = -CAVE_LOD_VERY_FAR_RADIUS; z <= CAVE_LOD_VERY_FAR_RADIUS; z++)
        for (let x = -CAVE_LOD_VERY_FAR_RADIUS; x <= CAVE_LOD_VERY_FAR_RADIUS; x++) {
          if (Math.max(Math.abs(x), Math.abs(z)) <= CAVE_LOD_FAR_RADIUS) continue;
          const coordinate = { x: center.x + x, y: center.y, z: center.z + z };
          const key = keyOf(coordinate);
          const tileKey = tileKeyOf(coordinate);
          this.caveLodTiles.set(tileKey, [center.y * RENDER_CHUNK_SIZE, (center.y + 1) * RENDER_CHUNK_SIZE]);
          this.excludedNearTiles.add(tileKey);
          if (this.chunkMayContainCells(coordinate))
            this.caveLodDesired.set(key, VERY_FAR_WORLD_VOXEL_LOD_FACTOR);
        }
      for (let z = -CAVE_LOD_ULTRA_FAR_RADIUS; z <= CAVE_LOD_ULTRA_FAR_RADIUS; z++)
        for (let x = -CAVE_LOD_ULTRA_FAR_RADIUS; x <= CAVE_LOD_ULTRA_FAR_RADIUS; x++) {
          if (Math.max(Math.abs(x), Math.abs(z)) <= CAVE_LOD_VERY_FAR_RADIUS) continue;
          const coordinate = { x: center.x + x, y: center.y, z: center.z + z };
          const key = keyOf(coordinate);
          const tileKey = tileKeyOf(coordinate);
          this.caveLodTiles.set(tileKey, [center.y * RENDER_CHUNK_SIZE, (center.y + 1) * RENDER_CHUNK_SIZE]);
          this.excludedNearTiles.add(tileKey);
          if (this.chunkMayContainCells(coordinate))
            this.caveLodDesired.set(key, ULTRA_FAR_WORLD_VOXEL_LOD_FACTOR);
        }
    }
    for (const [key, resident] of this.resident) {
      if (this.desired.has(key)) continue;
      if (resident.mesh) {
        this.group.remove(resident.mesh);
        resident.mesh.geometry.dispose();
      }
      const [x, y, z] = key.split(',').map(Number);
      this.chunks.unload({ x, y, z });
      this.resident.delete(key);
      this.dirtyChunks.delete(key);
    }
    for (const [key, resident] of this.caveLodResident) {
      if (this.caveLodDesired.has(key)) continue;
      if (resident.mesh) {
        this.group.remove(resident.mesh);
        resident.mesh.geometry.dispose();
      }
      this.caveLodResident.delete(key);
      this.dirtyCaveLodChunks.delete(key);
    }
  }

  private markResidentChunksDirty(position: EditPosition) {
    const coordinate = {
      x: Math.floor(position.x / RENDER_CHUNK_SIZE),
      y: Math.floor(position.y / RENDER_CHUNK_SIZE),
      z: Math.floor(position.z / RENDER_CHUNK_SIZE),
    };
    const local = {
      x: position.x - coordinate.x * RENDER_CHUNK_SIZE,
      y: position.y - coordinate.y * RENDER_CHUNK_SIZE,
      z: position.z - coordinate.z * RENDER_CHUNK_SIZE,
    };
    const affected = [coordinate];
    for (const axis of ['x', 'y', 'z'] as const) {
      if (local[axis] === 0) affected.push({ ...coordinate, [axis]: coordinate[axis] - 1 });
      if (local[axis] === RENDER_CHUNK_SIZE - 1)
        affected.push({ ...coordinate, [axis]: coordinate[axis] + 1 });
    }
    for (const chunk of affected) {
      const key = keyOf(chunk);
      if (this.resident.has(key) && this.desired.has(key)) this.dirtyChunks.add(key);
      if (this.caveLodResident.has(key) && this.caveLodDesired.has(key)) this.dirtyCaveLodChunks.add(key);
    }
  }

  private queueWorkerEdit(key: string, edit: QueuedWorkerEdit) {
    if (!this.workerSentWorld || this.workerFailed) return;
    const known = this.workerKnownEdits.get(key);
    if (edit === null ? known === undefined : sameEdit(known, edit)) this.workerEditUpdates.delete(key);
    else this.workerEditUpdates.set(key, edit);
  }

  private buildOneChunk() {
    const coordinate = this.nextChunkCoordinate();
    if (!coordinate) return false;
    const mesh = this.createChunkMesh(coordinate);
    this.installChunk(coordinate, mesh);
    return true;
  }

  private buildOneCaveLodChunk() {
    const selected = this.nextCaveLodChunk();
    if (!selected) return false;
    const startedAt = performance.now();
    const build = this.buildCoarseChunkGeometry(selected.coordinate, selected.factor);
    this.recordDuration(this.caveLodChunkBuildDurations, performance.now() - startedAt);
    const installStartedAt = performance.now();
    const mesh = this.createCaveLodMesh(selected.coordinate, selected.factor, build);
    this.installCaveLodChunk(selected.coordinate, mesh);
    this.recordDuration(this.caveLodChunkInstallDurations, performance.now() - installStartedAt);
    return true;
  }

  private nextCaveLodChunk(): {
    key: string;
    coordinate: ChunkCoordinate;
    factor: WorldVoxelLodFactor;
  } | null {
    if (!this.caveLodEnabled) return null;
    let nearest: {
      key: string;
      factor: WorldVoxelLodFactor;
      coordinate: ChunkCoordinate;
      distanceSquared: number;
    } | null = null;
    for (const [key, factor] of this.caveLodDesired) {
      if (this.caveLodResident.has(key) && !this.dirtyCaveLodChunks.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number);
      const coordinate = { x, y, z };
      const distanceSquared = this.chunkDistanceSquared(coordinate);
      const tieBreak = nearest
        ? coordinate.y - nearest.coordinate.y ||
          coordinate.z - nearest.coordinate.z ||
          coordinate.x - nearest.coordinate.x
        : -1;
      if (
        !nearest ||
        distanceSquared < nearest.distanceSquared ||
        (distanceSquared === nearest.distanceSquared && tieBreak < 0)
      )
        nearest = { key, factor, coordinate, distanceSquared };
    }
    if (!nearest) return null;
    return { key: nearest.key, factor: nearest.factor, coordinate: nearest.coordinate };
  }

  private createCaveLodMesh(
    coordinate: ChunkCoordinate,
    factor: WorldVoxelLodFactor,
    build: ReturnType<WorldVoxelRenderer['buildCoarseChunkGeometry']>,
  ) {
    const mesh = build ? this.createMesh(coordinate, { ...build, hasCaveFaces: false }) : null;
    if (mesh) {
      mesh.scale.setScalar(this.world.voxelSize * factor);
      mesh.userData.worldVoxelLodCellSize = factor;
    }
    return mesh;
  }

  private installCaveLodChunk(coordinate: ChunkCoordinate, mesh: THREE.Mesh | null) {
    const key = keyOf(coordinate);
    const previous = this.caveLodResident.get(key)?.mesh;
    if (previous) {
      this.group.remove(previous);
      previous.geometry.dispose();
    }
    this.caveLodResident.set(key, { mesh });
    this.dirtyCaveLodChunks.delete(key);
    if (mesh) this.group.add(mesh);
  }

  private nextChunkCoordinate(): ChunkCoordinate | null {
    const candidates: PendingChunk[] = [];
    for (const key of this.desired) {
      const dirty = this.dirtyChunks.has(key);
      if (this.resident.has(key) && !dirty) continue;
      const [x, y, z] = key.split(',').map(Number);
      const coordinate = { x, y, z };
      candidates.push({
        coordinate,
        distanceSquared: this.chunkDistanceSquared(coordinate),
        centered: key === keyOf(this.center!),
        dirty,
      });
    }
    candidates.sort(
      (a, b) =>
        a.distanceSquared - b.distanceSquared ||
        Number(b.centered) - Number(a.centered) ||
        Number(b.dirty) - Number(a.dirty) ||
        a.coordinate.y - b.coordinate.y ||
        a.coordinate.z - b.coordinate.z ||
        a.coordinate.x - b.coordinate.x,
    );
    return candidates[0]?.coordinate ?? null;
  }

  private requestWorkerChunk() {
    if (this.disposed || this.workerFailed) return false;
    if (this.workerPending) return true;
    const fineCoordinate = this.nextChunkCoordinate();
    const coarseChunk = fineCoordinate ? null : this.nextCaveLodChunk();
    const coordinate = fineCoordinate ?? coarseChunk?.coordinate ?? null;
    if (!coordinate) return false;
    const coarseFactor = fineCoordinate ? undefined : coarseChunk!.factor;
    try {
      this.worker ??= this.createWorker!();
      this.worker.onmessage = (event: MessageEvent<VoxelChunkBuildResponse>) =>
        this.receiveWorkerChunk(event.data);
      this.worker.onerror = () => this.failWorker();
      this.worker.onmessageerror = () => this.failWorker();
      const id = ++this.workerRequestId;
      const revision = this.windowRevision;
      const message: VoxelChunkBuildRequest = {
        id,
        revision,
        coordinate,
        ...(coarseFactor && { coarseFactor }),
        ...(!this.workerSentWorld && { world: this.world }),
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
      this.workerPending = { id, revision, coordinate, ...(coarseFactor && { coarseFactor }) };
      this.worker.postMessage(message);
      if (!this.workerSentWorld) {
        this.workerKnownEdits.clear();
        for (const edit of this.world.edits) this.workerKnownEdits.set(editKey(edit), edit);
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
      this.buildOneChunk();
    }
    return true;
  }

  private receiveWorkerChunk(response: VoxelChunkBuildResponse) {
    const pending = this.workerPending;
    if (this.disposed || !pending) return;
    if (
      response.id !== pending.id ||
      response.coordinate.x !== pending.coordinate.x ||
      response.coordinate.y !== pending.coordinate.y ||
      response.coordinate.z !== pending.coordinate.z ||
      response.coarseFactor !== pending.coarseFactor
    ) {
      this.failWorker();
      return;
    }
    this.workerPending = null;
    if (response.error) {
      this.failWorker();
      return;
    }
    const stillDesired = pending.coarseFactor
      ? this.caveLodDesired.has(keyOf(response.coordinate))
      : this.desired.has(keyOf(response.coordinate));
    if (response.revision !== this.windowRevision || !stillDesired) {
      this.requestWorkerChunk();
      return;
    }
    try {
      if (pending.coarseFactor) {
        this.recordDuration(this.caveLodChunkBuildDurations, response.meshMs);
        const installStarted = performance.now();
        const build = response.geometry
          ? {
              geometry: deserializeVoxelChunkGeometry(response.geometry),
              voxelCellCount: response.voxelCellCount,
            }
          : null;
        if (build && pending.coarseFactor === WORLD_VOXEL_LOD_FACTOR)
          this.stitchFineBoundary(build.geometry, response.coordinate, pending.coarseFactor);
        this.installCaveLodChunk(
          response.coordinate,
          build ? this.createCaveLodMesh(response.coordinate, pending.coarseFactor, build) : null,
        );
        this.recordDuration(this.caveLodChunkInstallDurations, performance.now() - installStarted);
      } else {
        this.recordDuration(this.workerBuildDurations, response.meshMs);
        const installStarted = performance.now();
        const build = response.geometry
          ? {
              geometry: deserializeVoxelChunkGeometry(response.geometry),
              voxelCellCount: response.voxelCellCount,
              hasCaveFaces: response.hasCaveFaces,
            }
          : null;
        const mesh = build ? this.createMesh(response.coordinate, build) : null;
        this.installChunk(response.coordinate, mesh);
        this.recordDuration(this.chunkInstallDurations, performance.now() - installStarted);
      }
    } catch {
      this.failWorker();
      return;
    }
    this.requestWorkerChunk();
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
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch {
      // A failed worker is already unavailable; the synchronous path remains usable.
    }
  }

  private installChunk(coordinate: ChunkCoordinate, mesh: THREE.Mesh | null) {
    const key = keyOf(coordinate);
    const previous = this.resident.get(key)?.mesh;
    if (previous) {
      this.group.remove(previous);
      previous.geometry.dispose();
    }
    this.resident.set(key, { mesh });
    this.dirtyChunks.delete(key);
    if (mesh) this.group.add(mesh);
  }

  private recordDuration(samples: number[], duration: number) {
    samples.push(duration);
    if (samples.length > 256) samples.shift();
  }

  private chunkMayContainCells({ x, y, z }: ChunkCoordinate) {
    const size = RENDER_CHUNK_SIZE;
    const { generator } = this.world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    const intersects =
      x * size <= originX + width - 1 &&
      (x + 1) * size - 1 >= originX &&
      z * size <= originZ + depth - 1 &&
      (z + 1) * size - 1 >= originZ &&
      y * size <= generator.maxY &&
      (y + 1) * size - 1 >= generator.minY;
    return intersects || this.editedChunks.has(`${x},${y},${z}`);
  }

  private createChunkMesh(coordinate: ChunkCoordinate) {
    const build = this.buildChunkGeometry(coordinate);
    return build ? this.createMesh(coordinate, build) : null;
  }

  /** Builds transferable chunk geometry without adding a Three.js mesh to the scene. */
  buildChunkGeometry(coordinate: ChunkCoordinate): WorldVoxelChunkBuild | null {
    const chunkSize = RENDER_CHUNK_SIZE;
    const origin = { x: coordinate.x * chunkSize, y: coordinate.y * chunkSize, z: coordinate.z * chunkSize };
    const voxels: { x: number; y: number; z: number; color: number; materialType: string }[] = [];
    if (this.world.chunkSize === chunkSize) {
      const chunk = this.chunks.hydrate(coordinate);
      for (const [index, cell] of chunk.cells) {
        const y = Math.floor(index / (chunkSize * chunkSize));
        const remainder = index - y * chunkSize * chunkSize;
        const z = Math.floor(remainder / chunkSize);
        voxels.push({ x: remainder - z * chunkSize, y, z, ...cell });
      }
    } else {
      for (let y = 0; y < chunkSize; y++)
        for (let z = 0; z < chunkSize; z++)
          for (let x = 0; x < chunkSize; x++) {
            const cell = this.cellAt({ x: origin.x + x, y: origin.y + y, z: origin.z + z });
            if (cell) voxels.push({ x, y, z, ...cell });
          }
    }
    if (!voxels.length) return null;
    const asset = {
      id: this.world.id,
      name: this.world.name,
      model: { voxels },
      rig: null,
    } as unknown as Asset;
    const geometry = createVoxelGeometryChunks(asset, [], 0, (local) =>
      this.cellAt({ x: origin.x + local.x, y: origin.y + local.y, z: origin.z + local.z }),
    )[0]?.geometry;
    if (!geometry) return null;
    const hasCaveFaces = this.chunkIntersectsCave(coordinate) && this.lightCaveFaces(geometry, origin);
    return { geometry, voxelCellCount: voxels.length, hasCaveFaces };
  }

  /** Builds one coarse cave-view chunk from the same sampler and edits as the full-resolution worker path. */
  buildCoarseChunkGeometry(
    coordinate: ChunkCoordinate,
    coarseFactor: WorldVoxelLodFactor = WORLD_VOXEL_LOD_FACTOR,
  ) {
    const build = buildCoarseWorldVoxelChunk(this.world, coordinate, this.cellAt, coarseFactor);
    if (build && coarseFactor === WORLD_VOXEL_LOD_FACTOR)
      this.stitchFineBoundary(build.geometry, coordinate, coarseFactor);
    return build;
  }

  /** Repairs side faces where factor-two sampling disagrees with the authoritative fine cells. */
  private stitchFineBoundary(geometry: THREE.BufferGeometry, coordinate: ChunkCoordinate, factor: number) {
    if (!this.caveLodEnabled || !this.center || !geometry.index) return;
    const candidateSides: CoarseBoundarySide[] = [
      { name: 'left', axis: 'x', direction: -1 },
      { name: 'right', axis: 'x', direction: 1 },
      { name: 'back', axis: 'z', direction: -1 },
      { name: 'front', axis: 'z', direction: 1 },
    ];
    const sides = candidateSides.filter((side) => {
      const neighbor = {
        x: coordinate.x + (side.axis === 'x' ? side.direction : 0),
        y: coordinate.y,
        z: coordinate.z + (side.axis === 'z' ? side.direction : 0),
      };
      return (
        Math.abs(neighbor.x - this.center!.x) <= HORIZONTAL_RADIUS &&
        Math.abs(neighbor.z - this.center!.z) <= HORIZONTAL_RADIUS &&
        Math.abs(neighbor.y - this.center!.y) <= VERTICAL_RADIUS &&
        this.desired.has(keyOf(neighbor))
      );
    });
    if (!sides.length) return;

    const origin = {
      x: coordinate.x * RENDER_CHUNK_SIZE,
      y: coordinate.y * RENDER_CHUNK_SIZE,
      z: coordinate.z * RENDER_CHUNK_SIZE,
    };
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const index = geometry.index;
    const boundary = (side: CoarseBoundarySide) =>
      (side.axis === 'x' ? origin.x : origin.z) + (side.direction < 0 ? -0.5 : RENDER_CHUNK_SIZE - 0.5);
    const covered = new Set<string>();
    for (const side of sides) {
      const plane = (boundary(side) - (side.axis === 'x' ? origin.x : origin.z)) / factor;
      const axisPosition = side.axis === 'x' ? position.getX.bind(position) : position.getZ.bind(position);
      const axisNormal = side.axis === 'x' ? normal.getX.bind(normal) : normal.getZ.bind(normal);
      for (let triangle = 0; triangle < index.count; triangle += 3) {
        const vertices = [index.getX(triangle), index.getX(triangle + 1), index.getX(triangle + 2)];
        if (
          vertices.some((vertex) => Math.abs(axisPosition(vertex) - plane) > 1e-5) ||
          axisNormal(vertices[0]) * side.direction < 0.999
        )
          continue;
        const yValues = vertices.map((vertex) => position.getY(vertex));
        const alongValues = vertices.map((vertex) =>
          side.axis === 'x' ? position.getZ(vertex) : position.getX(vertex),
        );
        for (let yOffset = 0; yOffset < RENDER_CHUNK_SIZE; yOffset++)
          for (let alongOffset = 0; alongOffset < RENDER_CHUNK_SIZE; alongOffset++)
            if (
              (yOffset - 0.00001) / factor <= Math.max(...yValues) &&
              (yOffset + 0.00001) / factor >= Math.min(...yValues) &&
              (alongOffset - 0.00001) / factor <= Math.max(...alongValues) &&
              (alongOffset + 0.00001) / factor >= Math.min(...alongValues)
            )
              covered.add(`${side.name}:${yOffset}:${alongOffset}`);
      }
    }

    const facesByMaterial = VOXEL_MATERIALS.map(() => ({
      positions: [] as number[],
      normals: [] as number[],
      colors: [] as number[],
      indices: [] as number[],
    }));
    const emit = (
      side: CoarseBoundarySide,
      yOffset: number,
      alongOffset: number,
      color: number,
      materialType: string,
    ) => {
      const materialIndex = Math.max(
        0,
        VOXEL_MATERIALS.indexOf(materialType as (typeof VOXEL_MATERIALS)[number]),
      );
      const face = facesByMaterial[materialIndex];
      const plane = (boundary(side) - (side.axis === 'x' ? origin.x : origin.z)) / factor;
      const y0 = (yOffset - 0.5) / factor,
        y1 = (yOffset + 0.5) / factor;
      const along0 = (alongOffset - 0.5) / factor,
        along1 = (alongOffset + 0.5) / factor;
      const points: [number, number, number][] =
        side.axis === 'x'
          ? side.direction > 0
            ? [
                [plane, y0, along0],
                [plane, y1, along0],
                [plane, y1, along1],
                [plane, y0, along1],
              ]
            : [
                [plane, y0, along0],
                [plane, y0, along1],
                [plane, y1, along1],
                [plane, y1, along0],
              ]
          : side.direction > 0
            ? [
                [along0, y0, plane],
                [along1, y0, plane],
                [along1, y1, plane],
                [along0, y1, plane],
              ]
            : [
                [along0, y0, plane],
                [along0, y1, plane],
                [along1, y1, plane],
                [along1, y0, plane],
              ];
      const colorValue = new THREE.Color(color);
      const base = face.positions.length / 3;
      for (const point of points) {
        face.positions.push(...point);
        face.normals.push(side.axis === 'x' ? side.direction : 0, 0, side.axis === 'z' ? side.direction : 0);
        face.colors.push(colorValue.r, colorValue.g, colorValue.b);
      }
      face.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    for (const side of sides) {
      for (let yOffset = 0; yOffset < RENDER_CHUNK_SIZE; yOffset++)
        for (let alongOffset = 0; alongOffset < RENDER_CHUNK_SIZE; alongOffset++) {
          if (covered.has(`${side.name}:${yOffset}:${alongOffset}`)) continue;
          const inside = {
            x:
              origin.x + (side.axis === 'x' ? (side.direction < 0 ? 0 : RENDER_CHUNK_SIZE - 1) : alongOffset),
            y: origin.y + yOffset,
            z:
              origin.z + (side.axis === 'z' ? (side.direction < 0 ? 0 : RENDER_CHUNK_SIZE - 1) : alongOffset),
          };
          const outside = {
            x: inside.x + (side.axis === 'x' ? side.direction : 0),
            y: inside.y,
            z: inside.z + (side.axis === 'z' ? side.direction : 0),
          };
          const cell = this.cellAt(inside);
          if (!cell || this.cellAt(outside)) continue;
          emit(side, yOffset, alongOffset, cell.color, cell.materialType);
        }
    }

    const addedVertices = facesByMaterial.reduce((total, face) => total + face.positions.length, 0);
    if (!addedVertices) return;
    const positions = Array.from(position.array as ArrayLike<number>);
    const normals = Array.from(normal.array as ArrayLike<number>);
    const colors = Array.from(geometry.getAttribute('color').array as ArrayLike<number>);
    const indices = Array.from(index.array as ArrayLike<number>);
    let vertexOffset = position.count;
    for (const [materialIndex, face] of facesByMaterial.entries()) {
      if (!face.indices.length) continue;
      const start = indices.length;
      positions.push(...face.positions);
      normals.push(...face.normals);
      colors.push(...face.colors);
      indices.push(...face.indices.map((value) => value + vertexOffset));
      geometry.addGroup(start, face.indices.length, materialIndex);
      vertexOffset += face.positions.length / 3;
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  /** Lets the worker release its temporary hydrated chunk after meshing. */
  releaseChunkData(coordinate: ChunkCoordinate) {
    this.chunks.unload(coordinate);
  }

  private createMesh(coordinate: ChunkCoordinate, build: WorldVoxelChunkBuild) {
    const geometry = build.geometry;
    const origin = {
      x: coordinate.x * RENDER_CHUNK_SIZE,
      y: coordinate.y * RENDER_CHUNK_SIZE,
      z: coordinate.z * RENDER_CHUNK_SIZE,
    };
    const mesh = new THREE.Mesh(
      geometry,
      build.hasCaveFaces ? [...this.materials, this.caveMaterial] : this.materials,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.scale.setScalar(this.world.voxelSize);
    mesh.position.set(
      origin.x * this.world.voxelSize,
      origin.y * this.world.voxelSize,
      origin.z * this.world.voxelSize,
    );
    mesh.userData.worldChunk = coordinate;
    mesh.userData.voxelCellCount = build.voxelCellCount;
    return mesh;
  }

  private lightCaveFaces(geometry: THREE.BufferGeometry, origin: ChunkCoordinate) {
    const index = geometry.index;
    if (!index) return false;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const sourceGroups = geometry.groups;
    const indicesByMaterial = Array.from({ length: this.materials.length + 1 }, () => [] as number[]);
    let sourceGroupIndex = 0;
    let hasCaveFaces = false;
    for (let start = 0; start < index.count; start += 6) {
      while (
        sourceGroupIndex < sourceGroups.length - 1 &&
        start >= sourceGroups[sourceGroupIndex].start + sourceGroups[sourceGroupIndex].count
      )
        sourceGroupIndex++;
      const a = index.getX(start),
        b = index.getX(start + 1),
        c = index.getX(start + 2),
        d = index.getX(start + 4);
      const x =
          (positions.getX(a) + positions.getX(b) + positions.getX(c) + positions.getX(d)) / 4 + origin.x,
        y = (positions.getY(a) + positions.getY(b) + positions.getY(c) + positions.getY(d)) / 4 + origin.y,
        z = (positions.getZ(a) + positions.getZ(b) + positions.getZ(c) + positions.getZ(d)) / 4 + origin.z,
        normalX = normals.getX(a),
        normalY = normals.getY(a),
        normalZ = normals.getZ(a);
      const caveFace = this.isCaveVoid({
        x: Math.round(x + normalX * 0.5),
        y: Math.round(y + normalY * 0.5),
        z: Math.round(z + normalZ * 0.5),
      });
      const materialIndex = caveFace
        ? this.materials.length
        : (sourceGroups[sourceGroupIndex]?.materialIndex ?? 0);
      if (caveFace) hasCaveFaces = true;
      const materialIndices = indicesByMaterial[materialIndex];
      for (let i = 0; i < 6; i++) materialIndices.push(index.getX(start + i));
    }
    const reordered: number[] = [];
    geometry.clearGroups();
    for (const [materialIndex, indices] of indicesByMaterial.entries()) {
      if (!indices.length) continue;
      geometry.addGroup(reordered.length, indices.length, materialIndex);
      reordered.push(...indices);
    }
    geometry.setIndex(reordered);
    return hasCaveFaces;
  }

  private isCaveVoid({ x, y, z }: { x: number; y: number; z: number }) {
    const { generator } = this.world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    const caveY = terrainCaveCenterY(this.world);
    const caveZ = originZ + Math.floor(depth / 2);
    const entranceX = originX + Math.floor(width / 2);
    const halfLength = Math.max(2, Math.min(12, Math.floor(width / 2) - 2));
    const branchHalfLength = Math.max(2, Math.min(12, Math.floor(depth / 2) - 2));
    const networkBranch = this.caveBranches.some((branch) => {
      const along = (z - caveZ) * branch.direction;
      return along >= -4 && along <= branch.length && Math.abs(x - branch.x) <= 6;
    });
    const inPassage =
      (Math.abs(x - entranceX) <= halfLength && Math.abs(z - caveZ) <= 6) ||
      (generator.caveCrossPassage === true &&
        Math.abs(z - caveZ) <= branchHalfLength &&
        Math.abs(x - entranceX) <= 6) ||
      networkBranch;
    const inWorldNetwork =
      !!this.caveNetworkPath &&
      (terrainCaveNetworkContains(this.caveNetworkPath, x, y, z) ||
        this.caveNetworkBranches.some((branch) =>
          terrainCaveNetworkBranchContains(this.caveNetworkPath!, branch, x, y, z),
        ));
    return (
      x >= originX &&
      x < originX + width &&
      z >= originZ &&
      z < originZ + depth &&
      y >= generator.minY &&
      y <= generator.maxY &&
      ((inPassage && Math.abs(y - caveY) <= 5) || inWorldNetwork) &&
      y < this.surfaceAt(x, z) - 2 &&
      !this.cellAt({ x, y, z })
    );
  }

  private chunkIntersectsCave({ x, y, z }: ChunkCoordinate) {
    const { generator } = this.world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    const centerX = originX + Math.floor(width / 2);
    const centerY = terrainCaveCenterY(this.world);
    const centerZ = originZ + Math.floor(depth / 2);
    const halfLength = Math.max(2, Math.min(12, Math.floor(width / 2) - 2));
    const branchHalfLength = Math.max(2, Math.min(12, Math.floor(depth / 2) - 2));
    // Conservative margins include the seeded cave meander and its elliptical cross-section.
    const overlaps = (chunk: number, min: number, max: number) =>
      chunk * RENDER_CHUNK_SIZE <= max && (chunk + 1) * RENDER_CHUNK_SIZE - 1 >= min;
    const branch =
      generator.caveCrossPassage === true &&
      overlaps(x, centerX - 6, centerX + 6) &&
      overlaps(z, centerZ - branchHalfLength, centerZ + branchHalfLength);
    const networkBranch = this.caveBranches.some((caveBranch) => {
      const minZ = caveBranch.direction === 1 ? centerZ - 4 : centerZ - caveBranch.length - 4;
      const maxZ = caveBranch.direction === 1 ? centerZ + caveBranch.length : centerZ + 4;
      return overlaps(x, caveBranch.x - 6, caveBranch.x + 6) && overlaps(z, minZ, maxZ);
    });
    let worldNetwork = false;
    if (this.caveNetworkPath) {
      const alongChunk = this.caveNetworkPath.axis === 'x' ? x : z;
      const crossChunk = this.caveNetworkPath.axis === 'x' ? z : x;
      const alongOrigin = this.caveNetworkPath.axis === 'x' ? originX : originZ;
      const alongLength = this.caveNetworkPath.axis === 'x' ? width : depth;
      const alongStart = Math.max(alongOrigin, alongChunk * RENDER_CHUNK_SIZE);
      const alongEnd = Math.min(alongOrigin + alongLength - 1, (alongChunk + 1) * RENDER_CHUNK_SIZE - 1);
      const crossStart = crossChunk * RENDER_CHUNK_SIZE;
      const crossEnd = (crossChunk + 1) * RENDER_CHUNK_SIZE - 1;
      const verticalStart = y * RENDER_CHUNK_SIZE;
      const verticalEnd = (y + 1) * RENDER_CHUNK_SIZE - 1;
      for (let along = alongStart; along <= alongEnd; along += 4) {
        const point = this.caveNetworkPath.at(along);
        const lateral = this.caveNetworkPath.axis === 'x' ? point.z : point.x;
        if (
          lateral + 3 >= crossStart &&
          lateral - 3 <= crossEnd &&
          point.y + 2.5 >= verticalStart &&
          point.y - 2.5 <= verticalEnd
        ) {
          worldNetwork = true;
          break;
        }
      }
      if (!worldNetwork && alongEnd >= alongStart) {
        const point = this.caveNetworkPath.at(alongEnd);
        const lateral = this.caveNetworkPath.axis === 'x' ? point.z : point.x;
        worldNetwork =
          lateral + 3 >= crossStart &&
          lateral - 3 <= crossEnd &&
          point.y + 2.5 >= verticalStart &&
          point.y - 2.5 <= verticalEnd;
      }
      if (!worldNetwork) {
        for (const branch of this.caveNetworkBranches) {
          const point = this.caveNetworkPath.at(branch.along);
          const centerCross = this.caveNetworkPath.axis === 'x' ? point.z : point.x;
          const branchEnd = centerCross + branch.direction * branch.length;
          const branchAlongChunk = this.caveNetworkPath.axis === 'x' ? x : z;
          const branchCrossChunk = this.caveNetworkPath.axis === 'x' ? z : x;
          if (
            branch.along + 2.5 >= branchAlongChunk * RENDER_CHUNK_SIZE &&
            branch.along - 2.5 <= (branchAlongChunk + 1) * RENDER_CHUNK_SIZE - 1 &&
            Math.max(centerCross, branchEnd) + 3 >= branchCrossChunk * RENDER_CHUNK_SIZE &&
            Math.min(centerCross, branchEnd) - 3 <= (branchCrossChunk + 1) * RENDER_CHUNK_SIZE - 1 &&
            point.y + 2.5 >= verticalStart &&
            point.y - 2.5 <= verticalEnd
          ) {
            worldNetwork = true;
            break;
          }
        }
      }
    }
    const finitePassage =
      overlaps(y, centerY - 5, centerY + 5) &&
      ((overlaps(x, centerX - halfLength, centerX + halfLength) && overlaps(z, centerZ - 6, centerZ + 6)) ||
        branch ||
        networkBranch);
    return finitePassage || worldNetwork;
  }

  private chunkDistanceSquared({ x, y, z }: ChunkCoordinate) {
    const chunkSize = RENDER_CHUNK_SIZE * this.world.voxelSize;
    const dx = (x + 0.5) * chunkSize - this.latestTarget.x;
    const dy = (y + 0.5) * chunkSize - this.latestTarget.y;
    const dz = (z + 0.5) * chunkSize - this.latestTarget.z;
    return dx * dx + dy * dy + dz * dz;
  }

  stats() {
    const distantTerrain = this.distantTerrain.stats();
    const residentVoxelGeometryArrayBytes = [...this.resident.values()].reduce(
      (total, chunk) => total + (chunk.mesh ? geometryArrayBytes(chunk.mesh.geometry) : 0),
      0,
    );
    const residentCaveLodGeometryArrayBytes = [...this.caveLodResident.values()].reduce(
      (total, chunk) => total + (chunk.mesh ? geometryArrayBytes(chunk.mesh.geometry) : 0),
      0,
    );
    return {
      worldId: this.world.id,
      verticalMode: 'voxel3d' as const,
      residentChunks: this.resident.size,
      loadedChunks: this.resident.size,
      renderedChunks: [...this.resident.values()].filter((chunk) => chunk.mesh).length,
      maximumResidentChunks: (HORIZONTAL_RADIUS * 2 + 1) ** 2 * (VERTICAL_RADIUS * 2 + 1),
      caveLodEnabled: this.caveLodEnabled,
      caveLodTileCount: this.caveLodTiles.size,
      desiredCaveLodChunks: this.caveLodDesired.size,
      residentCaveLodChunks: this.caveLodResident.size,
      renderedCaveLodChunks: [...this.caveLodResident.values()].filter((chunk) => chunk.mesh).length,
      maximumResidentCaveLodChunks: MAXIMUM_RESIDENT_CAVE_LOD_CHUNKS,
      renderChunkSize: RENDER_CHUNK_SIZE,
      storageChunkSize: this.world.chunkSize,
      logicalCellSizeMeters: this.world.voxelSize,
      greedyMeshing: true,
      materialSlots: VOXEL_MATERIALS.length,
      streamUpdateMs: summarizeDurations(this.updateDurations),
      workerChunkBuildMs: summarizeDurations(this.workerBuildDurations),
      chunkInstallMs: summarizeDurations(this.chunkInstallDurations),
      caveLodChunkBuildMs: summarizeDurations(this.caveLodChunkBuildDurations),
      caveLodChunkInstallMs: summarizeDurations(this.caveLodChunkInstallDurations),
      storedChunkCacheCount: this.chunks.loadedChunkCount(),
      residentVoxelGeometryArrayBytes,
      residentCaveLodGeometryArrayBytes,
      residentGeometryArrayBytes:
        residentVoxelGeometryArrayBytes +
        residentCaveLodGeometryArrayBytes +
        distantTerrain.residentGeometryArrayBytes,
      distantTerrain: {
        renderedGeometries: distantTerrain.residentGeometries,
        maximumResidentGeometries: distantTerrain.maximumResidentGeometries,
        residentGeometryArrayBytes: distantTerrain.residentGeometryArrayBytes,
        updateMs: distantTerrain.updateMs,
        tileBuildMs: distantTerrain.tileBuildMs,
        workerTileBuildMs: distantTerrain.workerTileBuildMs,
        tileInstallMs: distantTerrain.tileInstallMs,
      },
    };
  }

  dispose() {
    this.disposed = true;
    this.terminateWorker();
    this.workerPending = null;
    for (const resident of this.resident.values()) resident.mesh?.geometry.dispose();
    this.resident.clear();
    for (const resident of this.caveLodResident.values()) resident.mesh?.geometry.dispose();
    this.caveLodResident.clear();
    this.group.clear();
    this.chunks.unloadAll();
    this.distantTerrain.dispose();
    this.materials.forEach((material) => material.dispose());
    this.caveMaterial.dispose();
    this.group.removeFromParent();
  }
}
