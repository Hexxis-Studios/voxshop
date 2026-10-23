import * as THREE from 'three';
import type { VoxelChunkBuildRequest, VoxelChunkBuildResponse } from './worldVoxelWorkerProtocol';
import { serializeVoxelChunkGeometry } from './worldVoxelWorkerProtocol';
import { WorldVoxelRenderer } from './WorldVoxelRenderer';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<VoxelChunkBuildRequest>) => void) | null;
  postMessage(message: VoxelChunkBuildResponse, transfer?: Transferable[]): void;
};
let renderer: WorldVoxelRenderer | null = null;

workerScope.onmessage = ({ data }) => {
  let geometry: THREE.BufferGeometry | null = null;
  let voxelCellCount = 0;
  let hasCaveFaces = false;
  let meshMs = 0;
  try {
    if (!renderer) {
      if (!data.world) throw new Error('The voxel worker needs a world for its first chunk.');
      renderer = new WorldVoxelRenderer(new THREE.Scene(), data.world);
    } else if (data.edits?.length || data.clearedEdits?.length)
      renderer.applyWorldEditPatch(data.edits ?? [], data.clearedEdits ?? []);
    const startedAt = performance.now();
    const build = data.coarseFactor
      ? renderer.buildCoarseChunkGeometry(data.coordinate, data.coarseFactor)
      : renderer.buildChunkGeometry(data.coordinate);
    meshMs = performance.now() - startedAt;
    geometry = build?.geometry ?? null;
    voxelCellCount = build?.voxelCellCount ?? 0;
    if (build && 'hasCaveFaces' in build && typeof build.hasCaveFaces === 'boolean')
      hasCaveFaces = build.hasCaveFaces;
    const serialized = geometry ? serializeVoxelChunkGeometry(geometry) : null;
    const response: VoxelChunkBuildResponse = {
      id: data.id,
      revision: data.revision,
      coordinate: data.coordinate,
      ...(data.coarseFactor && { coarseFactor: data.coarseFactor }),
      geometry: serialized?.data ?? null,
      voxelCellCount,
      hasCaveFaces,
      meshMs,
    };
    workerScope.postMessage(response, serialized?.transfer ?? []);
  } catch (error) {
    const response: VoxelChunkBuildResponse = {
      id: data.id,
      revision: data.revision,
      coordinate: data.coordinate,
      ...(data.coarseFactor && { coarseFactor: data.coarseFactor }),
      geometry: null,
      voxelCellCount: 0,
      hasCaveFaces: false,
      meshMs,
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  } finally {
    geometry?.dispose();
    renderer?.releaseChunkData(data.coordinate);
  }
};
