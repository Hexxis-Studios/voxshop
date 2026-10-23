import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSimulation } from '../runtime/GameSimulation';
import { identityTransform, newProject, nodeSchema, validateProject } from '../services/projectDocument';

test('runtime evaluates all and any condition groups before firing rule actions', async () => {
  const project = newProject('condition-groups', 'Condition groups');
  const scene = project.scenes[0]!;
  scene.variables = { score: 3, coins: 0, rejected: 0, anyMatched: 0, allMatched: 0 };
  scene.nodes = [
    nodeSchema.parse({
      id: 'logic',
      name: 'Logic',
      transform: identityTransform(),
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'start',
              conditionGroup: {
                mode: 'all',
                conditions: [
                  { variable: 'score', op: '>=', value: 2 },
                  { variable: 'coins', op: '>=', value: 1 },
                ],
              },
              actions: [{ type: 'set', variable: 'rejected', value: 1 }],
            },
            {
              event: 'start',
              conditionGroup: {
                mode: 'any',
                conditions: [
                  { variable: 'score', op: '>=', value: 4 },
                  { variable: 'coins', op: '==', value: 0 },
                ],
              },
              actions: [{ type: 'set', variable: 'anyMatched', value: 1 }],
            },
            {
              event: 'start',
              conditionGroup: {
                mode: 'all',
                conditions: [
                  { variable: 'score', op: '>=', value: 3 },
                  { variable: 'coins', op: '==', value: 0 },
                ],
              },
              actions: [{ type: 'set', variable: 'allMatched', value: 1 }],
            },
          ],
        },
      ],
    }),
  ];
  const valid = validateProject(project);
  const simulation = new GameSimulation(valid);
  await simulation.ready;
  assert.equal(simulation.variables.rejected, 0);
  assert.equal(simulation.variables.anyMatched, 1);
  assert.equal(simulation.variables.allMatched, 1);
});
