import test from 'node:test';
import assert from 'node:assert/strict';
import { createExample, exampleTests } from '../services/examples';
import { newProject, validateProject } from '../services/projectDocument';
import { playtestSchema, runPlaytest } from '../runtime/playtest';

function playtestProject() {
  const project = newProject('playtest-assertions', 'Playtest assertions');
  project.scenes[0].items = [
    { id: 'ore', name: 'Ore', description: '', maxStack: 4 },
    { id: 'wood', name: 'Wood', description: '', maxStack: 10 },
  ];
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'start',
              once: false,
              interval: 1,
              actions: [
                { type: 'damage', target: 'player', amount: 25 },
                { type: 'add', variable: 'score', value: 1 },
              ],
            },
          ],
        },
      ],
      attachments: [],
    },
    {
      id: 'ore-pickup',
      name: 'Ore pickup',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'collider', size: [0.5, 0.5, 0.5], offset: [0, 0.25, 0], solid: false },
        { type: 'collectible', variable: 'score', amount: 1, itemId: 'ore', quantity: 9 },
      ],
      attachments: [],
    },
  ];
  return validateProject(project);
}

test('playtest assertions inspect active scene, summed inventory stacks, health bounds and route', async () => {
  const project = playtestProject();
  project.scenes[0].objectives = [
    { id: 'score-goal', text: 'Score a point', condition: { variable: 'score', op: '>=', value: 1 } },
    { id: 'ore-goal', text: 'Collect all ore', condition: { itemId: 'ore', op: '>=', value: 9 } },
  ];
  const result = await runPlaytest(project, {
    sceneId: 'main',
    steps: [{ frames: 1 }],
    assertions: [
      { type: 'active-scene', equals: 'main' },
      { type: 'inventory', itemId: 'ore', equals: 9 },
      { type: 'inventory', itemId: 'wood', equals: 0 },
      { type: 'health', nodeId: 'player', minimum: 75, maximum: 75 },
      { type: 'objective', objectiveId: 'score-goal', equals: true },
      { type: 'objective', objectiveId: 'ore-goal', equals: true },
      { type: 'scene-path', equals: ['main'] },
      { type: 'no-errors' },
    ],
  });

  assert.equal(result.passed, true, JSON.stringify(result.assertions));
  assert.deepEqual(
    result.state.inventory.map(({ itemId, quantity }) => [itemId, quantity]),
    [
      ['ore', 4],
      ['ore', 4],
      ['ore', 1],
    ],
  );
  assert.deepEqual(
    result.assertions.map(({ passed, actual }) => [passed, actual]),
    [
      [true, 'main'],
      [true, 9],
      [true, 0],
      [true, 75],
      [true, true],
      [true, true],
      [true, ['main']],
      [true, []],
    ],
  );
});

test('playtests can pause, dispatch pause-menu events and resume through agent input', async () => {
  const project = playtestProject();
  project.scenes[0]!.variables.menuOpened = 0;
  const rules = project.scenes[0]!.nodes[0]!.components.find((component) => component.type === 'rules');
  assert.equal(rules?.type, 'rules');
  if (rules?.type !== 'rules') throw new Error('Player rules fixture is missing.');
  rules.rules.push({
    event: 'ui',
    eventId: 'paused-menu',
    once: false,
    interval: 1,
    actions: [{ type: 'set', variable: 'menuOpened', value: 1 }],
  });

  const result = await runPlaytest(validateProject(project), {
    sceneId: 'main',
    steps: [
      { frames: 3, input: { togglePause: true } },
      { frames: 1, input: { uiEventId: 'paused-menu' } },
      { frames: 2, input: { togglePause: true } },
    ],
    assertions: [
      { type: 'paused', equals: false },
      { type: 'variable', name: 'menuOpened', minimum: 1 },
      { type: 'no-errors' },
    ],
  });

  assert.equal(result.passed, true, JSON.stringify(result.assertions));
  assert.equal(result.state.paused, false);
  assert.equal(result.state.frame, 1, 'the pause and UI-only steps do not advance simulation time');
});

test('objective playtest assertions fail clearly for incomplete and missing goals', async () => {
  const project = playtestProject();
  project.scenes[0].objectives = [
    { id: 'score-goal', text: 'Score ten points', condition: { variable: 'score', op: '>=', value: 10 } },
  ];
  const result = await runPlaytest(project, {
    sceneId: 'main',
    steps: [{ frames: 1 }],
    assertions: [
      { type: 'objective', objectiveId: 'score-goal', equals: true },
      { type: 'objective', objectiveId: 'missing-goal', equals: false },
    ],
  });
  assert.equal(result.assertions[0].passed, false);
  assert.deepEqual(result.assertions[0].actual, false);
  assert.equal(result.assertions[1].passed, false);
  assert.equal(result.assertions[1].actual, null);
  assert.match(result.assertions[1].message!, /Expected.*missing-goal/);
});

