import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Rule } from '../services/projectDocument';
import { RuleEditor } from '../components/RuleEditor';

const catalog = [{ id: 'wood', name: 'Wood', description: '', maxStack: 99 }];

function renderRule(rule: Rule, items = catalog, markers: string[] = []): string {
  return renderToStaticMarkup(
    React.createElement(RuleEditor, {
      rules: [rule],
      recipes: [],
      items,
      markers,
      nodes: [],
      scenes: [{ id: 'main', name: 'Main' }],
      sceneId: 'main',
      onChange: () => {},
    }),
  );
}

test('UI event rules expose the HUD event-button ID in the manual Rule Editor', () => {
  const html = renderRule({
    event: 'ui',
    eventId: 'open-door',
    interval: 1,
    once: false,
    actions: [{ type: 'set', variable: 'doorOpen', value: 1 }],
  });

  assert.match(html, /value="ui"/);
  assert.match(html, /Event button ID/);
  assert.match(html, /value="open-door"/);
  assert.match(html, /Match the stable ID authored on an Event button HUD widget/);
});

test('signal rules and emit actions expose the matching ID in the manual Rule Editor', () => {
  const html = renderRule({
    event: 'signal',
    eventId: 'power-restored',
    interval: 1,
    once: false,
    actions: [{ type: 'emit', eventId: 'door-open' }],
  });

  assert.match(html, /value="signal"/);
  assert.match(html, /Signal ID/);
  assert.match(html, /value="power-restored"/);
  assert.match(html, /every enabled listener with this ID runs/);
  assert.match(html, /value="door-open"/);
  assert.match(html, /Runs enabled signal rules with the same ID after this rule finishes/);
});

test('inventory condition and action editors expose bounded catalog controls and retain missing IDs', () => {
  const html = renderRule({
    event: 'interact',
    interval: 1,
    once: false,
    condition: { itemId: 'old-gem', op: '>=', value: 3 },
    actions: [
      {
        type: 'inventory',
        remove: [{ itemId: 'old-token', quantity: 2 }],
        add: [{ itemId: 'wood', quantity: 4 }],
      },
    ],
  });

  assert.match(html, /Condition source/);
  assert.match(html, /Inventory count/);
  assert.match(html, /Inventory item/);
  assert.match(html, /old-gem · missing catalog item/);
  assert.match(html, /Remove items/);
  assert.match(html, /Add items/);
  assert.match(html, /old-token · missing catalog item/);
  assert.match(html, /Wood · wood/);
  assert.match(html, /Remove quantity 1/);
  assert.match(html, /Add quantity 1/);
  assert.match(html, /max="9999"/);
  assert.match(html, /failed transaction stops later actions/i);
  assert.match(html, /failed Run once rule can be retried until it succeeds/i);
});

test('variable conditions remain editable and inventory controls explain an empty catalog', () => {
  const variableHtml = renderRule({
    event: 'touch',
    interval: 1,
    once: false,
    condition: { variable: 'score', op: '>=', value: 10 },
    actions: [{ type: 'message', text: 'Ready' }],
  });
  assert.match(variableHtml, /Condition source/);
  assert.match(variableHtml, /value="score"/);
  assert.match(variableHtml, /Variable/);

  const emptyCatalogHtml = renderToStaticMarkup(
    React.createElement(RuleEditor, {
      rules: [{ event: 'interact', interval: 1, once: false, actions: [{ type: 'message', text: 'Ready' }] }],
      recipes: [],
      items: [],
      nodes: [],
      scenes: [{ id: 'main', name: 'Main' }],
      sceneId: 'main',
      onChange: () => {},
    }),
  );
  assert.match(emptyCatalogHtml, /Inventory actions require an item in the Scene catalog/);
  assert.match(emptyCatalogHtml, /value="inventory" disabled=""/);
  assert.match(emptyCatalogHtml, /value="spawn" disabled=""/);
});

test('spawn actions expose a saved prefab picker and distinct relative or world placement fields', () => {
  const html = renderToStaticMarkup(
    React.createElement(RuleEditor, {
      rules: [
        {
          event: 'start',
          interval: 1,
          once: false,
          actions: [
            {
              type: 'spawn',
              prefabId: 'guard',
              position: [4, 2, -3],
              rotation: [0, 1, 0],
              scale: [2, 1, 2],
            },
          ],
        },
      ],
      recipes: [],
      nodes: [],
      scenes: [{ id: 'main', name: 'Main' }],
      prefabs: [{ id: 'guard', name: 'Guard' }],
      sceneId: 'main',
      onChange: () => {},
    }),
  );
  assert.match(html, /Guard · guard/);
  assert.match(html, /World position/);
  assert.match(html, /World X/);
  assert.match(html, /World Y/);
  assert.match(html, /World Z/);
  assert.match(html, /Override root rotation · Euler radians/);
  assert.match(html, /Override root scale/);
  assert.match(html, /Rotation X/);
  assert.match(html, /Scale Y/);
});

test('animation rules expose an optional bounded marker filter', () => {
  const html = renderRule({
    event: 'animation',
    marker: 'footstep',
    interval: 1,
    once: false,
    actions: [{ type: 'message', text: 'Step' }],
  });
  assert.match(html, /Marker filter \(optional\)/);
  assert.match(html, /value="footstep"/);
  assert.match(html, /Leave blank to run this rule for every animation marker/);
  assert.match(html, /pattern="\[a-zA-Z0-9\]\[a-zA-Z0-9_-\]\{0,63\}"/);

  const markerSelect = renderRule(
    {
      event: 'animation',
      marker: 'old-footstep',
      interval: 1,
      once: false,
      actions: [{ type: 'message', text: 'Step' }],
    },
    catalog,
    ['footstep', 'swing'],
  );
  assert.match(markerSelect, /old-footstep · missing marker/);
  assert.match(markerSelect, /value="footstep">footstep/);
  assert.match(markerSelect, /value="swing">swing/);
  assert.match(markerSelect, /Any marker/);
});

test('physics event rules explain collider and player-trigger requirements', () => {
  const html = renderRule({
    event: 'collision',
    interval: 1,
    once: false,
    actions: [{ type: 'message', text: 'Hit' }],
  });
  assert.match(html, /Rapier events need colliders on both objects and a dynamic rigid body/);
  assert.match(html, /use Touch\/Untouch for player triggers/);
  assert.match(html, /value="collision"/);
  assert.match(html, /value="separation"/);
});

test('physics action target controls offer the counterpart only for collision and separation rules', () => {
  const rule = {
    event: 'collision' as const,
    interval: 1,
    once: false,
    actions: [
      { type: 'damage' as const, target: '$other', amount: 10 },
      { type: 'teleport' as const, target: '$other', position: [0, 1, 0] as [number, number, number] },
    ],
  };
  const collisionHtml = renderRule(rule);
  assert.match(collisionHtml, /value="\$other"[^>]*>Other colliding object/);
  assert.match(collisionHtml, /Damage/);

  const interactionHtml = renderRule({ ...rule, event: 'interact' });
  assert.doesNotMatch(interactionHtml, /Other colliding object/);
});
