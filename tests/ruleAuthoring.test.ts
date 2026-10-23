import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionTypes,
  addRuleCondition,
  addInventoryEntry,
  canCreateAction,
  createAction,
  createRule,
  defaultRuleCondition,
  parseActionJson,
  removeInventoryEntry,
  removeRuleCondition,
  ruleEvents,
  setRuleEvent,
  setRuleConditionMode,
  updateInventoryEntry,
  updateRuleCondition,
  useRuleConditionGroup,
} from '../components/ruleAuthoring';
import { actionSchema, COLLISION_OTHER_TARGET, ruleSchema } from '../services/projectDocument';

test('rule authoring defaults expose every version-1 action and event', () => {
  assert.deepEqual(ruleEvents, [
    'start',
    'interact',
    'touch',
    'untouch',
    'collision',
    'separation',
    'tick',
    'destroyed',
    'attack',
    'animation',
    'ui',
    'signal',
  ]);
  assert.deepEqual(actionTypes, [
    'set',
    'add',
    'destroy',
    'enable',
    'emit',
    'message',
    'sound',
    'audio',
    'win',
    'lose',
    'damage',
    'heal',
    'teleport',
    'craft',
    'inventory',
    'spawn',
    'transition',
  ]);
  assert.deepEqual(createRule(), {
    event: 'interact',
    interval: 1,
    once: false,
    actions: [{ type: 'message', text: 'Hello, creator!' }],
  });
  assert.deepEqual(createAction('craft', 'smelt'), { type: 'craft', recipeId: 'smelt', batches: 1 });
  assert.deepEqual(createAction('sound'), {
    type: 'sound',
    waveform: 'sine',
    frequency: 440,
    duration: 0.15,
    volume: 0.5,
  });
  assert.deepEqual(createAction('audio', undefined, undefined, undefined, undefined, undefined, 'bell'), {
    type: 'audio',
    clipId: 'bell',
    volume: 1,
  });
  assert.deepEqual(createAction('emit'), { type: 'emit', eventId: 'event' });
  assert.equal(createAction('audio'), undefined);
  assert.equal(createAction('craft'), undefined);
  assert.deepEqual(createAction('inventory', undefined, undefined, undefined, 'wood'), {
    type: 'inventory',
    remove: [],
    add: [{ itemId: 'wood', quantity: 1 }],
  });
  assert.equal(createAction('inventory'), undefined);
  assert.deepEqual(createAction('heal'), { type: 'heal', amount: 10 });
  assert.deepEqual(createAction('transition', undefined, undefined, 'level-2'), {
    type: 'transition',
    sceneId: 'level-2',
  });
  assert.deepEqual(createAction('transition', undefined, undefined, 'main'), {
    type: 'transition',
    sceneId: 'main',
  });
  assert.equal(createAction('transition'), undefined);
  assert.deepEqual(createAction('enable', undefined, 'gate'), {
    type: 'enable',
    target: 'gate',
    value: true,
  });
  assert.equal(createAction('enable'), undefined);
  assert.equal(canCreateAction('inventory', { recipes: 1, nodes: 1, items: 0 }), false);
  assert.equal(canCreateAction('inventory', { recipes: 1, nodes: 1, items: 1 }), true);
  assert.equal(canCreateAction('audio', { recipes: 1, nodes: 1, items: 1 }), false);
  assert.equal(canCreateAction('audio', { recipes: 1, nodes: 1, items: 1, audioClips: 1 }), true);
});

test('inventory row helpers enforce distinct IDs, bounds, and preserve valid edits', () => {
  const initial = [{ itemId: 'wood', quantity: 2 }];
  assert.deepEqual(addInventoryEntry(initial, 'stone'), [
    { itemId: 'wood', quantity: 2 },
    { itemId: 'stone', quantity: 1 },
  ]);
  assert.equal(addInventoryEntry(initial, 'wood'), initial);
  assert.deepEqual(updateInventoryEntry(initial, 0, { quantity: 7 }), [{ itemId: 'wood', quantity: 7 }]);
  assert.equal(updateInventoryEntry(initial, 0, { quantity: 10000 }), initial);
  assert.equal(updateInventoryEntry(initial, 0, { itemId: 'stone' })[0]?.itemId, 'stone');
  assert.deepEqual(removeInventoryEntry([...initial, { itemId: 'stone', quantity: 1 }], 0), [
    { itemId: 'stone', quantity: 1 },
  ]);
  assert.equal(
    addInventoryEntry(
      Array.from({ length: 16 }, (_, i) => ({ itemId: `item-${i}`, quantity: 1 })),
      'extra',
    ).length,
    16,
  );
});

