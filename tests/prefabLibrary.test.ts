import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PrefabLibrary from '../components/PrefabLibrary';
import { nodeSchema, prefabSchema } from '../services/projectDocument';

const prefab = prefabSchema.parse({
  id: 'gate-prefab',
  name: 'Gate assembly',
  rootId: 'gate',
  nodes: [{ id: 'gate', name: 'Gate', transform: {} }],
});

test('prefab library exposes save, placement and deletion controls for a reusable hierarchy', () => {
  const markup = renderToStaticMarkup(
    React.createElement(PrefabLibrary, {
      prefabs: [prefab],
      selectedNode: nodeSchema.parse({ id: 'selected', name: 'Selected', transform: {} }),
      linkedInstance: null,
      disabled: false,
      busy: false,
      search: '',
      onSave: () => {},
      onUpdateSource: () => {},
      onResetInstance: () => {},
      onPlace: () => {},
      onDelete: () => {},
    }),
  );

  assert.match(markup, /Reusable prefabs · 1/);
  assert.match(markup, /Gate assembly/);
  assert.match(markup, /Save selected object and children/);
  assert.match(markup, /Place copy/);
  assert.match(markup, /aria-label="Place copy of Gate assembly"/);
  assert.match(markup, /aria-label="Delete prefab Gate assembly"/);
});

test('prefab library filters names and disables save without a selected scene object', () => {
  const markup = renderToStaticMarkup(
    React.createElement(PrefabLibrary, {
      prefabs: [prefab],
      selectedNode: null,
      linkedInstance: null,
      disabled: false,
      busy: false,
      search: 'missing',
      onSave: () => {},
      onUpdateSource: () => {},
      onResetInstance: () => {},
      onPlace: () => {},
      onDelete: () => {},
    }),
  );

  assert.match(markup, /<button disabled="">Save selected object and children<\/button>/);
  assert.doesNotMatch(markup, /Gate assembly/);
});

test('linked prefab selection exposes source update and reset controls', () => {
  const markup = renderToStaticMarkup(
    React.createElement(PrefabLibrary, {
      prefabs: [prefab],
      selectedNode: nodeSchema.parse({ id: 'gate-copy', name: 'Gate copy', transform: {} }),
      linkedInstance: { prefab, rootId: 'gate-copy' },
      disabled: false,
      busy: false,
      search: '',
      onSave: () => {},
      onUpdateSource: () => {},
      onResetInstance: () => {},
      onPlace: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(markup, /Update Gate assembly from this instance/);
  assert.match(markup, /Reset instance overrides/);
});
