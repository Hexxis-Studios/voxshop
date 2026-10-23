import * as THREE from 'three';
import type { TileBuildRequest, TileBuildResponse } from './worldStreamWorkerProtocol';
import { serializeTileGeometry } from './worldStreamWorkerProtocol';
import { WorldStreamRenderer } from './WorldStreamRenderer';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<TileBuildRequest>) => void) | null;
  postMessage(message: TileBuildResponse, transfer?: Transferable[]): void;
};
let renderer: WorldStreamRenderer | null = null;

workerScope.onmessage = ({ data }) => {
  let geometry: THREE.BufferGeometry | null = null;
  let meshMs = 0;
  try {
    if (!renderer) {
      if (!data.world) throw new Error('The terrain worker needs a world for its first tile.');
      renderer = new WorldStreamRenderer(new THREE.Scene(), data.world);
    } else if (data.edits?.length || data.clearedEdits?.length) {
      renderer.applyWorldEditPatch(data.edits ?? [], data.clearedEdits ?? []);
    }
    const startedAt = performance.now();
    geometry = renderer.buildTileGeometry(
      data.level,
      data.coordinate,
      new THREE.Vector3(...data.target),
      data.excludedY,
    );
    meshMs = performance.now() - startedAt;
    const serialized = geometry ? serializeTileGeometry(geometry) : null;
    const response: TileBuildResponse = {
      id: data.id,
      revision: data.revision,
      level: data.level,
      coordinate: data.coordinate,
      geometry: serialized?.data ?? null,
      meshMs,
    };
    workerScope.postMessage(response, serialized?.transfer ?? []);
  } catch (error) {
    const response: TileBuildResponse = {
      id: data.id,
      revision: data.revision,
      level: data.level,
      coordinate: data.coordinate,
      geometry: null,
      meshMs,
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  } finally {
    geometry?.dispose();
  }
};