test('playtests can use an authored health item through the shared runtime input', async () => {
  const project = playtestProject();
  project.scenes[0].items.push({
    id: 'medkit',
    name: 'Medkit',
    description: '',
    maxStack: 4,
    use: { type: 'heal', amount: 25 },
  });
  const rules = project.scenes[0].nodes[0].components.find((component) => component.type === 'rules');
  assert.equal(rules?.type, 'rules');
  if (rules?.type !== 'rules') throw new Error('Player rules fixture is missing.');
  rules.rules[0].actions.push({
    type: 'inventory',
    remove: [],
    add: [{ itemId: 'medkit', quantity: 1 }],
  });

  const result = await runPlaytest(validateProject(project), {
    sceneId: 'main',
    steps: [{ frames: 1, input: { useItem: 'medkit' } }],
    assertions: [
      { type: 'health', nodeId: 'player', minimum: 100, maximum: 100 },
      { type: 'inventory', itemId: 'medkit', equals: 0 },
      { type: 'no-errors' },
    ],
  });

  assert.equal(result.passed, true, JSON.stringify(result.assertions));
  assert.ok(result.state.events.some((event) => event.type === 'item-used'));
});

test('playtests can assert a fitted gear asset after collecting and using its item', async () => {
  const result = await runPlaytest(
    validateProject(createExample('arena', 'playtest-equipment-assertion')),
    exampleTests.arena,
  );

  assert.equal(result.passed, true, JSON.stringify(result.assertions));
  assert.deepEqual(
    result.assertions
      .filter((assertion) => assertion.assertion.type === 'equipment')
      .map((assertion) => [assertion.passed, assertion.actual]),
    [[true, true]],
  );
});

test('failed playtest assertions return expected, actual and a useful failure message', async () => {
  const result = await runPlaytest(playtestProject(), {
    sceneId: 'main',
    steps: [{ frames: 1 }],
    assertions: [
      { type: 'active-scene', equals: 'other-scene' },
      { type: 'inventory', itemId: 'missing-item', equals: 0 },
      { type: 'health', nodeId: 'missing-node', minimum: 0 },
      { type: 'health', nodeId: 'ore-pickup', maximum: 100 },
      { type: 'health', nodeId: 'player', minimum: 80, maximum: 90 },
      { type: 'scene-path', equals: ['main', 'other-scene'] },
    ],
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.assertions.map(({ passed, expected, actual, message }) => [passed, expected, actual, message]),
    [
      [false, 'other-scene', 'main', 'Expected "other-scene", got "main".'],
      [
        false,
        { itemId: 'missing-item', quantity: 0 },
        null,
        'Expected {"itemId":"missing-item","quantity":0}, got null.',
      ],
      [
        false,
        { nodeId: 'missing-node', minimum: 0 },
        null,
        'Expected {"nodeId":"missing-node","minimum":0}, got null.',
      ],
      [
        false,
        { nodeId: 'ore-pickup', maximum: 100 },
        null,
        'Expected {"nodeId":"ore-pickup","maximum":100}, got null.',
      ],
      [
        false,
        { nodeId: 'player', minimum: 80, maximum: 90 },
        75,
        'Expected {"nodeId":"player","minimum":80,"maximum":90}, got 75.',
      ],
      [false, ['main', 'other-scene'], ['main'], 'Expected ["main","other-scene"], got ["main"].'],
    ],
  );
});

test('playtest assertion schema rejects invalid IDs and unbounded or contradictory expectations', () => {
  const valid = { sceneId: 'main', steps: [], assertions: [] };
  for (const assertion of [
    { type: 'active-scene', equals: 'not a valid id' },
    { type: 'inventory', itemId: 'not a valid id', equals: 0 },
    { type: 'inventory', itemId: 'ore', equals: 1.5 },
    { type: 'inventory', itemId: 'ore', equals: 1000001 },
    { type: 'health', nodeId: 'player' },
    { type: 'health', nodeId: 'player', minimum: 90, maximum: 80 },
    { type: 'health', nodeId: 'not a valid id', minimum: 0 },
    { type: 'health', nodeId: 'player', minimum: -1 },
    { type: 'scene-path', equals: [] },
    { type: 'scene-path', equals: Array.from({ length: 65 }, () => 'main') },
    { type: 'scene-path', equals: ['not a valid id'] },
  ]) {
    assert.equal(
      playtestSchema.safeParse({ ...valid, assertions: [assertion] }).success,
      false,
      JSON.stringify(assertion),
    );
  }
  assert.equal(playtestSchema.safeParse({ ...valid, sceneId: 'not a valid id' }).success, false);
  assert.deepEqual(
    playtestSchema.parse({ ...valid, steps: [{ frames: 2, input: { moveX: 1, sprint: true } }] }).steps[0]
      .input,
    { moveX: 1, sprint: true },
  );
});

test('playtest fails cleanly for a well-formed but missing entry scene ID', async () => {
  await assert.rejects(
    runPlaytest(playtestProject(), { sceneId: 'missing-scene', steps: [], assertions: [] }),
    /Scene not found\./,
  );
});
