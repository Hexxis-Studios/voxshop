import test from 'node:test';
import assert from 'node:assert/strict';
import {
  componentSchema,
  identityTransform,
  newProject,
  nodeSchema,
  sceneSchema,
  validateProject,
} from '../services/projectDocument';

const wood = { id: 'wood', name: 'Wood', description: '', maxStack: 99 };

function projectWithBuilder(construction: unknown, includePlayer = true) {
  const project = newProject('construction-test', 'Construction test');
  project.scenes[0].items = [{ ...wood }];
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'builder',
      name: 'Builder',
      transform: identityTransform(),
      components: [
        ...(includePlayer ? [{ type: 'player', style: 'third-person', speed: 3 }] : []),
        construction,
      ],
    }),
  );
  return project;
}

test('construction schema supplies bounded authoring defaults and rejects invalid values', () => {
  assert.deepEqual(componentSchema.parse({ type: 'construction' }), {
    type: 'construction',
    place: true,
    remove: true,
    range: 6,
    placeCost: [],
    removeYield: [],
  });
  assert.equal(
    componentSchema.safeParse({
      type: 'construction',
      range: 100,
      placeCost: [{ itemId: 'wood', quantity: 1 }],
      removeYield: [{ itemId: 'wood', quantity: 9999 }],
    }).success,
    true,
  );
  for (const range of [0, -1, 100.01, Infinity, NaN])
    assert.equal(componentSchema.safeParse({ type: 'construction', range }).success, false);
  for (const quantity of [0, 1.5, 10000])
    assert.equal(
      componentSchema.safeParse({ type: 'construction', placeCost: [{ itemId: 'wood', quantity }] }).success,
      false,
    );
  for (const side of ['placeCost', 'removeYield'] as const)
    assert.equal(
      componentSchema.safeParse({
        type: 'construction',
        [side]: Array.from({ length: 17 }, (_, index) => ({ itemId: `wood-${index}`, quantity: 1 })),
      }).success,
      false,
    );
});

test('project validation limits construction to the player and checks item references per side', () => {
  const sameItemOnBothSides = projectWithBuilder({
    type: 'construction',
    placeCost: [{ itemId: 'wood', quantity: 1 }],
    removeYield: [{ itemId: 'wood', quantity: 1 }],
  });
  assert.equal(validateProject(sameItemOnBothSides).scenes[0].nodes.length, 1);

  assert.throws(
    () => validateProject(projectWithBuilder({ type: 'construction' }, false)),
    /Construction components belong on the player/,
  );
  for (const side of ['placeCost', 'removeYield'] as const) {
    assert.throws(
      () =>
        validateProject(
          projectWithBuilder({
            type: 'construction',
            [side]: [{ itemId: 'missing', quantity: 1 }],
          }),
        ),
      /Construction .* references a missing item/,
    );
    assert.throws(
      () =>
        validateProject(
          projectWithBuilder({
            type: 'construction',
            [side]: [
              { itemId: 'wood', quantity: 1 },
              { itemId: 'wood', quantity: 2 },
            ],
          }),
        ),
      new RegExp(`Duplicate construction ${side} item ID`),
    );
  }
});

test('construction removal yields participate in transition carry validation', () => {
  const project = projectWithBuilder({
    type: 'construction',
    removeYield: [{ itemId: 'wood', quantity: 1 }],
  });
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'portal',
      name: 'Portal',
      transform: identityTransform(),
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [{ event: 'interact', actions: [{ type: 'transition', sceneId: 'next' }] }],
        },
      ],
    }),
  );
  project.scenes.push(sceneSchema.parse({ id: 'next', name: 'Next scene' }));
  assert.throws(() => validateProject(project), /cannot carry item wood/);

  project.scenes[1].items = [{ ...wood }];
  assert.equal(validateProject(project).scenes.length, 2);
  project.scenes[1].items[0].maxStack = 20;
  assert.throws(() => validateProject(project), /incompatible definitions for item wood/);
});
