import type { WorldDocument, WorldEdit } from '../services/worldDocument';
import type { WorkerGeometryData } from './workerGeometry';

export {
  deserializeWorkerGeometry as deserializeTileGeometry,
  serializeWorkerGeometry as serializeTileGeometry,
} from './workerGeometry';

export type TileLevel = 'near' | 'medium' | 'far' | 'horizon';
export type TileCoordinate = { x: number; z: number };

export type TileGeometryData = WorkerGeometryData;

export type TileBuildRequest = {
  id: number;
  revision: number;
  level: TileLevel;
  coordinate: TileCoordinate;
  target: [number, number, number];
  /** Half-open cell Y range rendered by local voxel chunks instead of this near tile. */
  excludedY?: [number, number];
  world?: WorldDocument;
  edits?: WorldEdit[];
  clearedEdits?: Pick<WorldEdit, 'x' | 'y' | 'z'>[];
};

export type TileBuildResponse = {
  id: number;
  revision: number;
  level: TileLevel;
  coordinate: TileCoordinate;
  geometry: TileGeometryData | null;
  meshMs: number;
  error?: string;
};
