import { validateProject, nodeSchema, type ProjectDocument } from './projectDocument';
import { worldDocumentSchema } from './worldDocument';

export function createConstructionExample(survivalProject: ProjectDocument): ProjectDocument {
  const project = structuredClone(survivalProject);
  project.name = 'Voxel workshop';
  const scene = project.scenes.find((candidate) => candidate.id === 'main');
  const player = scene?.nodes.find((node) =>
    node.components.some((component) => component.type === 'player'),
  );
  if (!scene || !player) throw new Error('The survival starter needs a main scene and player.');

  const keptAssets = new Set([
    ...(player.assetId ? [player.assetId] : []),
    ...player.attachments.map((attachment) => attachment.assetId),
  ]);
  project.assets = project.assets.filter((asset) => keptAssets.has(asset.id));
  project.worlds = [
    worldDocumentSchema.parse({
      id: 'construction-world',
      name: 'Flat building field',
      seed: 418,
      chunkSize: 16,
      voxelSize: 1.5,
      generator: {
        type: 'terrain',
        version: 1,
        mode: 'voxel3d',
        origin: [-24, -24],
        size: [48, 48],
        minY: -8,
        maxY: 8,
        baseHeight: 0,
        amplitude: 0,
        noise: 0,
        palette: {
          surface: 0x718c62,
          subsurface: 0x76624d,
          deep: 0x56473c,
          surfaceDepth: 1,
          subsurfaceDepth: 3,
          materialType: 'STANDARD',
        },
      },
      edits: [],
    }),
  ];

  const constructionPlayer = nodeSchema.parse({
    ...player,
    transform: { ...player.transform, position: [0, 0.75, 18] },
    components: [
      ...player.components.filter(
        (component) =>
          component.type !== 'inventory' && component.type !== 'construction' && component.type !== 'rules',
      ),
      { type: 'inventory', slots: 24 },
      {
        type: 'construction',
        place: true,
        remove: true,
        range: 6,
        placeCost: [{ itemId: 'stone', quantity: 1 }],
        removeYield: [{ itemId: 'stone', quantity: 1 }],
        palette: [
          { id: 'grass', name: 'Grass', color: 0x718c62, materialType: 'STANDARD' },
          { id: 'timber', name: 'Timber', color: 0xa66f46, materialType: 'STANDARD' },
          { id: 'metal', name: 'Metal', color: 0x9aa3b0, materialType: 'METALLIC' },
          { id: 'glass', name: 'Glass', color: 0x9bcdd8, materialType: 'GLASS' },
          { id: 'lamp', name: 'Lamp', color: 0xffd477, materialType: 'EMISSIVE' },
        ],
      },
      {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'start',
            once: true,
            actions: [{ type: 'inventory', add: [{ itemId: 'stone', quantity: 64 }] }],
          },
        ],
      },
    ],
  });

  scene.name = 'Construction field';
  scene.worldId = 'construction-world';
  scene.nodes = [constructionPlayer];
  scene.bounds = 36;
  scene.background = 0x9bb9c0;
  scene.groundColor = 0x536b49;
  scene.variables = {};
  scene.objectives = [];
  scene.items = [
    {
      id: 'stone',
      name: 'Building blocks',
      description: 'A reusable supply for shaping the terrain.',
      maxStack: 99,
    },
  ];
  scene.recipes = [];
  scene.instructions =
    'Start with 64 building blocks. Choose a construction color, place cells, and harvest them; each action costs or returns one building block.';
  project.activeSceneId = scene.id;
  project.activeAssetId = null;
  project.editorDraft = null;

  return validateProject(project);
}
