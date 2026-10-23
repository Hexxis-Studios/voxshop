import { sculptedAsset } from './assetAssembly';
import { createModelDocument } from './modelDocument';
import { apiJson } from './localApi';
import { assetSchema, type ProjectDocument, type SceneNode, type Asset } from './projectDocument';

const uid = () => crypto.randomUUID();
const readLegacyArray = (key: string) => {
  const raw = localStorage.getItem(key);
  if (raw === null) return { entries: [] as unknown[], skipped: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? { entries: parsed as unknown[], skipped: 0 }
      : { entries: [] as unknown[], skipped: 1 };
  } catch {
    return { entries: [] as unknown[], skipped: 1 };
  }
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const legacyOffset = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value * 0.1 : 0;

// One-time, reversible migration: old browser data remains intact and can be imported again explicitly.
export async function migrateLegacyProject(p: ProjectDocument) {
  if (localStorage.getItem('voxshop-project-migration-v1') || p.assets.length) return null;

  const builds = readLegacyArray('voxelBuilderCustomBuilds');
  const rebuilds = readLegacyArray('voxelBuilderCustomRebuilds');
  const oldScene = readLegacyArray('voxelBuilderSceneObjects');
  const assets: Asset[] = [];
  const nodes: SceneNode[] = [];
  let skipped = builds.skipped + rebuilds.skipped + oldScene.skipped;
  for (const model of [...builds.entries, ...rebuilds.entries])
    try {
      if (!record(model)) throw new Error('Legacy model must be an object.');
      const asset = assetSchema.parse({
        id: uid(),
        name: model.name,
        model: createModelDocument(model.data, model.skeleton),
        voxelSize: 0.1,
        source: { kind: 'imported', description: 'Legacy browser library' },
      });
      assets.push(sculptedAsset(asset, asset.model));
    } catch {
      skipped++;
    }
  for (const object of oldScene.entries)
    try {
      if (!record(object)) throw new Error('Legacy scene object must be an object.');
      const asset = assetSchema.parse({
        id: uid(),
        name: object.name,
        model: createModelDocument(object.data),
        voxelSize: 0.1,
      });
      assets.push(asset);
      nodes.push({
        id: uid(),
        name: asset.name,
        assetId: asset.id,
        parentId: null,
        enabled: true,
        components: [],
        attachments: [],
        transform: {
          position: [legacyOffset(object.offsetX), 0, legacyOffset(object.offsetZ)],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      });
    } catch {
      skipped++;
    }

  let project: ProjectDocument | null = null;
  let importedCount = 0;
  if (assets.length) {
    const result = await apiJson<{ project: ProjectDocument }>(`/api/projects/${p.id}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: p.revision,
        requestId: uid(),
        label: 'Import legacy browser library',
        operations: [
          ...assets.map((asset) => ({ type: 'asset.put', asset })),
          { type: 'scene.put', scene: { ...p.scenes[0], nodes } },
        ],
      }),
    });
    project = result.project;
    importedCount = result.project.assets.length;
  }
  if (project || skipped === 0) localStorage.setItem('voxshop-project-migration-v1', p.id);
  return project || skipped ? { project, importedCount, skipped } : null;
}
