import { applyProjectOperations, newProject, type ProjectDocument } from './projectDocument';
import { createConstructionExample } from './constructionExample';
export const exampleKinds = ['exploration', 'arena', 'survival', 'construction'] as const;
export type ExampleKind = (typeof exampleKinds)[number];
export function createExample(kind: ExampleKind, id: string): ProjectDocument {
  if (kind === 'construction') return createConstructionExample(createExample('survival', id));
  const p = newProject(
    id,
    kind === 'exploration' ? 'Crystal trail' : kind === 'arena' ? 'Clockwork arena' : 'Campfire survival',
  );
  const asset = (id: string, name: string, shapes: any[], voxelSize?: number) => ({
    type: 'asset.generate',
    id,
    name,
    ...(voxelSize === undefined ? {} : { voxelSize }),
    recipe: { version: 1, shapes },
  });
  const shape = (kind: string, center: number[], size: number[], color: number, material = 'STANDARD') => ({
    kind,
    center,
    size,
    color,
    material,
  });
  const node = (
    id: string,
    name: string,
    assetId: string | null,
    position: number[],
    components: any[] = [],
    extra: any = {},
  ) => ({ id, name, assetId, transform: { position }, components, ...extra });
  const common: any[] = [
    {
      type: 'asset.character',
      id: 'hero',
      name: kind === 'exploration' ? 'Trail fox' : kind === 'survival' ? 'Camp scout' : 'Explorer bot',
      profile: kind === 'exploration' ? 'quadruped' : kind === 'survival' ? 'biped' : 'machine',
      height: 18,
      width: 8,
      color: kind === 'exploration' ? 0xdd7d36 : 0x517cce,
      accent: 0xead7b0,
    },
    {
      type: 'equipment.fit',
      bodyId: 'hero',
      id: 'pack',
      name: 'Field backpack',
      kind: 'backpack',
      color: 0x4f7664,
    },
    {
      type: 'equipment.fit',
      bodyId: 'hero',
      id: 'armor',
      name: 'Fitted shell',
      kind: 'shell',
      color: 0x34586f,
    },
    {
      type: 'equipment.fit',
      bodyId: 'hero',
      id: 'armor-alt',
      name: 'Field shell',
      kind: 'shell',
      color: 0x3d6b57,
    },
    {
      type: 'equipment.fit',
      bodyId: 'hero',
      id: 'tool',
      name: 'Copper blade',
      kind: 'blade',
      color: 0xdfb381,
    },
    asset('crystal', 'Energy crystal', [shape('ellipsoid', [0, 7, 0], [6, 12, 6], 0x64e8ec, 'EMISSIVE')]),
    asset('gate', 'Crystal gate', [
      shape('box', [-22, 12, 0], [6, 24, 8], 0x607d72, 'METALLIC'),
      shape('box', [22, 12, 0], [6, 24, 8], 0x607d72, 'METALLIC'),
      shape('box', [0, 22, 0], [50, 4, 8], 0x8aafa0, 'METALLIC'),
    ]),
    asset('finish', 'Goal beacon', [
      shape('cylinder', [12, 1, 0], [28, 2, 28], 0x9bed9c, 'EMISSIVE'),
      shape('box', [12, 15, 0], [2, 30, 2], 0x9bed9c, 'EMISSIVE'),
    ]),
  ];
  const hero = node(
    'player',
    'Player',
    'hero',
    [0, 0, 8],
    [
      {
        type: 'player',
        style: kind === 'exploration' || kind === 'survival' ? 'third-person' : 'top-down',
        speed: 3,
        jump: 6,
      },
      { type: 'collider', size: [0.9, 1.6, 0.9], offset: [0, 0.8, 0], solid: true },
      { type: 'health', maximum: 100 },
      { type: 'animation', idle: 'idle', moving: 'walk' },
    ],
    {
      attachments: [
        { assetId: 'pack', socket: 'back', slot: 'back', transform: {} },
        { assetId: 'armor', socket: 'body', slot: 'body', transform: {}, hiddenBones: ['torso'] },
        ...(kind === 'arena' ? [{ assetId: 'tool', socket: 'hand', slot: 'hand', transform: {} }] : []),
      ],
    },
  );
  let nodes: any[] = [hero];
  if (kind === 'exploration') {
    common.push(
      asset('trail-path', 'Packed earth trail', [shape('box', [0, 0.5, 0], [21, 1, 128], 0x877152)], 0.2),
      asset('trail-tree', 'Trail tree', [
        shape('cylinder', [0, 11, 0], [3, 22, 3], 0x74543a),
        shape('ellipsoid', [0, 25, 0], [14, 14, 14], 0x28744d),
        shape('ellipsoid', [-4, 20, 2], [9, 10, 9], 0x3d8a59),
        shape('ellipsoid', [4, 20, -2], [9, 10, 9], 0x347f50),
      ]),
      asset('trail-stone', 'Mossy trail stone', [
        shape('ellipsoid', [0, 3, 0], [12, 6, 10], 0x66736c),
        shape('ellipsoid', [-2, 5, -1], [6, 3, 5], 0x71836f),
      ]),
      asset('trail-flower', 'Trail flower', [
        shape('box', [0, 3, 0], [1, 6, 1], 0x4d8647),
        shape('ellipsoid', [0, 6, 0], [4, 3, 4], 0xe6a4c0),
        shape('ellipsoid', [0, 6, 0], [2, 2, 2], 0xffd36e),
      ]),
    );
    nodes.push(node('trail-path', 'Packed earth trail', 'trail-path', [0, -0.08, -3]));
    const trees: [number, number][] = [
      [-7, 11],
      [7, 10],
      [-7, 4],
      [7, 2],
      [-7, -4],
      [7, -6],
      [-7, -12],
      [7, -14],
    ];
    trees.forEach(([x, z], index) =>
      nodes.push(node(`trail-tree-${index + 1}`, 'Trail tree', 'trail-tree', [x, 0, z])),
    );
    for (const side of [-1, 1]) {
      for (let index = 0; index < 4; index++) {
        const z = 9 - index * 6;
        nodes.push(
          node(`trail-stone-${side < 0 ? 'l' : 'r'}-${index + 1}`, 'Mossy trail stone', 'trail-stone', [
            side * 4.6,
            0,
            z,
          ]),
        );
      }
      for (let index = 0; index < 6; index++) {
        const z = 8 - index * 4;
        nodes.push(
          node(`trail-flower-${side < 0 ? 'l' : 'r'}-${index + 1}`, 'Trail flower', 'trail-flower', [
            side * (5 + (index % 2) * 0.5),
            0,
            z,
          ]),
        );
      }
    }
    for (let i = 0; i < 5; i++)
      nodes.push(
        node(
          `crystal-${i + 1}`,
          `Crystal ${i + 1}`,
          'crystal',
          [0, 0, 6 - i * 3],
          [
            { type: 'collectible', variable: 'crystals', amount: 1 },
            { type: 'collider', size: [1, 2, 1], offset: [0, 1, 0], solid: false },
          ],
        ),
      );
    nodes.push(
      node(
        'gate',
        'Five-crystal gate',
        'gate',
        [0, 0, -10],
        [
          { type: 'gate', variable: 'crystals', required: 5 },
          { type: 'collider', size: [5, 2.4, 0.4], offset: [0, 1.2, 0], solid: true },
        ],
      ),
    );
    nodes.push(
      node(
        'finish',
        'Finish',
        'finish',
        [0, 0, -12],
        [
          { type: 'collider', size: [3, 2, 2], offset: [0, 1, 0], solid: false },
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'touch',
                once: true,
                condition: { variable: 'crystals', op: '>=', value: 5 },
                actions: [
                  { type: 'message', text: 'All five crystals found. Trail complete!' },
                  { type: 'win' },
                ],
              },
            ],
          },
        ],
      ),
    );
  } else if (kind === 'arena') {
    common.push({
      type: 'asset.character',
      id: 'drone',
      name: 'Arena sentinel',
      profile: 'machine',
      height: 14,
      width: 7,
      color: 0x9c4f6d,
      accent: 0xffba87,
    });
    for (let i = 0; i < 3; i++)
      nodes.push(
        node(
          `sentinel-${i + 1}`,
          `Sentinel ${i + 1}`,
          'drone',
          [i * 3 - 3, 0, i === 1 ? -4 : 0],
          [
            { type: 'enemy', speed: 0.6, damage: 5, range: 1.2 },
            { type: 'health', maximum: 50 },
            { type: 'collider', size: [0.8, 1.4, 0.8], offset: [0, 0.7, 0], solid: false },
            { type: 'animation', idle: 'idle', moving: 'walk' },
          ],
        ),
      );
    nodes.push(
      node(
        'shell-pickup',
        'Field shell',
        'crystal',
        [1, 0, 7],
        [
          { type: 'collider', size: [0.8, 0.8, 0.8], offset: [0, 0.4, 0], solid: false },
          { type: 'collectible', itemId: 'field-shell', quantity: 1 },
        ],
      ),
    );
    nodes.push(
      node(
        'exit',
        'Arena exit',
        'finish',
        [0, 0, -9],
        [
          { type: 'collider', size: [4, 2, 2], offset: [0, 1, 0], solid: false },
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'touch',
                once: true,
                condition: { variable: 'kills', op: '>=', value: 3 },
                actions: [{ type: 'message', text: 'Sentinels defeated. Arena cleared!' }, { type: 'win' }],
              },
            ],
          },
        ],
      ),
    );
    for (let i = 0; i < 4; i++)
      nodes.push(
        node(
          `energy-${i}`,
          `Energy ${i + 1}`,
          'crystal',
          [i % 2 ? 6 : -6, 0, i < 2 ? 4 : -4],
          [{ type: 'collectible', variable: 'energy', amount: 1 }],
        ),
      );
  } else {
    common.push(
      asset('logs', 'Firewood bundle', [
        shape('cylinder', [-2, 2, 0], [4, 4, 4], 0x7b482e),
        shape('cylinder', [2, 2, 0], [4, 4, 4], 0x93603a),
        shape('cylinder', [0, 2, 2], [4, 4, 4], 0x69412d),
      ]),
      asset('stone', 'River stone', [shape('ellipsoid', [0, 3, 0], [7, 6, 7], 0x858b87)]),
      asset('pine', 'Pine tree', [
        shape('cylinder', [0, 9, 0], [3, 18, 3], 0x70513a),
        shape('ellipsoid', [0, 21, 0], [15, 16, 15], 0x3f7452),
      ]),
      asset('bench', 'Trail workbench', [
        shape('box', [0, 5, 0], [12, 2, 8], 0x94643e),
        shape('box', [-4, 2, -2], [2, 4, 2], 0x68482f),
        shape('box', [4, 2, -2], [2, 4, 2], 0x68482f),
        shape('box', [-4, 2, 2], [2, 4, 2], 0x68482f),
        shape('box', [4, 2, 2], [2, 4, 2], 0x68482f),
      ]),
      asset('campfire', 'Campfire', [
        shape('ellipsoid', [-4, 1, 0], [3, 2, 3], 0x777c78),
        shape('ellipsoid', [4, 1, 0], [3, 2, 3], 0x777c78),
        shape('ellipsoid', [0, 1, -4], [3, 2, 3], 0x777c78),
        shape('ellipsoid', [0, 1, 4], [3, 2, 3], 0x777c78),
        shape('ellipsoid', [0, 3, 0], [4, 5, 4], 0xf07834, 'EMISSIVE'),
        shape('ellipsoid', [0, 3, 0], [2, 4, 2], 0xffd264, 'EMISSIVE'),
      ]),
    );
    const pickup = (id: string, name: string, assetId: string, itemId: string, position: number[]) =>
      node(id, name, assetId, position, [
        { type: 'collider', size: [1.2, 1.2, 1.2], offset: [0, 0.6, 0], solid: false },
        { type: 'collectible', variable: 'materials', amount: 1, itemId, quantity: 1 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            { event: 'touch', once: true, actions: [{ type: 'add', variable: 'materials', value: 1 }] },
          ],
        },
      ]);
    nodes.push(
      ...[
        ['tree-west', 'Pine tree', 'pine', [-7, 0, 5]],
        ['tree-east', 'Pine tree', 'pine', [7, 0, -1]],
        ['tree-camp', 'Pine tree', 'pine', [-6, 0, -10]],
      ].map(([id, name, assetId, position]) =>
        node(id as string, name as string, assetId as string, position as number[]),
      ),
      pickup('wood-1', 'Firewood', 'logs', 'wood', [0, 0, 6]),
      pickup('wood-2', 'Firewood', 'logs', 'wood', [0, 0, 2]),
      pickup('stone-1', 'River stone', 'stone', 'stone', [0, 0, -2]),
      node(
        'workbench',
        'Trail workbench',
        'bench',
        [2.4, 0, -4],
        [
          { type: 'collider', size: [1.8, 1, 1.4], offset: [0, 0.5, 0], solid: false },
          { type: 'interactable', prompt: 'Craft a campfire', range: 3 },
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'interact',
                once: true,
                actions: [
                  { type: 'craft', recipeId: 'campfire', batches: 1 },
                  { type: 'set', variable: 'campfireBuilt', value: 1 },
                  { type: 'enable', target: 'campfire-site', value: true },
                  { type: 'message', text: 'Campfire crafted. Head to the campsite.' },
                ],
              },
            ],
          },
        ],
      ),
      node(
        'campfire-site',
        'Campsite',
        'campfire',
        [0, 0, -11],
        [
          { type: 'collider', size: [2, 1, 2], offset: [0, 0.5, 0], solid: false },
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'touch',
                once: true,
                condition: { itemId: 'campfire-kit', op: '>=', value: 1 },
                actions: [{ type: 'message', text: 'The camp is ready for the night.' }, { type: 'win' }],
              },
            ],
          },
        ],
        { enabled: false },
      ),
    );
  }
  const survival = kind === 'survival';
  const activeAssetIds: Record<Exclude<ExampleKind, 'construction'>, string[]> = {
    exploration: [
      'hero',
      'pack',
      'armor',
      'crystal',
      'gate',
      'finish',
      'trail-path',
      'trail-tree',
      'trail-stone',
      'trail-flower',
    ],
    arena: ['hero', 'pack', 'armor', 'armor-alt', 'tool', 'crystal', 'finish', 'drone'],
    survival: ['hero', 'pack', 'armor', 'logs', 'stone', 'pine', 'bench', 'campfire'],
  };
  return applyProjectOperations(p, [
    ...common.filter((operation) => activeAssetIds[kind].includes(operation.id)),
    {
      type: 'scene.put',
      scene: {
        id: 'main',
        name: kind === 'exploration' ? 'Crystal trail' : kind === 'arena' ? 'Arena' : 'Campfire trail',
        nodes,
        bounds: survival ? 24 : kind === 'exploration' ? 20 : 16,
        background: survival ? 0x9bb9c0 : kind === 'exploration' ? 0x1b303b : 0x29233c,
        groundColor: survival ? 0x536b49 : kind === 'exploration' ? 0x405e51 : 0x45475d,
        variables: survival
          ? { materials: 0, campfireBuilt: 0 }
          : kind === 'exploration'
            ? { crystals: 0 }
            : { kills: 0, energy: 0 },
        objectives:
          kind === 'exploration'
            ? [
                {
                  id: 'collect-crystals',
                  text: 'Collect all five crystals',
                  condition: { variable: 'crystals', op: '>=', value: 5 },
                },
              ]
            : kind === 'arena'
              ? [
                  {
                    id: 'find-shell',
                    text: 'Collect the field shell',
                    condition: { itemId: 'field-shell', op: '>=', value: 1 },
                  },
                  {
                    id: 'defeat-sentinels',
                    text: 'Defeat all three sentinels',
                    condition: { variable: 'kills', op: '>=', value: 3 },
                  },
                ]
              : survival
                ? [
                    {
                      id: 'gather-materials',
                      text: 'Gather the firewood and river stone',
                      condition: { variable: 'materials', op: '>=', value: 3 },
                    },
                    {
                      id: 'build-campfire',
                      text: 'Light the campfire',
                      condition: { variable: 'campfireBuilt', op: '>=', value: 1 },
                    },
                  ]
                : [],
        items:
          kind === 'arena'
            ? [
                {
                  id: 'field-shell',
                  name: 'Field shell',
                  description:
                    'A fitted shell for your Explorer bot. Use it to replace your current shell; the token stays in your inventory.',
                  maxStack: 1,
                  use: { type: 'equip', assetId: 'armor-alt' },
                },
              ]
            : survival
              ? [
                  {
                    id: 'wood',
                    name: 'Firewood',
                    description: 'Dry logs for a small campfire.',
                    maxStack: 10,
                  },
                  {
                    id: 'stone',
                    name: 'River stone',
                    description: 'A sturdy stone for the fire ring.',
                    maxStack: 10,
                  },
                  {
                    id: 'campfire-kit',
                    name: 'Campfire kit',
                    description: 'A bundle of wood and a ring of stone.',
                    maxStack: 1,
                  },
                ]
              : [],
        recipes:
          kind === 'survival'
            ? [
                {
                  id: 'campfire',
                  name: 'Campfire kit',
                  ingredients: [
                    { itemId: 'wood', quantity: 2 },
                    { itemId: 'stone', quantity: 1 },
                  ],
                  outputs: [{ itemId: 'campfire-kit', quantity: 1 }],
                },
              ]
            : [],
        instructions: survival
          ? 'Collect two firewood bundles and one river stone. Move to the workbench to craft a campfire kit, then reach the campsite.'
          : kind === 'exploration'
            ? 'Collect five crystals, then cross the gate to the beacon.'
            : kind === 'arena'
              ? 'Collect the nearby Field shell, equip it, defeat all three sentinels, then reach the beacon.'
              : 'Defeat all three sentinels, then reach the beacon.',
      },
    },
  ]);
}
export const exampleTests = {
  exploration: {
    sceneId: 'main',
    steps: [{ frames: 430, input: { moveZ: -1 } }],
    assertions: [
      { type: 'status', equals: 'won' },
      { type: 'variable', name: 'crystals', minimum: 5 },
      { type: 'objective', objectiveId: 'collect-crystals', equals: true },
      { type: 'enabled', nodeId: 'gate', equals: false },
      { type: 'active-scene', equals: 'main' },
      { type: 'health', nodeId: 'player', minimum: 100, maximum: 100 },
      { type: 'no-errors' },
    ],
  },
  arena: {
    sceneId: 'main',
    steps: [
      { frames: 8, input: { moveX: 1, moveZ: -1 } },
      { frames: 1, input: { useItem: 'field-shell' } },
      { frames: 1, input: {} },
      { frames: 240, input: { moveZ: -1 } },
      ...Array.from({ length: 45 }, () => [
        { frames: 20, input: { attack: true } },
        { frames: 1, input: {} },
      ]).flat(),
      { frames: 220, input: { moveZ: -1 } },
    ],
    assertions: [
      { type: 'status', equals: 'won' },
      { type: 'variable', name: 'kills', minimum: 3 },
      { type: 'objective', objectiveId: 'find-shell', equals: true },
      { type: 'objective', objectiveId: 'defeat-sentinels', equals: true },
      { type: 'inventory', itemId: 'field-shell', equals: 1 },
      { type: 'equipment', nodeId: 'player', assetId: 'armor-alt', equipped: true },
      { type: 'active-scene', equals: 'main' },
      { type: 'health', nodeId: 'player', minimum: 1 },
      { type: 'no-errors' },
    ],
  },
  survival: {
    sceneId: 'main',
    steps: [
      { frames: 240, input: { moveZ: -1 } },
      { frames: 1, input: { interact: true } },
      { frames: 1, input: {} },
      { frames: 160, input: { moveZ: -1 } },
    ],
    assertions: [
      { type: 'status', equals: 'won' },
      { type: 'variable', name: 'materials', minimum: 3 },
      { type: 'variable', name: 'campfireBuilt', minimum: 1 },
      { type: 'objective', objectiveId: 'gather-materials', equals: true },
      { type: 'objective', objectiveId: 'build-campfire', equals: true },
      { type: 'enabled', nodeId: 'campfire-site', equals: true },
      { type: 'enabled', nodeId: 'wood-1', equals: false },
      { type: 'enabled', nodeId: 'wood-2', equals: false },
      { type: 'enabled', nodeId: 'stone-1', equals: false },
      { type: 'inventory', itemId: 'wood', equals: 0 },
      { type: 'inventory', itemId: 'stone', equals: 0 },
      { type: 'inventory', itemId: 'campfire-kit', equals: 1 },
      { type: 'health', nodeId: 'player', minimum: 100, maximum: 100 },
      { type: 'scene-path', equals: ['main'] },
      { type: 'no-errors' },
    ],
  },
  construction: {
    sceneId: 'main',
    steps: [
      { frames: 120, input: {} },
      {
        frames: 1,
        terrainEdit: { x: 3, y: 1, z: 12, value: { color: 0x718c62, materialType: 'STANDARD' } },
      },
      { frames: 1, terrainEdit: { x: 3, y: 1, z: 12, value: null } },
      { frames: 1, terrainEdit: { x: 4, y: 1, z: 12, value: { color: 0x718c62, materialType: 'STANDARD' } } },
    ],
    assertions: [
      { type: 'status', equals: 'playing' },
      { type: 'terrain-cell', x: 3, y: 1, z: 12, value: null },
      { type: 'terrain-cell', x: 4, y: 1, z: 12, value: { color: 0x718c62, materialType: 'STANDARD' } },
      { type: 'position', nodeId: 'player', near: [0, 0.75, 18], tolerance: 0.05 },
      { type: 'inventory', itemId: 'stone', equals: 63 },
      { type: 'no-errors' },
    ],
  },
};
