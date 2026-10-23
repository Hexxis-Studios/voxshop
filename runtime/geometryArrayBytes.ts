import * as THREE from 'three';

/** CPU-side typed-array storage owned by a geometry; excludes renderer/GPU allocations and worker temporaries. */
export function geometryArrayBytes(geometry: THREE.BufferGeometry) {
  const buffers = new Set<ArrayBufferLike>();
  for (const attribute of Object.values(geometry.attributes)) {
    const array =
      attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
    buffers.add(array.buffer);
  }
  if (geometry.index) buffers.add(geometry.index.array.buffer);
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
}