test('changing rule events clears stale animation marker filters', () => {
  const rule = {
    event: 'animation' as const,
    marker: 'footstep',
    interval: 1,
    once: false,
    actions: [{ type: 'message' as const, text: 'Step' }],
  };
  assert.equal(setRuleEvent(rule, 'animation'), rule);
  assert.deepEqual(setRuleEvent(rule, 'tick'), { ...rule, event: 'tick', marker: undefined });
  assert.deepEqual(setRuleEvent({ ...rule, event: 'tick' }, 'animation'), {
    ...rule,
    marker: undefined,
  });
  assert.deepEqual(setRuleEvent(rule, 'ui'), {
    ...rule,
    event: 'ui',
    eventId: 'event',
    marker: undefined,
  });
  assert.deepEqual(
    setRuleEvent({ event: 'interact', interval: 1, once: false, actions: rule.actions }, 'signal'),
    { event: 'signal', eventId: 'event', interval: 1, once: false, actions: rule.actions, marker: undefined },
  );
  assert.deepEqual(
    setRuleEvent(
      { event: 'signal', eventId: 'powered', interval: 1, once: false, actions: rule.actions },
      'touch',
    ),
    { event: 'touch', interval: 1, once: false, actions: rule.actions, marker: undefined },
  );
  assert.deepEqual(setRuleEvent({ ...rule, event: 'ui', eventId: 'open-door' }, 'touch'), {
    ...rule,
    event: 'touch',
    marker: undefined,
  });
  const uiRule = {
    event: 'ui',
    eventId: 'open-door',
    actions: [{ type: 'set', variable: 'doorOpen', value: 1 }],
  };
  assert.equal(ruleSchema.safeParse(uiRule).success, true);
  assert.equal(ruleSchema.safeParse({ ...uiRule, eventId: undefined }).success, false);
  assert.equal(ruleSchema.safeParse({ ...uiRule, event: 'interact' }).success, false);
});

test('named signal IDs are required only for signal and UI rules', () => {
  const signal = {
    event: 'signal' as const,
    eventId: 'door-open',
    interval: 1,
    once: false,
    actions: [{ type: 'message' as const, text: 'Door opened' }],
  };
  assert.equal(ruleSchema.parse(signal).eventId, 'door-open');
  assert.equal(ruleSchema.safeParse({ ...signal, eventId: undefined }).success, false);
  assert.equal(ruleSchema.safeParse({ ...signal, event: 'interact' }).success, false);
  assert.deepEqual(actionSchema.parse({ type: 'emit', eventId: 'door-open' }), {
    type: 'emit',
    eventId: 'door-open',
  });
});

test('condition-group helpers preserve rules and enforce the editor bounds', () => {
  const rule = { ...createRule(), condition: { variable: 'keys', op: '>=' as const, value: 2 } };
  let grouped = useRuleConditionGroup(rule);
  assert.deepEqual(grouped.conditionGroup, { mode: 'all', conditions: [rule.condition] });
  assert.equal(grouped.condition, undefined);
  assert.equal(useRuleConditionGroup(grouped), grouped);
  grouped = setRuleConditionMode(grouped, 'any');
  grouped = addRuleCondition(grouped);
  assert.equal(grouped.conditionGroup?.conditions.length, 2);
  grouped = updateRuleCondition(grouped, 1, { variable: 'score', op: '>=', value: 10 });
  assert.equal(grouped.conditionGroup?.conditions[1]?.value, 10);
  grouped = removeRuleCondition(grouped, 0);
  assert.deepEqual(grouped.conditionGroup?.conditions, [{ variable: 'score', op: '>=', value: 10 }]);
  assert.equal(removeRuleCondition(grouped, 0), grouped);
  assert.equal(updateRuleCondition(grouped, 4, defaultRuleCondition()), grouped);
  let full = useRuleConditionGroup(createRule());
  for (let i = 0; i < 7; i++) full = addRuleCondition(full);
  assert.equal(full.conditionGroup?.conditions.length, 8);
  assert.equal(addRuleCondition(full), full);
});

test('changing away from a physics event clears counterpart targets', () => {
  const rule = {
    event: 'collision' as const,
    interval: 1,
    once: false,
    actions: [
      { type: 'damage' as const, target: COLLISION_OTHER_TARGET, amount: 5 },
      {
        type: 'teleport' as const,
        target: COLLISION_OTHER_TARGET,
        position: [0, 1, 0] as [number, number, number],
      },
    ],
  };
  assert.deepEqual(setRuleEvent(rule, 'separation'), { ...rule, event: 'separation', marker: undefined });
  const changed = setRuleEvent(rule, 'touch');
  assert.deepEqual(changed.actions, [
    { type: 'damage', target: undefined, amount: 5 },
    { type: 'teleport', target: undefined, position: [0, 1, 0] },
  ]);
});

test('action JSON accepts each current variant without changing its authored fields', () => {
  const actions = [
    { type: 'set', variable: 'score', value: -2.5 },
    { type: 'add', variable: 'score', value: 3 },
    { type: 'destroy' },
    { type: 'enable', target: 'gate', value: false },
    { type: 'message', text: 'Ready' },
    { type: 'sound', waveform: 'triangle', frequency: 660, endFrequency: 330, duration: 0.24, volume: 0.6 },
    { type: 'win' },
    { type: 'lose' },
    { type: 'damage', amount: 12 },
    { type: 'heal', target: 'player', amount: 12 },
    { type: 'teleport', position: [1, 2, 3] },
    { type: 'craft', recipeId: 'smelt', batches: 2 },
    { type: 'inventory', remove: [{ itemId: 'wood', quantity: 2 }], add: [{ itemId: 'plank', quantity: 4 }] },
    { type: 'transition', sceneId: 'level-2' },
  ];
  for (const action of actions)
    assert.deepEqual(parseActionJson(JSON.stringify(action)), { success: true, action });
});

test('action JSON reports malformed and schema-invalid input instead of coercing it', () => {
  assert.equal(parseActionJson('{').success, false);
  assert.deepEqual(parseActionJson('{"type":"craft","recipeId":"smelt","batches":0}'), {
    success: false,
    error: 'Too small: expected number to be >=1',
  });
  assert.equal(parseActionJson('{"type":"heal","amount":0}').success, false);
  assert.equal(parseActionJson('{"type":"heal","amount":10001}').success, false);
  assert.equal(parseActionJson('{"type":"custom"}').success, false);
});
