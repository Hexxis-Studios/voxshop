import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSimulation } from '../runtime/GameSimulation';
import { GameSession } from '../runtime/GameSession';
import { GameViewport } from '../runtime/GameViewport';
import { runPlaytest } from '../runtime/playtest';
import { constructionProject } from './fixtures/constructionProject';
import { nodeSchema, validateProject, type ConstructionPaint } from '../services/projectDocument';

const palette: ConstructionPaint[] = [
  { id: 'timber', name: 'Timber', color: 0x985b3b, materialType: 'STANDARD' },
  { id: 'glass', name: 'Glass', color: 0xaabbdd, materialType: 'GLASS' },
  { id: 'lamp', name: 'Lamp', color: 0xffdd88, materialType: 'EMISSIVE' },
];

test('construction paint selection is detached, scene-local and compatible with old checkpoints', () => {
  const project = constructionProject({ palette }),
    source = structuredClone(project),
    session = new GameSession(project, 'main');
  let resumed: GameSession | undefined;
  try {
    assert.equal(session.simulation.constructionState()!.selectedId, 'timber');
    const inspection = session.simulation.inspect();
    inspection.construction!.palette[0].color = 0;
    assert.equal(session.simulation.constructionState()!.palette[0].color, 0x985b3b);
    assert.equal(session.simulation.selectConstructionPaint('glass'), true);
    const saved = JSON.parse(JSON.stringify(session.progressSnapshot()));
    resumed = new GameSession(project, 'main', saved);
    assert.equal(resumed.simulation.progressRestored, true);
    assert.equal(resumed.simulation.constructionState()!.selectedId, 'glass');
    const before = resumed.simulation.progressSnapshot()!,
      invalid = structuredClone(before);
    invalid.behavior!.constructionPaint = 'removed-paint';
    invalid.variables.changed = 123;
    assert.equal(resumed.simulation.restoreProgress(invalid), false);
    assert.deepEqual(resumed.simulation.progressSnapshot(), before);
    assert.equal(resumed.simulation.selectConstructionPaint('missing'), false);
    assert.equal(resumed.simulation.constructionState()!.selectedId, 'glass');
    const legacy = structuredClone(before);
    delete legacy.behavior;
    assert.equal(resumed.simulation.restoreProgress(legacy), true);
    assert.equal(resumed.simulation.constructionState()!.selectedId, 'timber');
    resumed.simulation.status = 'won';
    resumed.simulation.message = 'Finished building.';
    assert.equal(resumed.simulation.selectConstructionPaint('lamp'), false);
    assert.equal(resumed.simulation.message, 'Finished building.');
    assert.deepEqual(project, source);
  } finally {
    session.dispose();
    resumed?.dispose();
  }
});

test('viewport selects paint before placement and preserves costs, harvest yields and invalid requests', () => {
  const session = new GameSession(constructionProject({ palette }), 'main');
  let hitY = 3.5,
    rebuilds = 0;
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    session,
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } },
    terrainHit: () => ({ point: [2, hitY, 0], normal: [0, 1, 0], coarseSurface: false }),
    syncTerrainRenderer() {
      rebuilds++;
    },
  }) as GameViewport;
  try {
    viewport.step({ constructionPaint: 'glass', placeCell: true });
    assert.deepEqual(session.simulation.inspectTerrainCell({ x: 2, y: 4, z: 0 }), {
      color: 0xaabbdd,
      materialType: 'GLASS',
    });
    assert.deepEqual(session.simulation.inventory, [{ itemId: 'stone', quantity: 1 }]);
    const before = session.progressSnapshot();
    assert.throws(
      () => viewport.step({ constructionPaint: 'missing', placeCell: true }),
      /available construction paint/,
    );
    assert.deepEqual(session.progressSnapshot(), before);
    viewport.step({ constructionPaint: 'lamp', placeCell: true });
    assert.deepEqual(
      session.simulation.inventory,
      [{ itemId: 'stone', quantity: 1 }],
      'occupied placement spends nothing',
    );
    hitY = 4.5;
    viewport.step({ removeCell: true });
    assert.equal(session.simulation.inspectTerrainCell({ x: 2, y: 4, z: 0 }), null);
    assert.deepEqual(session.simulation.inventory, [{ itemId: 'stone', quantity: 2 }]);
    assert.equal(rebuilds, 2);
  } finally {
    session.dispose();
  }
});

test('agent playtests choose authored paint while retaining explicit per-cell color control', async () => {
  const project = constructionProject({ palette }),
    original = structuredClone(project),
    customCell = { x: 2, y: 4, z: 0, value: { color: 0x9933bb, materialType: 'METALLIC' } };
  const report = await runPlaytest(project, {
    sceneId: 'main',
    steps: [{ frames: 1, input: { constructionPaint: 'lamp' }, terrainEdit: customCell }],
    assertions: [
      { type: 'construction-paint', equals: 'lamp' },
      { type: 'terrain-cell', ...customCell },
      { type: 'inventory', itemId: 'stone', equals: 1 },
      { type: 'no-errors' },
    ],
  });
  assert.equal(report.passed, true, JSON.stringify(report.assertions));
  await assert.rejects(
    runPlaytest(project, {
      sceneId: 'main',
      steps: [{ frames: 1, input: { constructionPaint: 'missing' } }],
      assertions: [],
    }),
    /available construction paint/,
  );
  const legacy = new GameSimulation(constructionProject());
  assert.equal(legacy.constructionState(), null);
  legacy.dispose();
  assert.deepEqual(project, original);
});

test('a viewport selection applies once before a transition and each scene retains its own paint', () => {
  const project = constructionProject({ palette }),
    first = project.scenes[0],
    second = structuredClone(first);
  second.id = 'second';
  second.nodes[0].components.find((component) => component.type === 'construction')!.palette = [
    { id: 'ice', name: 'Ice', color: 0xbeddff, materialType: 'GLASS' },
  ];
  for (const [scene, destination, z] of [
    [first, 'second', 1],
    [second, 'main', 6],
  ] as const) {
    scene.nodes.push(
      nodeSchema.parse({
        id: 'portal',
        name: 'Portal',
        transform: { position: [0, 4, z] },
        components: [
          { type: 'interactable', prompt: 'Travel', range: 3 },
          {
            type: 'rules',
            apiVersion: 1,
            rules: [{ event: 'interact', actions: [{ type: 'transition', sceneId: destination }] }],
          },
        ],
      }),
    );
  }
  project.scenes.push(second);
  const session = new GameSession(validateProject(project), 'main'),
    viewport = Object.assign(Object.create(GameViewport.prototype), { session }) as GameViewport;
  try {
    viewport.step({ constructionPaint: 'lamp', interact: true }, 2);
    assert.equal(session.simulation.scene.id, 'second');
    assert.equal(
      session.simulation.frame,
      1,
      'the original selection is not replayed in the destination with a different palette',
    );
    assert.equal(session.simulation.constructionState()!.selectedId, 'ice');
    assert.equal(session.simulation.selectConstructionPaint('ice'), true);
    session.simulation.nodes.get('player')!.transform.position = [0, 4, 5];
    viewport.step({});
    viewport.step({ interact: true });
    assert.equal(session.simulation.scene.id, 'main');
    assert.equal(session.simulation.constructionState()!.selectedId, 'lamp');
  } finally {
    session.dispose();
  }
});
