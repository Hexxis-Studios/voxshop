import * as THREE from 'three';

export type WorkerGeometryData = {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint16Array | Uint32Array;
  groups: Array<{ start: number; count: number; materialIndex: number }>;
};

export function serializeWorkerGeometry(geometry: THREE.BufferGeometry): {
  data: WorkerGeometryData;
  transfer: ArrayBuffer[];
} {
  const position = geometry.getAttribute('position').array as Float32Array;
  const normal = geometry.getAttribute('normal').array as Float32Array;
  const color = geometry.getAttribute('color').array as Float32Array;
  const index = geometry.index!.array as Uint16Array | Uint32Array;
  return {
    data: {
      position,
      normal,
      color,
      index,
      groups: geometry.groups.map(({ start, count, materialIndex }) => ({
        start,
        count,
        materialIndex: materialIndex ?? 0,
      })),
    },
    transfer: [position.buffer, normal.buffer, color.buffer, index.buffer],
  };
}

export function deserializeWorkerGeometry(data: WorkerGeometryData) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.color, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  data.groups.forEach(({ start, count, materialIndex }) => geometry.addGroup(start, count, materialIndex));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
