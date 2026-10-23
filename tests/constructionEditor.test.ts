import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Component, ItemDefinition } from '../services/projectDocument';
import {
  addConstructionPaletteEntry,
  ConstructionEditor,
  formatPaletteColor,
  parsePaletteColor,
} from '../components/ConstructionEditor';

type Construction = Extract<Component, { type: 'construction' }>;
const items: ItemDefinition[] = [{ id: 'wood', name: 'Wood', description: '', maxStack: 99 }];

function render(construction: Construction, catalog = items): string {
  return renderToStaticMarkup(
    React.createElement(ConstructionEditor, {
      construction,
      items: catalog,
      onChange: () => {},
    }),
  );
}

test('construction controls allow free placement and removal with empty lists', () => {
  const html = render(
    {
      type: 'construction',
      place: true,
      remove: true,
      range: 6,
      placeCost: [],
      removeYield: [],
    },
    [],
  );

  assert.match(html, /Enable placement/);
  assert.match(html, /Enable removal/);
  assert.match(html, /checked=""/);
  assert.match(html, /Construction reach \(m\)/);
  assert.match(html, /max="100"/);
  assert.match(html, /Place costs/);
  assert.match(html, /Remove yields/);
  assert.equal((html.match(/Add item/g) ?? []).length, 2);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.match(html, /Add an item to the Scene catalog to use this list/);
  assert.match(html, /Costs apply per successfully placed cell/);
  assert.match(html, /Failed edits spend or grant nothing/);
  assert.match(html, /Paint palette/);
  assert.match(html, /\+ Add paint color/);
});

test('construction lists reuse catalog rows, retain missing IDs and allow deleting their last row', () => {
  const html = render({
    type: 'construction',
    place: false,
    remove: true,
    range: 9,
    placeCost: [{ itemId: 'retired-wood', quantity: 2 }],
    removeYield: [{ itemId: 'wood', quantity: 4 }],
  });

  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  assert.match(html, /value="retired-wood" selected="">retired-wood · missing catalog item/);
  assert.match(html, /Wood · wood/);
  assert.match(html, /Place cost quantity 1/);
  assert.match(html, /Remove yield quantity 1/);
  assert.match(html, /max="9999"/);
  assert.match(html, /aria-label="Remove row 1 from place costs"/);
  assert.match(html, /aria-label="Remove row 1 from remove yields"/);
  assert.doesNotMatch(html, /<button[^>]*aria-label="Remove row 1 from place costs"[^>]*disabled=/);
  assert.doesNotMatch(html, /<button[^>]*aria-label="Remove row 1 from remove yields"[^>]*disabled=/);
});

test('paint palette renders stable IDs, labeled name/color/material controls and removal', () => {
  const html = render({
    type: 'construction',
    place: true,
    remove: true,
    range: 6,
    placeCost: [],
    removeYield: [],
    palette: [{ id: 'paint-1', name: 'Moss', color: 0x35ab4c, materialType: 'GLASS' }],
  });

  assert.match(html, /Paint color 1 name/);
  assert.match(html, /value="Moss"/);
  assert.match(html, /Paint color 1 hex color/);
  assert.match(html, /type="color" value="#35ab4c"/);
  assert.match(html, /Paint color 1 material/);
  assert.match(html, /<option value="GLASS" selected="">GLASS<\/option>/);
  assert.match(html, /Palette ID: <code>paint-1<\/code>/);
  assert.match(html, /aria-label="Remove paint color 1"/);
  assert.match(html, /Colors remain independent of per-cell costs and yields/);
});

test('paint palette additions generate an unused stable ID and respect the 32-entry limit', () => {
  const entries = [
    { id: 'paint-1', name: 'First', color: 0, materialType: 'STANDARD' as const },
    { id: 'paint-3', name: 'Third', color: 0xffffff, materialType: 'METALLIC' as const },
  ];
  const added = addConstructionPaletteEntry(entries);
  assert.equal(added.length, 3);
  assert.deepEqual(added[2], {
    id: 'paint-2',
    name: 'New color',
    color: 0xffffff,
    materialType: 'STANDARD',
  });
  assert.equal(entries.length, 2, 'adding a color leaves the supplied list unchanged');

  const full = Array.from({ length: 32 }, (_, index) => ({
    id: `paint-${index + 1}`,
    name: `Color ${index + 1}`,
    color: index,
    materialType: 'STANDARD' as const,
  }));
  assert.equal(addConstructionPaletteEntry(full).length, 32);
});

test('paint palette color helpers round trip bounded six-digit hexadecimal colors', () => {
  assert.equal(formatPaletteColor(0x00abef), '#00abef');
  assert.equal(parsePaletteColor('#00abEF'), 0x00abef);
  assert.equal(parsePaletteColor('#abc'), null);
  assert.equal(parsePaletteColor('00abef'), null);
});

test('paint palette add control is disabled at its authored limit', () => {
  const palette = Array.from({ length: 32 }, (_, index) => ({
    id: `paint-${index + 1}`,
    name: `Color ${index + 1}`,
    color: index,
    materialType: 'STANDARD' as const,
  }));
  const html = render({
    type: 'construction',
    place: true,
    remove: true,
    range: 6,
    placeCost: [],
    removeYield: [],
    palette,
  });
  assert.match(html, /32\/32/);
  assert.match(html, /<button[^>]*disabled="">\+ Add paint color<\/button>/);
  assert.match(html, /aria-label="Remove paint color 32"/);
});
