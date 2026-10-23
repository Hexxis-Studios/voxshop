import { newProject, nodeSchema, validateProject, type Component } from '../../services/projectDocument';
import { worldDocumentSchema } from '../../services/worldDocument';

type Construction = Extract<Component, { type: 'construction' }>;

export function constructionProject(
  settings: Partial<Construction> = {},
  { voxelSize = 1, slots = 4, id = 'construction-game' } = {},
) {
  const project = newProject(id, 'Construction game');
  project.worlds = [
    worldDocumentSchema.parse({
      id: 'terrain',
      name: 'Terrain',
      seed: 17,
      chunkSize: 16,
      voxelSize,
      generator: {
        type: 'terrain',
        version: 1,
        mode: 'voxel3d',
        origin: [-8, -8],
        size: [16, 16],
        minY: -4,
        maxY: 16,
        baseHeight: 0,
        amplitude: 0,
        palette: { surface: 0x55aa44, subsurface: 0x725439, deep: 0x686b70, materialType: 'STANDARD' },
      },
    }),
  ];
  project.scenes[0].worldId = 'terrain';
  project.scenes[0].items = [
    { id: 'stone', name: 'Stone block', description: '', maxStack: 99 },
    { id: 'coin', name: 'Coin', description: '', maxStack: 99 },
  ];
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'player',
      name: 'Builder',
      transform: { position: [0, 4 * voxelSize, 0] },
      components: [
        { type: 'player', style: 'third-person', speed: 3 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
        { type: 'inventory', slots },
        {
          type: 'construction',
          placeCost: [{ itemId: 'stone', quantity: 1 }],
          removeYield: [{ itemId: 'stone', quantity: 1 }],
          ...settings,
        },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'start',
              once: true,
              actions: [{ type: 'inventory', add: [{ itemId: 'stone', quantity: 2 }] }],
            },
          ],
        },
      ],
    }),
  ];
  return validateProject(project);
}
