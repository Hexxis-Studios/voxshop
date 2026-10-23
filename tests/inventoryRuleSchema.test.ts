import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionSchema,
  applyProjectOperations,
  COLLISION_OTHER_TARGET,
  identityTransform,
  newProject,
  nodeSchema,
  ruleSchema,
  sceneSchema,
  validateProject,
} from '../services/projectDocument';

const item = { id: 'key', name: 'Key', description: '', maxStack: 10 };

test('inventory actions default lists and bound unique rows and quantities', () => {
  assert.deepEqual(actionSchema.safeParse({ type: 'inventory' }).success, false);
  assert.deepEqual(actionSchema.parse({ type: 'inventory', add: [{ itemId: 'key', quantity: 1 }] }), {
    type: 'inventory',
    remove: [],
    add: [{ itemId: 'key', quantity: 1 }],
  });
  assert.equal(
    actionSchema.safeParse({
      type: 'inventory',
      remove: [
        { itemId: 'key', quantity: 1 },
        { itemId: 'key', quantity: 2 },
      ],
    }).success,
    false,
  );
  assert.equal(
    actionSchema.safeParse({
      type: 'inventory',
      add: [
        { itemId: 'key', quantity: 1 },
        { itemId: 'key', quantity: 2 },
      ],
    }).success,
    false,
  );
  assert.equal(
    actionSchema.safeParse({
      type: 'inventory',
      remove: [{ itemId: 'key', quantity: 1 }],
      add: [{ itemId: 'key', quantity: 1 }],
    }).success,
    true,
  );
  assert.equal(
    actionSchema.safeParse({
      type: 'inventory',
      add: Array.from({ length: 17 }, (_, index) => ({ itemId: `key-${index}`, quantity: 1 })),
    }).success,
    false,
  );
  for (const quantity of [0, 1.5, 10000])
    assert.equal(
      actionSchema.safeParse({ type: 'inventory', add: [{ itemId: 'key', quantity }] }).success,
      false,
    );
  assert.equal(
    actionSchema.safeParse({ type: 'inventory', add: [{ itemId: 'key', quantity: 9999 }] }).success,
    true,
  );
});

test('conditions retain variable comparisons and add bounded item-count comparisons', () => {
  const legacy = ruleSchema.parse({
    event: 'start',
    condition: { variable: 'score', op: '>', value: -1.25 },
    actions: [{ type: 'message', text: 'ready' }],
  });
  assert.deepEqual(legacy.condition, { variable: 'score', op: '>', value: -1.25 });
  const itemCondition = ruleSchema.parse({
    event: 'interact',
    condition: { itemId: 'key', op: '>=', value: 0 },
    actions: [{ type: 'message', text: 'ready' }],
  });
  assert.deepEqual(itemCondition.condition, { itemId: 'key', op: '>=', value: 0 });
  for (const condition of [
    { variable: 'score', itemId: 'key', op: '==', value: 1 },
    { itemId: 'key', op: '==', value: 1.5 },
    { itemId: 'key', op: '==', value: -1 },
    { itemId: 'key', op: '==', value: 1_000_001 },
  ])
    assert.equal(
      ruleSchema.safeParse({ event: 'start', condition, actions: [{ type: 'win' }] }).success,
      false,
    );
});

test('condition groups are bounded, explicit, and mutually exclusive with legacy conditions', () => {
  const grouped = ruleSchema.parse({
    event: 'start',
    conditionGroup: {
      mode: 'all',
      conditions: [
        { variable: 'score', op: '>=', value: 2 },
        { itemId: 'key', op: '==', value: 1 },
      ],
    },
    actions: [{ type: 'win' }],
  });
  assert.equal(grouped.conditionGroup?.mode, 'all');
  assert.equal(
    ruleSchema.safeParse({
      event: 'start',
      conditionGroup: { mode: 'any', conditions: [] },
      actions: [{ type: 'win' }],
    }).success,
    false,
  );
  assert.equal(
    ruleSchema.safeParse({
      event: 'start',
      conditionGroup: {
        mode: 'all',
        conditions: Array.from({ length: 9 }, () => ({ variable: 'score', op: '>=', value: 1 })),
      },
      actions: [{ type: 'win' }],
    }).success,
    false,
  );
  assert.equal(
    ruleSchema.safeParse({
      event: 'start',
      condition: { variable: 'score', op: '>=', value: 1 },
      conditionGroup: { mode: 'all', conditions: [{ variable: 'score', op: '>=', value: 1 }] },
      actions: [{ type: 'win' }],
    }).success,
    false,
  );
  assert.equal(
    ruleSchema.safeParse({
      event: 'start',
      conditionGroup: {
        mode: 'all',
        conditions: [
          {
            variable: 'score',
            op: '>=',
            value: 1,
            conditionGroup: { mode: 'any', conditions: [{ variable: 'other', op: '==', value: 1 }] },
          },
        ],
      },
      actions: [{ type: 'win' }],
    }).success,
    false,
  );
});

test('rules accept an untouch event for player trigger exits', () => {
  const rule = ruleSchema.parse({
    event: 'untouch',
    actions: [{ type: 'message', text: 'Exit area' }],
  });
  assert.equal(rule.event, 'untouch');
});

