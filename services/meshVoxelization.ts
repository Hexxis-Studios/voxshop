import * as THREE from 'three';
import type { VoxelData } from '../types';
import { CONFIG } from '../utils/voxelConstants';

/** Converts mesh surfaces to voxels in world space. Null means the source has no spatial extent. */
export function voxelizeMesh(object: THREE.Object3D, resolution: number | null = null): VoxelData[] | null {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  object.traverse((child) => {
    if (!(child as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mesh = child as THREE.SkinnedMesh;
    mesh.skeleton.update();
    mesh.computeBoundingBox();
    if (mesh.boundingBox) box.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim === 0) return null;
  const res = resolution ?? Math.max(16, Math.min(96, Math.round(maxDim)));
  const voxelWorldSize = maxDim / res;
  const half = voxelWorldSize * 0.5;

  const texCache = new Map<string, ImageData | null>();
  const getTexData = (tex: THREE.Texture | null | undefined): ImageData | null => {
    if (!tex?.image) return null;
    if (texCache.has(tex.uuid)) return texCache.get(tex.uuid)!;
    try {
      const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
      const w = (img as any).naturalWidth || (img as any).width || 1;
      const h = (img as any).naturalHeight || (img as any).height || 1;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d')!;
      context.drawImage(img as any, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h);
      texCache.set(tex.uuid, data);
      return data;
    } catch {
      texCache.set(tex.uuid, null);
      return null;
    }
  };
  const sampleTex = (data: ImageData, u: number, v: number): number => {
    const { width: w, height: h } = data;
    const uw = ((u % 1) + 1) % 1;
    const vw = ((v % 1) + 1) % 1;
    const px = Math.min(w - 1, Math.max(0, Math.floor(uw * w)));
    const py = Math.min(h - 1, Math.max(0, Math.floor((1 - vw) * h)));
    const i = (py * w + px) * 4;
    return (data.data[i] << 16) | (data.data[i + 1] << 8) | data.data[i + 2];
  };

  const voxelMap = new Map<string, number>();
  let cellTests = 0;
  const pA = new THREE.Vector3(),
    pB = new THREE.Vector3(),
    pC = new THREE.Vector3();
  const tri = new THREE.Triangle();
  const voxelBox = new THREE.Box3();

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geo = child.geometry as THREE.BufferGeometry;
    if (!geo.attributes.position) return;

    child.updateWorldMatrix(true, false);
    const matrix = child.matrixWorld;
    const posAttr = geo.attributes.position;
    const colorAttr = geo.attributes.color;
    const uvAttr = geo.attributes.uv;
    const indexAttr = geo.index;
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
    const skinnedMesh = (child as THREE.SkinnedMesh).isSkinnedMesh ? (child as THREE.SkinnedMesh) : null;
    skinnedMesh?.skeleton.update();

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const getWorldVert = (i: number, out: THREE.Vector3): THREE.Vector3 =>
      skinnedMesh
        ? skinnedMesh.getVertexPosition(i, out).applyMatrix4(matrix)
        : out.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(matrix);

    const groupForFace: number[] = [];
    if (geo.groups.length > 0) {
      for (const group of geo.groups) {
        const faceStart = group.start / 3,
          faceEnd = faceStart + group.count / 3;
        for (let face = faceStart; face < faceEnd; face++) groupForFace[face] = group.materialIndex ?? 0;
      }
    }
    const texDataCache: (ImageData | null)[] = materials.map((material) =>
      getTexData((material as THREE.MeshStandardMaterial)?.map),
    );
    const matColors: number[] = materials.map((material) => (material as any)?.color?.getHex?.() ?? 0xcccccc);

    for (let t = 0; t < triCount; t++) {
      const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
      const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

      getWorldVert(i0, pA);
      getWorldVert(i1, pB);
      getWorldVert(i2, pC);
      tri.set(pA, pB, pC);

      const matIdx = groupForFace[t] ?? 0;
      const texData = texDataCache[matIdx] ?? null;
      const matColor = matColors[matIdx] ?? 0xcccccc;

      let color: number;
      if (texData && uvAttr) {
        const u = (uvAttr.getX(i0) + uvAttr.getX(i1) + uvAttr.getX(i2)) / 3;
        const v = (uvAttr.getY(i0) + uvAttr.getY(i1) + uvAttr.getY(i2)) / 3;
        color = sampleTex(texData, u, v);
        if (matColor !== 0xffffff && matColor !== 0xcccccc) {
          const mr = (matColor >> 16) & 0xff,
            mg = (matColor >> 8) & 0xff,
            mb = matColor & 0xff;
          const tr = (color >> 16) & 0xff,
            tg = (color >> 8) & 0xff,
            tb = color & 0xff;
          color =
            (Math.round((tr * mr) / 255) << 16) |
            (Math.round((tg * mg) / 255) << 8) |
            Math.round((tb * mb) / 255);
        }
      } else if (colorAttr) {
        const r = (colorAttr.getX(i0) + colorAttr.getX(i1) + colorAttr.getX(i2)) / 3;
        const g = (colorAttr.getY(i0) + colorAttr.getY(i1) + colorAttr.getY(i2)) / 3;
        const b = (colorAttr.getZ(i0) + colorAttr.getZ(i1) + colorAttr.getZ(i2)) / 3;
        color = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
      } else {
        color = matColor;
      }

      const txMin = Math.min(pA.x, pB.x, pC.x),
        txMax = Math.max(pA.x, pB.x, pC.x);
      const tyMin = Math.min(pA.y, pB.y, pC.y),
        tyMax = Math.max(pA.y, pB.y, pC.y);
      const tzMin = Math.min(pA.z, pB.z, pC.z),
        tzMax = Math.max(pA.z, pB.z, pC.z);

      const ixMin = Math.max(0, Math.floor((txMin - box.min.x) / voxelWorldSize));
      const ixMax = Math.min(res, Math.ceil((txMax - box.min.x) / voxelWorldSize));
      const iyMin = Math.max(0, Math.floor((tyMin - box.min.y) / voxelWorldSize));
      const iyMax = Math.min(res, Math.ceil((tyMax - box.min.y) / voxelWorldSize));
      const izMin = Math.max(0, Math.floor((tzMin - box.min.z) / voxelWorldSize));
      const izMax = Math.min(res, Math.ceil((tzMax - box.min.z) / voxelWorldSize));

      for (let ix = ixMin; ix <= ixMax; ix++) {
        for (let iy = iyMin; iy <= iyMax; iy++) {
          for (let iz = izMin; iz <= izMax; iz++) {
            if (++cellTests > 50_000_000)
              throw new Error(
                'Mesh conversion exceeded its work budget. Use a simpler mesh or lower resolution.',
              );
            const vcx = box.min.x + (ix + 0.5) * voxelWorldSize;
            const vcy = box.min.y + (iy + 0.5) * voxelWorldSize;
            const vcz = box.min.z + (iz + 0.5) * voxelWorldSize;
            voxelBox.min.set(vcx - half, vcy - half, vcz - half);
            voxelBox.max.set(vcx + half, vcy + half, vcz + half);
            if (tri.intersectsBox(voxelBox)) {
              const key = `${ix},${iy},${iz}`;
              if (!voxelMap.has(key)) voxelMap.set(key, color);
              if (voxelMap.size > 250_000)
                throw new Error('Mesh conversion exceeds 250,000 voxels. Use a lower resolution.');
            }
          }
        }
      }
    }
  });

  const nxHalf = Math.round(size.x / voxelWorldSize / 2);
  const nzHalf = Math.round(size.z / voxelWorldSize / 2);
  const yFloor = CONFIG.FLOOR_Y + 1;
  return Array.from(voxelMap.entries()).map(([key, color]) => {
    const [ix, iy, iz] = key.split(',').map(Number);
    return { x: ix - nxHalf, y: iy + yFloor, z: iz - nzHalf, color };
  });
}
