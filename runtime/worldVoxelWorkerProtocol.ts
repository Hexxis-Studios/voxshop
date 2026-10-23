import type { WorldDocument, WorldEdit } from '../services/worldDocument';
import type { WorkerGeometryData } from './workerGeometry';
import type { WorldVoxelLodFactor } from './worldVoxelLod';

export {
  deserializeWorkerGeometry as deserializeVoxelChunkGeometry,
  serializeWorkerGeometry as serializeVoxelChunkGeometry,
} from './workerGeometry';

export type VoxelChunkCoordinate = { x: number; y: number; z: number };
export type VoxelChunkGeometryData = WorkerGeometryData;

export type VoxelChunkBuildRequest = {
  id: number;
  revision: number;
  coordinate: VoxelChunkCoordinate;
  coarseFactor?: WorldVoxelLodFactor;
  world?: WorldDocument;
  edits?: WorldEdit[];
  clearedEdits?: Array<Pick<WorldEdit, 'x' | 'y' | 'z'>>;
};

export type VoxelChunkBuildResponse = {
  id: number;
  revision: number;
  coordinate: VoxelChunkCoordinate;
  coarseFactor?: WorldVoxelLodFactor;
  geometry: VoxelChunkGeometryData | null;
  voxelCellCount: number;
  hasCaveFaces: boolean;
  meshMs: number;
  error?: string;
};
