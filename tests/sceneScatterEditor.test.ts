import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  defaultSceneScatterBounds,
  nextSceneScatterId,
  SceneScatterEditor,
} from '../components/SceneScatterEditor';
import { assetSchema, type Asset, type GameScene } from '../services/projectDocument';
import type { WorldDocument } from '../services/worldDocument';
import { createModelDocument } from '../services/modelDocument';

const scene = (scatterGroups: any[] = [], bounds = 40) =>
  ({
    id: 'scene-main',
    name: 'Meadow',
    worldId: 'world-1',
    nodes: [],
    background: 0,
    groundColor: 0,
    bounds,
    variables: {},
    items: [],
    recipes: [],
    objectives: [],
    instructions: '',
    scatterGroups,
  }) as unknown as GameScene & { scatterGroups: any[] };

const world = (
  overrides: Partial<{ origin: [number, number]; size: [number, number]; voxelSize: number }> = {},
) =>
  ({
    id: 'world-1',
    name: 'Terrain',
    seed: 42,
    voxelSize: overrides.voxelSize ?? 2,
    generator: {
      origin: overrides.origin ?? [-50, -25],
      size: overrides.size ?? [100, 100],
    },
  }) as unknown as WorldDocument;

const assets = [
  assetSchema.parse({
    id: 'tree-oak',
    name: 'Oak tree',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x4d8745 }]),
  }),
] as Asset[];
const render = (
  options: { busy?: boolean; assets?: readonly Asset[]; groups?: any[]; world?: WorldDocument | null } = {},
) =>
  renderToStaticMarkup(
    React.createElement(SceneScatterEditor, {
      assets: options.assets ?? assets,
      scene: scene(options.groups),
      world: options.world === undefined ? world() : options.world,
      busy: options.busy ?? false,
      onCreate: () => {},
      onDelete: () => {},
    }),
  );

test('scatter bounds default to 64 meters around terrain center and clip to world bounds', () => {
  assert.deepEqual(defaultSceneScatterBounds(scene(), world()), {
    minX: -33,
    maxX: 31,
    minZ: 17,
    maxZ: 81,
  });
  assert.deepEqual(
    defaultSceneScatterBounds(scene(), world({ origin: [-5, 10], size: [10, 8], voxelSize: 1 })),
    { minX: -5.5, maxX: 4.5, minZ: 9.5, maxZ: 17.5 },
  );
  assert.deepEqual(defaultSceneScatterBounds(scene([], 3), null), {
    minX: -3,
    maxX: 3,
    minZ: -3,
    maxZ: 3,
  });
});

test('scatter IDs use the first unused stable scene-local value', () => {
  assert.equal(nextSceneScatterId([{ id: 'scatter-1' }, { id: 'scatter-3' }]), 'scatter-2');
});

test('scatter editor renders labeled bounded controls and existing group deletion', () => {
  const html = render({
    groups: [
      {
        id: 'scatter-1',
        assetId: 'tree-oak',
        seed: 42,
        count: 24,
        bounds: { minX: -2, maxX: 2, minZ: -3, maxZ: 3 },
        snapToTerrain: true,
        groundY: 0,
        scaleRange: [0.7, 1.3],
        randomYaw: true,
      },
    ],
  });

  assert.match(html, /Scatter asset/);
  assert.match(html, /Oak tree · tree-oak/);
  assert.match(html, /Instance count/);
  assert.match(html, /max="1000"/);
  assert.doesNotMatch(html, /No scatter-ready assets available/);
  assert.match(html, /min="-2147483648" max="2147483647"/);
  assert.match(html, /Minimum scale/);
  assert.match(html, /Maximum scale/);
  assert.match(html, /Snap to terrain/);
  assert.match(html, /Ground Y \(m\)/);
  assert.match(html, /Random yaw/);
  assert.match(html, /value="-33"/);
  assert.match(html, /value="81"/);
  assert.match(html, /24 seeded placements · seed 42 · scale 0.7–1.3/);
  assert.match(html, /aria-label="Delete scatter group scatter-1"/);
});

test('busy state disables editor and delete controls; empty assets cannot create a group', () => {
  const busyHtml = render({
    busy: true,
    groups: [
      {
        id: 'scatter-1',
        assetId: 'tree-oak',
        seed: 42,
        count: 24,
        bounds: { minX: -2, maxX: 2, minZ: -3, maxZ: 3 },
        snapToTerrain: true,
        groundY: 0,
        scaleRange: [0.7, 1.3],
        randomYaw: true,
      },
    ],
  });
  assert.match(busyHtml, /<select[^>]*disabled=""/);
  assert.match(busyHtml, /<fieldset[^>]*disabled=""/);
  assert.match(busyHtml, /<button[^>]*disabled="">Create scatter group/);
  assert.match(busyHtml, /<button[^>]*aria-label="Delete scatter group scatter-1" disabled=""/);

  const emptyHtml = render({
    assets: [],
    groups: [{ id: 'scatter-1', assetId: 'missing', seed: 0, count: 1, scaleRange: [1, 1] }],
  });
  assert.match(emptyHtml, /No scatter-ready assets available/);
  assert.match(emptyHtml, /<button[^>]*disabled="">Create scatter group/);
  assert.match(emptyHtml, /<button[^>]*aria-label="Delete scatter group scatter-1">Delete/);

  const glassAsset = assetSchema.parse({
    id: 'glass-prop',
    name: 'Glass prop',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0xffffff, materialType: 'GLASS' }]),
  });
  const unsupportedHtml = render({ assets: [glassAsset] });
  assert.match(unsupportedHtml, /No scatter-ready assets available/);
  assert.match(unsupportedHtml, /static opaque voxel assets with 1–4,096 voxels/);
});
