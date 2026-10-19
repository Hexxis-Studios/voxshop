import { applyProjectOperations, newProject, type ProjectDocument } from './projectDocument';
export type ExampleKind = 'exploration' | 'arena';
export function createExample(kind: ExampleKind, id: string): ProjectDocument {
  const p = newProject(id, kind === 'exploration' ? 'Crystal trail' : 'Clockwork arena');
  const asset = (id: string, name: string, shapes: any[]) => ({
    type: 'asset.generate',
    id,
    name,
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
      name: kind === 'exploration' ? 'Trail fox' : 'Explorer bot',
      profile: kind === 'exploration' ? 'quadruped' : 'machine',
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
      id: 'tool',
      name: 'Copper blade',
      kind: 'blade',
      color: 0xdfb381,
    },
    asset('crystal', 'Energy crystal', [shape('ellipsoid', [0, 7, 0], [6, 12, 6], 0x64e8ec, 'EMISSIVE')]),
    asset('wall', 'Stone block', [shape('box', [0, 5, 0], [10, 10, 10], 0x64726d)]),
    asset('gate', 'Barrier', [shape('box', [0, 12, 0], [50, 24, 4], 0x66a8a2, 'METALLIC')]),
    asset('finish', 'Goal beacon', [
      shape('cylinder', [0, 1, 0], [20, 2, 20], 0x9bed9c, 'EMISSIVE'),
      shape('box', [0, 15, 0], [2, 30, 2], 0x9bed9c, 'EMISSIVE'),
    ]),
  ];
  const hero = node(
    'player',
    'Player',
    'hero',
    [0, 0, 8],
    [
      { type: 'player', style: kind === 'exploration' ? 'third-person' : 'top-down', speed: 3, jump: 6 },
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
    for (const side of [-1, 1])
      for (let i = 0; i < 12; i++)
        nodes.push(
          node(
            `border-${side < 0 ? 'l' : 'r'}-${i}`,
            'Trail boundary',
            'wall',
            [side * 3, 0.5, -14 + i * 2],
            [{ type: 'collider', size: [1, 2, 2], solid: true }],
            { transform: { position: [side * 3, 0.5, -14 + i * 2], scale: [1, 2, 2] } },
          ),
        );
  } else {
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
  }
  return applyProjectOperations(p, [
    ...common,
    {
      type: 'scene.put',
      scene: {
        id: 'main',
        name: kind === 'exploration' ? 'Crystal trail' : 'Arena',
        nodes,
        bounds: kind === 'exploration' ? 20 : 16,
        background: kind === 'exploration' ? 0x1b303b : 0x29233c,
        groundColor: kind === 'exploration' ? 0x405e51 : 0x45475d,
        variables: kind === 'exploration' ? { crystals: 0 } : { kills: 0, energy: 0 },
        instructions:
          kind === 'exploration'
            ? 'WASD / arrows to explore. Space to jump. Collect five crystals, then cross the gate to the beacon.'
            : 'WASD / arrows to move. F or click to strike nearby sentinels. Defeat all three, then reach the beacon.',
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
      { type: 'enabled', nodeId: 'gate', equals: false },
      { type: 'no-errors' },
    ],
  },
  arena: {
    sceneId: 'main',
    steps: [
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
      { type: 'no-errors' },
    ],
  },
};
