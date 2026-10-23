import type { Asset, GameScene, SceneNode, SceneScatter } from './projectDocument';
import { createSeededRandom, createTerrainSurfaceSampler } from './terrainNoise';
import { createWorldCellSampler, type WorldDocument } from './worldDocument';

export const SCATTER_ASSET_MAX_VOXELS = 16 ** 3;
const columnKey = (x: number, z: number) => `${x},${z}`;

export function isScatterableAsset(asset: Asset) {
  return (
    !asset.rig &&
    asset.model.voxels.length > 0 &&
    asset.model.voxels.length <= SCATTER_ASSET_MAX_VOXELS &&
    !asset.model.voxels.some((voxel) => voxel.materialType === 'GLASS')
  );
}

/** Bake one deterministic scatter pass into ordinary, editable scene nodes. */
export function createScatterNodes(
  scene: GameScene,
  scatter: SceneScatter,
  asset: Asset,
  world?: WorldDocument,
): SceneNode[] {
  if (asset.rig || asset.model.voxels.some((voxel) => voxel.materialType === 'GLASS'))
    throw new Error('Scatter requires a static opaque voxel asset so repeated props can use GPU instancing.');
  if (!asset.model.voxels.length || asset.model.voxels.length > SCATTER_ASSET_MAX_VOXELS)
    throw new Error(
      `Scatter assets must contain 1–${SCATTER_ASSET_MAX_VOXELS} voxels for efficient instancing.`,
    );
  if (scatter.snapToTerrain && !world)
    throw new Error('Terrain snapping requires the scene to have a terrain world.');

  const random = createSeededRandom(scatter.seed);
  const surfaceAt = world && createTerrainSurfaceSampler(world);
  const cellAt = world && createWorldCellSampler(world);
  const topEdits = new Map<string, number>();
  if (world) {
    for (const edit of world.edits)
      if (edit.value) {
        const key = columnKey(edit.x, edit.z);
        if (edit.y <= world.generator.maxY && edit.y >= world.generator.minY)
          topEdits.set(key, Math.max(topEdits.get(key) ?? -Infinity, edit.y));
      }
    const [originX, originZ] = world.generator.origin;
    const [width, depth] = world.generator.size;
    const minX = (originX - 0.5) * world.voxelSize;
    const maxX = (originX + width - 0.5) * world.voxelSize;
    const minZ = (originZ - 0.5) * world.voxelSize;
    const maxZ = (originZ + depth - 0.5) * world.voxelSize;
    if (
      scatter.snapToTerrain &&
      (scatter.bounds.minX < minX ||
        scatter.bounds.maxX > maxX ||
        scatter.bounds.minZ < minZ ||
        scatter.bounds.maxZ > maxZ)
    )
      throw new Error('Terrain-scatter bounds must stay inside the selected world.');
  }

  const minVoxelY = asset.model.voxels.reduce((min, voxel) => Math.min(min, voxel.y), Infinity);
  const localBottomOffset =
    ((Number.isFinite(minVoxelY) ? minVoxelY : 0) - asset.pivot[1] - 0.5) * asset.voxelSize;
  const nodes: SceneNode[] = [];
  for (let index = 0; index < scatter.count; index++) {
    const x = scatter.bounds.minX + random() * (scatter.bounds.maxX - scatter.bounds.minX);
    const z = scatter.bounds.minZ + random() * (scatter.bounds.maxZ - scatter.bounds.minZ);
    const scale = scatter.scaleRange[0] + random() * (scatter.scaleRange[1] - scatter.scaleRange[0]);
    const rotationY = scatter.randomYaw ? random() * Math.PI * 2 : 0;
    let groundY = scatter.groundY;

    if (scatter.snapToTerrain && world && surfaceAt && cellAt) {
      const cellX = Math.floor(x / world.voxelSize + 0.5);
      const cellZ = Math.floor(z / world.voxelSize + 0.5);
      const key = columnKey(cellX, cellZ);
      let top = Math.max(surfaceAt(cellX, cellZ), topEdits.get(key) ?? -Infinity);
      while (top >= world.generator.minY && !cellAt({ x: cellX, y: top, z: cellZ })) top--;
      if (top < world.generator.minY)
        throw new Error(`Scatter placement ${index} has no solid terrain below it.`);
      groundY = (top + 0.5) * world.voxelSize;
    }

    const id = `${scatter.id}_s${index.toString(36)}`;
    nodes.push({
      id,
      name: `${asset.name} ${index + 1}`,
      assetId: asset.id,
      parentId: null,
      scatterGroupId: scatter.id,
      transform: {
        position: [x, groundY - localBottomOffset * scale, z],
        rotation: [0, rotationY, 0],
        scale: [scale, scale, scale],
      },
      enabled: true,
      components: [],
      attachments: [],
    });
  }
  return nodes;
}
