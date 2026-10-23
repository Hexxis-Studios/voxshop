import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ObjectiveEditor from '../components/ObjectiveEditor';
import SceneSettings from '../components/SceneSettings';
import { GameSimulation } from '../runtime/GameSimulation';
import { renderGameHtml } from '../runtime/gameExport';
import { createExample } from '../services/examples';
import { newProject, sceneSchema, validateProject } from '../services/projectDocument';

function reactElements(
  node: React.ReactNode,
): React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(reactElements);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
  return [element, ...reactElements(element.props.children)];
}

test('legacy scenes default to no objectives and objective conditions use existing rule shapes', () => {
  const scene = sceneSchema.parse({ id: 'main', name: 'Main' });
  assert.deepEqual(scene.objectives, []);

  const withObjectives = sceneSchema.parse({
    ...scene,
    objectives: [
      { id: 'find-key', text: 'Find the key', condition: { itemId: 'key', op: '>=', value: 1 } },
      {
        id: 'reach-score',
        text: 'Reach 10 points',
        condition: { variable: 'score', op: '>=', value: 10 },
        requires: ['find-key'],
      },
    ],
  });
  assert.equal(withObjectives.objectives.length, 2);
  assert.deepEqual(withObjectives.objectives[1]?.requires, ['find-key']);
  assert.equal(
    sceneSchema.safeParse({
      ...scene,
      objectives: Array.from({ length: 17 }, (_, index) => ({
        id: `goal-${index}`,
        text: 'Goal',
        condition: { variable: 'score', op: '>=', value: 1 },
      })),
    }).success,
    false,
  );
});

test('project validation rejects duplicate objective IDs and missing inventory references', () => {
  const project = newProject('objective-validation', 'Objective validation');
  project.scenes[0].items = [{ id: 'key', name: 'Key', description: '', maxStack: 10 }];
  project.scenes[0].objectives = [
    { id: 'goal', text: 'Find a key', condition: { itemId: 'key', op: '>=', value: 1 } },
  ];
  assert.equal(validateProject(project).scenes[0].objectives.length, 1);

  const missing = structuredClone(project);
  missing.scenes[0].objectives[0]!.condition = { itemId: 'missing', op: '>=', value: 1 };
  assert.throws(() => validateProject(missing), /Objective condition references a missing item/);

  const duplicate = structuredClone(project);
  duplicate.scenes[0].objectives.push({
    id: 'goal',
    text: 'Another goal',
    condition: { variable: 'score', op: '>=', value: 1 },
  });
  assert.throws(() => validateProject(duplicate), /Duplicate objective ID/);
});

test('project validation rejects invalid objective prerequisite references and cycles', () => {
  const project = newProject('objective-prerequisites', 'Objective prerequisites');
  project.scenes[0].objectives = [
    { id: 'first', text: 'First', condition: { variable: 'first', op: '>=', value: 1 } },
    {
      id: 'second',
      text: 'Second',
      condition: { variable: 'second', op: '>=', value: 1 },
      requires: ['first'],
    },
  ];
  assert.equal(validateProject(project).scenes[0].objectives[1]?.requires?.[0], 'first');

  const missing = structuredClone(project);
  missing.scenes[0]!.objectives[1]!.requires = ['missing'];
  assert.throws(() => validateProject(missing), /invalid prerequisite/);

  const self = structuredClone(project);
  self.scenes[0]!.objectives[0]!.requires = ['first'];
  assert.throws(() => validateProject(self), /invalid prerequisite/);

  const repeated = structuredClone(project);
  repeated.scenes[0]!.objectives[1]!.requires = ['first', 'first'];
  assert.throws(() => validateProject(repeated), /Duplicate prerequisite on objective second/);

  const cycle = structuredClone(project);
  cycle.scenes[0]!.objectives[0]!.requires = ['second'];
  assert.throws(() => validateProject(cycle), /cannot contain a cycle/);
});

test('genre starters teach objectives through playable goals while construction stays open ended', () => {
  const exploration = createExample('exploration', 'objective-example-exploration'),
    arena = createExample('arena', 'objective-example-arena'),
    survival = createExample('survival', 'objective-example-survival'),
    construction = createExample('construction', 'objective-example-construction');
  assert.deepEqual(
    [exploration, arena, survival, construction].map((project) =>
      project.scenes[0].objectives.map((objective) => objective.id),
    ),
    [['collect-crystals'], ['find-shell', 'defeat-sentinels'], ['gather-materials', 'build-campfire'], []],
  );
});

test('starter goal beacon keeps its tower clear of the center approach line', () => {
  const arena = createExample('arena', 'objective-beacon-camera'),
    beacon = arena.assets.find((asset) => asset.id === 'finish');
  assert.ok(beacon);
  const tower = beacon.model.voxels.filter((voxel) => voxel.y > 10);
  assert.ok(tower.length > 0);
  assert.ok(tower.every((voxel) => voxel.x > 8));
});

