import assert from 'node:assert/strict';
import test from 'node:test';
import { compileGameFormula, type GameFormulaContext } from '../services/gameFormula';
import {
  actionSchema,
  newProject,
  nodeSchema,
  validateProject,
  applyProjectOperations,
  type Rule,
} from '../services/projectDocument';
import { GameSimulation } from '../runtime/GameSimulation';
import { GameSession } from '../runtime/GameSession';
import { exportProject } from '../runtime/gameExport';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { RuleEditor } from '../components/RuleEditor';

const context: GameFormulaContext = {
  variable: (scope, id) => (scope === 'campaign' ? 3 : id === 'combo-score' ? 5 : 0),
  item: () => 2,
  health: () => 75,
  time: 12.5,
  frame: 750,
};

test('game formulas calculate bounded deterministic mechanics without evaluating JavaScript', () => {
  assert.equal(compileGameFormula('clamp(scene("combo-score") + item("gem") * 10, 0, 100)')(context), 25);
  assert.equal(compileGameFormula('floor(time) + campaign("level") * 2 - -1')(context), 19);
  assert.equal(compileGameFormula('round(health("player") / 2) + sqrt(16) + pow(2, 3)')(context), 50);
  assert.equal(compileGameFormula('min(9, max(2, 3, 4)) + abs(-1) + ceil(1.1) + 5 % 2')(context), 8);
  assert.equal(compileGameFormula('frame / 60 + pi - pi + 1e-2')(context), 12.51);
  for (const source of [
    'globalThis.fetch("x")',
    'constructor()',
    'scene("score").constructor',
    '1;2',
    '1 2',
    'min(1)',
    'clamp(1,2)',
    '1e999',
    '(',
    '"score"',
    '1 +',
  ])
    assert.throws(() => compileGameFormula(source), source);
  assert.throws(() => compileGameFormula('('.repeat(18) + '1' + ')'.repeat(18)), /nesting/);
  assert.throws(() => compileGameFormula('1+'.repeat(70) + '1'), /tokens/);
  assert.throws(() => compileGameFormula('1 / scene("missing")')(context), /finite/);
  assert.throws(() =>
    actionSchema.parse({ type: 'set', variable: 'score', value: 0, formula: 'fetch("secret")' }),
  );
  assert.deepEqual(actionSchema.parse({ type: 'set', variable: 'score', formula: 'scene("combo")' }), {
    type: 'set',
    variable: 'score',
    value: 0,
    formula: 'scene("combo")',
  });
  assert.deepEqual(actionSchema.parse({ type: 'add', variable: 'score', formula: 'scene("combo")' }), {
    type: 'add',
    variable: 'score',
    value: 0,
    formula: 'scene("combo")',
  });
  assert.equal(
    actionSchema.safeParse({ type: 'damage', amount: 1, formula: 'globalThis.fetch("secret")' }).success,
    false,
    'Unsupported formula fields must be rejected instead of silently stripped.',
  );
});

function formulaProject(rules: unknown[]) {
  const project = newProject('formulas', 'Combo score');
  project.scenes[0].variables = { combo: 2, divisor: 0 };
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'logic',
      name: 'Score logic',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ type: 'rules', apiVersion: 1, rules }],
    }),
  ];
  return validateProject(project);
}

test('formula rules persist through project edits, game export and saved progress', () => {
  const original = formulaProject([
    {
      event: 'start',
      once: true,
      actions: [
        { type: 'set', variable: 'points', scope: 'campaign', value: 0, formula: 'scene("combo") * 10' },
        { type: 'add', variable: 'points', scope: 'campaign', value: 0, formula: 'campaign("points") / 2' },
      ],
    },
  ]);
  const project = applyProjectOperations(original, [{ type: 'scene.put', scene: original.scenes[0] }]);
  const game = exportProject(JSON.parse(JSON.stringify(project)), 'main');
  const simulation = new GameSession(game, 'main');
  simulation.step();
  assert.equal(simulation.simulation.inspect().campaignVariables.points, 30);
  const saved = simulation.progressSnapshot();
  const restored = new GameSession(game, 'main', saved);
  restored.step();
  assert.equal(
    restored.simulation.inspect().campaignVariables.points,
    30,
    'start rewards must not rerun on restore',
  );

  const retry = new GameSimulation(
    formulaProject([
      {
        event: 'tick',
        interval: 0.1,
        once: true,
        actions: [
          { type: 'add', variable: 'prefix', value: 1 },
          { type: 'set', variable: 'result', value: 0, formula: '10 / scene("divisor")' },
          { type: 'set', variable: 'reward', value: 1 },
        ],
      },
    ]),
  );
  retry.step();
  assert.equal(retry.inspect().variables.prefix, 1);
  assert.equal(retry.inspect().variables.result, undefined);
  assert.equal(retry.inspect().variables.reward, undefined);
  assert.match(retry.inspect().message, /finite/);
  retry.variables.divisor = 2;
  for (let i = 0; i < 10; i++) retry.step();
  assert.equal(retry.inspect().variables.prefix, 2, 'Earlier actions remain applied and repeat on retry.');
  assert.equal(retry.inspect().variables.result, 5);
  assert.equal(retry.inspect().variables.reward, 1);
});

test('formula reads default to zero for inherited object names', () => {
  const simulation = new GameSimulation(
    formulaProject([
      {
        event: 'start',
        once: true,
        actions: [
          {
            type: 'set',
            variable: 'result',
            value: 0,
            formula: 'scene("constructor") + campaign("toString") + health("constructor")',
          },
        ],
      },
    ]),
  );
  assert.equal(simulation.inspect().variables.result, 0);
  assert.doesNotMatch(simulation.inspect().message, /Could not calculate/);

  const addSimulation = new GameSimulation(
    formulaProject([
      {
        event: 'start',
        once: true,
        actions: [{ type: 'add', variable: 'constructor', value: 2 }],
      },
    ]),
  );
  assert.equal(addSimulation.inspect().variables.constructor, 2);
  assert.doesNotMatch(addSimulation.inspect().message, /Could not calculate/);
});

test('failed start formulas do not retry without another start event', () => {
  const simulation = new GameSimulation(
    formulaProject([
      {
        event: 'start',
        once: true,
        actions: [{ type: 'set', variable: 'result', value: 0, formula: '10 / scene("divisor")' }],
      },
    ]),
  );
  assert.equal(simulation.inspect().variables.result, undefined);
  assert.match(simulation.inspect().message, /finite/);
  simulation.variables.divisor = 2;
  for (let i = 0; i < 10; i++) simulation.step();
  assert.equal(simulation.inspect().variables.result, undefined);
});

test('manual Rule Editor exposes formula controls and preserves legacy constants', () => {
  const rules: Rule[] = [
    {
      event: 'start',
      interval: 1,
      once: true,
      actions: [
        { type: 'set', variable: 'score', value: 10 },
        { type: 'add', variable: 'score', value: 0, formula: 'scene("combo") * 10' },
      ],
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(RuleEditor, {
      rules,
      recipes: [],
      nodes: [],
      scenes: [{ id: 'main', name: 'Main' }],
      sceneId: 'main',
      onChange() {},
    }),
  );
  assert.match(html, /Use formula/);
  assert.match(html, /Amount formula/);
  assert.match(html, /combo/);
  assert.match(html, /value="10"/);
});