test('rules accept Rapier collision-start and separation events', () => {
  for (const event of ['collision', 'separation'] as const) {
    const rule = ruleSchema.parse({ event, actions: [{ type: 'add', variable: 'events', value: 1 }] });
    assert.equal(rule.event, event);
    assert.equal(
      ruleSchema.parse({
        event,
        actions: [{ type: 'damage', target: COLLISION_OTHER_TARGET, amount: 5 }],
      }).actions[0]?.type,
      'damage',
    );
  }
  assert.equal(
    ruleSchema.safeParse({
      event: 'interact',
      actions: [{ type: 'damage', target: COLLISION_OTHER_TARGET, amount: 5 }],
    }).success,
    false,
  );
});

test('collision counterpart targets bypass node-ID lookup while ordinary targets stay validated', () => {
  const project = newProject('collision-target', 'Collision target');
  const valid = {
    ...project.scenes[0],
    nodes: [
      nodeSchema.parse({
        id: 'wall',
        name: 'Wall',
        transform: identityTransform(),
        components: [
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'collision',
                actions: [{ type: 'teleport', target: COLLISION_OTHER_TARGET, position: [0, 2, 0] }],
              },
            ],
          },
        ],
      }),
    ],
  };
  const committed = applyProjectOperations(project, [{ type: 'scene.put', scene: valid }]);
  const rules = committed.scenes[0].nodes[0]?.components.find((component) => component.type === 'rules');
  assert.ok(rules?.type === 'rules');
  assert.equal(rules.rules[0]?.actions[0]?.type, 'teleport');

  const missing = structuredClone(valid);
  const missingRules = missing.nodes[0]?.components.find((component) => component.type === 'rules');
  assert.ok(missingRules?.type === 'rules');
  missingRules.rules[0]!.actions[0] = { type: 'damage', target: 'missing-node', amount: 5 };
  assert.throws(
    () => applyProjectOperations(project, [{ type: 'scene.put', scene: missing }]),
    /missing node/,
  );
});

test('scene transactions accept inventory rules and atomically reject missing item references', () => {
  const project = newProject('inventory-rules', 'Inventory rules');
  const scene = {
    ...project.scenes[0],
    items: [item],
    nodes: [
      nodeSchema.parse({
        id: 'gate',
        name: 'Gate',
        transform: identityTransform(),
        components: [
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'interact',
                condition: { itemId: 'key', op: '>=', value: 1 },
                actions: [{ type: 'inventory', remove: [{ itemId: 'key', quantity: 1 }] }],
              },
            ],
          },
        ],
      }),
    ],
  };
  const committed = applyProjectOperations(project, [{ type: 'scene.put', scene }]);
  assert.equal(committed.scenes[0].nodes[0].components[0].type, 'rules');
  assert.equal(project.scenes[0].nodes.length, 0);

  const invalid = structuredClone(scene);
  invalid.nodes[0].components = [
    {
      type: 'rules',
      apiVersion: 1,
      rules: [
        {
          event: 'interact',
          interval: 1,
          once: false,
          condition: { itemId: 'missing', op: '>=', value: 1 },
          actions: [{ type: 'inventory', remove: [], add: [{ itemId: 'key', quantity: 1 }] }],
        },
      ],
    },
  ];
  assert.throws(
    () => applyProjectOperations(project, [{ type: 'scene.put', scene: invalid }]),
    /Rule condition references a missing item/,
  );
  assert.equal(project.scenes[0].nodes.length, 0);

  invalid.nodes = [
    nodeSchema.parse({
      id: 'gate',
      name: 'Gate',
      transform: identityTransform(),
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'interact',
              condition: { itemId: 'key', op: '>=', value: 1 },
              actions: [{ type: 'inventory', add: [{ itemId: 'missing', quantity: 1 }] }],
            },
          ],
        },
      ],
    }),
  ];
  assert.throws(
    () => applyProjectOperations(project, [{ type: 'scene.put', scene: invalid }]),
    /Inventory action references a missing item/,
  );
  assert.equal(project.scenes[0].nodes.length, 0);
});

test('scene validation checks item references inside condition groups', () => {
  const project = newProject('condition-group-items', 'Condition group items');
  const scene = {
    ...project.scenes[0],
    items: [item],
    nodes: [
      nodeSchema.parse({
        id: 'gate',
        name: 'Gate',
        transform: identityTransform(),
        components: [
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'interact',
                conditionGroup: {
                  mode: 'any',
                  conditions: [
                    { itemId: 'key', op: '>=', value: 1 },
                    { itemId: 'missing', op: '>=', value: 1 },
                  ],
                },
                actions: [{ type: 'win' }],
              },
            ],
          },
        ],
      }),
    ],
  };
  assert.throws(
    () => applyProjectOperations(project, [{ type: 'scene.put', scene }]),
    /missing item missing/,
  );
  assert.equal(project.scenes[0].nodes.length, 0);
});

test('inventory action grants participate in transition item and stack validation', () => {
  const project = newProject('inventory-transition', 'Inventory transition');
  const source = project.scenes[0];
  source.items = [item];
  source.nodes = [
    nodeSchema.parse({
      id: 'portal',
      name: 'Portal',
      transform: identityTransform(),
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'interact',
              actions: [
                { type: 'inventory', add: [{ itemId: 'key', quantity: 1 }] },
                { type: 'transition', sceneId: 'next' },
              ],
            },
          ],
        },
      ],
    }),
  ];
  project.scenes.push(sceneSchema.parse({ id: 'next', name: 'Next scene' }));
  assert.throws(() => validateProject(project), /cannot carry item key/);

  project.scenes[1].items = [{ ...item }];
  assert.equal(validateProject(project).scenes.length, 2);
  project.scenes[1].items[0].maxStack = 20;
  assert.throws(() => validateProject(project), /incompatible definitions for item key/);
});