test('runtime reports live variable and inventory objective progress using rule comparison semantics', () => {
  const project = newProject('objective-runtime', 'Objective runtime');
  project.scenes[0].variables = { score: 0 };
  project.scenes[0].items = [{ id: 'key', name: 'Key', description: '', maxStack: 10 }];
  project.scenes[0].objectives = [
    { id: 'score-goal', text: 'Earn 3 points', condition: { variable: 'score', op: '>=', value: 3 } },
    { id: 'key-goal', text: 'Find two keys', condition: { itemId: 'key', op: '==', value: 2 } },
  ];
  const simulation = new GameSimulation(validateProject(project));
  assert.deepEqual(
    simulation.inspect().objectives.map(({ current, completed }) => [current, completed]),
    [
      [0, false],
      [0, false],
    ],
  );

  simulation.variables.score = 3;
  simulation.inventory = [{ itemId: 'key', quantity: 2 }];
  assert.deepEqual(
    simulation.inspect().objectives.map(({ current, completed }) => [current, completed]),
    [
      [3, true],
      [2, true],
    ],
  );
});

test('runtime locks satisfied objectives until prerequisites complete, regardless of definition order', () => {
  const project = newProject('objective-gating', 'Objective gating');
  project.scenes[0].variables = { gate: 1, key: 0 };
  project.scenes[0].objectives = [
    {
      id: 'open-door',
      text: 'Open the door',
      condition: { variable: 'gate', op: '>=', value: 1 },
      requires: ['find-key'],
    },
    { id: 'find-key', text: 'Find the key', condition: { variable: 'key', op: '>=', value: 1 } },
  ];
  const simulation = new GameSimulation(validateProject(project));
  assert.deepEqual(
    simulation
      .inspect()
      .objectives.map(({ current, available, completed }) => [current, available, completed]),
    [
      [1, false, false],
      [0, true, false],
    ],
  );

  simulation.variables.key = 1;
  assert.deepEqual(
    simulation.inspect().objectives.map(({ available, completed }) => [available, completed]),
    [
      [true, true],
      [true, true],
    ],
  );
});

test('scene settings expose authored objectives and standalone games include an accessible objective list', () => {
  const project = newProject('objective-ui', 'Objective UI');
  project.scenes[0].objectives = [
    { id: 'find-key', text: 'Find the key', condition: { itemId: 'key', op: '>=', value: 1 } },
    {
      id: 'reach-score',
      text: 'Reach 10 points',
      condition: { variable: 'score', op: '>=', value: 10 },
      requires: ['find-key'],
    },
  ];
  project.scenes[0].items = [{ id: 'key', name: 'Key', description: '', maxStack: 10 }];
  const scene = validateProject(project).scenes[0];
  const settings = renderToStaticMarkup(
    React.createElement(SceneSettings, {
      scene,
      worlds: [],
      apply: async () => undefined,
      createWorld: async () => undefined,
      updateWorld: async () => undefined,
    }),
  );
  const editor = renderToStaticMarkup(
    React.createElement(ObjectiveEditor, { objectives: scene.objectives, items: scene.items, onChange() {} }),
  );
  assert.match(settings, /Player objectives/);
  assert.match(editor, /aria-label="Objective 1 text"/);
  assert.match(editor, /Requires completed objectives/);
  assert.match(editor, /aria-label="Objective 2 requires Find the key" checked/);
  assert.doesNotMatch(editor, /aria-label="Objective 1 requires Reach 10 points"/);
  assert.match(editor, /Find the key/);
  assert.match(editor, /aria-label="Objective 1 inventory item"/);
  assert.match(
    renderGameHtml(project, project.activeSceneId, 'runtime', ''),
    /<ol id="objectives" aria-label="Objectives" hidden><\/ol>/,
  );
});

test('removing an objective also removes it from dependent objective requirements', () => {
  const objectives = [
    { id: 'first', text: 'First', condition: { variable: 'first', op: '>=' as const, value: 1 } },
    {
      id: 'second',
      text: 'Second',
      condition: { variable: 'second', op: '>=' as const, value: 1 },
      requires: ['first'],
    },
  ];
  let updated: unknown;
  const editor = ObjectiveEditor({
    objectives,
    items: [],
    onChange: (next) => (updated = next),
  });
  const remove = reactElements(editor).find(
    (element) => element.type === 'button' && element.props['aria-label'] === 'Remove objective 1',
  );
  assert.ok(remove);
  (remove.props.onClick as () => void)();
  assert.deepEqual(updated, [
    { id: 'second', text: 'Second', condition: { variable: 'second', op: '>=', value: 1 } },
  ]);
});
