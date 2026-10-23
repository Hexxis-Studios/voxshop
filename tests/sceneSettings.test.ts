import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SceneSettings from '../components/SceneSettings';
import {
  audioClipSchema,
  DEFAULT_SCENE_LIGHTING,
  operationSchema,
  sceneLightingSchema,
  sceneSchema,
} from '../services/projectDocument';
import { worldDocumentSchema } from '../services/worldDocument';

test('scene appearance controls show saved colors and bounded scene floor size', () => {
  const scene = sceneSchema.parse({
    id: 'scene',
    name: 'Scene',
    background: 0x123456,
    groundColor: 0xabcdef,
    bounds: 72,
  });
  const html = renderToStaticMarkup(
    React.createElement(SceneSettings, {
      scene,
      worlds: [],
      apply: async () => undefined,
      createWorld: async () => undefined,
      updateWorld: async () => undefined,
    }),
  );

  assert.match(html, /Scene appearance/);
  assert.match(html, /aria-label="Scene background color"[^>]*value="#123456"/);
  assert.match(html, /aria-label="Scene floor color"[^>]*value="#abcdef"/);
  assert.match(html, /aria-label="Scene floor half-width in meters"[^>]*value="72"/);
  assert.match(html, /Background color also tints scene fog/);
  for (const [input] of html.matchAll(/<input\b[^>]*type="number"[^>]*>/g)) {
    const attribute = (name: string) => input.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    const value = attribute('value');
    const step = attribute('step');
    if (!value || step === 'any') continue;
    const steps = (Number(value) - Number(attribute('min') ?? 0)) / Number(step ?? 1);
    assert.ok(
      Math.abs(steps - Math.round(steps)) < 1e-7,
      `Native number input rejects its default: ${input}`,
    );
  }
});

test('lighting schema keeps legacy defaults and exposes validated scene.put authoring', () => {
  const legacy = sceneSchema.parse({ id: 'scene', name: 'Scene' });
  assert.equal(legacy.lighting, undefined);
  assert.deepEqual(DEFAULT_SCENE_LIGHTING, {
    hemisphere: { skyColor: 0xc5e3ff, groundColor: 0x334025, intensity: 2 },
    directional: {
      color: 0xffe8ce,
      intensity: 3,
      position: [12, 24, 8],
      castShadow: true,
    },
  });
  assert.deepEqual(sceneLightingSchema.parse({ hemisphere: { intensity: 0 } }), {
    hemisphere: { skyColor: 0xc5e3ff, groundColor: 0x334025, intensity: 0 },
    directional: { color: 0xffe8ce, intensity: 3, position: [12, 24, 8], castShadow: true },
  });
  assert.equal(sceneLightingSchema.safeParse({ directional: { intensity: 10.01 } }).success, false);
  assert.equal(sceneLightingSchema.safeParse({ directional: { position: [0, 10001, 0] } }).success, false);

  const operation = operationSchema.parse({
    type: 'scene.put',
    scene: {
      id: 'lit-scene',
      name: 'Lit scene',
      lighting: { directional: { color: 0xffffff, intensity: 1.25, castShadow: false } },
    },
  });
  assert.equal(operation.type, 'scene.put');
  if (operation.type === 'scene.put') {
    assert.equal(operation.scene.lighting?.directional.color, 0xffffff);
    assert.equal(operation.scene.lighting?.directional.intensity, 1.25);
    assert.equal(operation.scene.lighting?.directional.castShadow, false);
  }
});

test('scene settings expose compact authored light controls', () => {
  const html = renderToStaticMarkup(
    React.createElement(SceneSettings, {
      scene: sceneSchema.parse({
        id: 'lit-scene',
        name: 'Lit scene',
        lighting: { hemisphere: { intensity: 1.25 }, directional: { position: [4, 9, 3] } },
      }),
      worlds: [],
      apply: async () => undefined,
      createWorld: async () => undefined,
      updateWorld: async () => undefined,
    }),
  );
  assert.match(html, /Scene lighting/);
  assert.match(html, /aria-label="Hemisphere light intensity"[^>]*value="1.25"/);
  assert.match(html, /aria-label="Directional light position X"[^>]*value="4"/);
  assert.match(html, /aria-label="Directional light position Y"[^>]*value="9"/);
  assert.match(html, /aria-label="Directional light position Z"[^>]*value="3"/);
  assert.match(html, /Directional light casts shadows/);
  assert.match(html, /Reset to default lighting/);
});

test('scene settings can select portable music and expose bounded audio import', () => {
  const clip = audioClipSchema.parse({
    id: 'theme',
    name: 'Theme loop',
    mimeType: 'audio/mpeg',
    dataUrl: 'data:audio/mpeg;base64,AQIDBA==',
  });
  const html = renderToStaticMarkup(
    React.createElement(SceneSettings, {
      scene: sceneSchema.parse({ id: 'scene', name: 'Scene', music: { clipId: 'theme', volume: 0.4 } }),
      worlds: [],
      audioClips: [clip],
      addAudioClip: async () => undefined,
      deleteAudioClip: async () => undefined,
      apply: async () => undefined,
      createWorld: async () => undefined,
      updateWorld: async () => undefined,
    }),
  );
  assert.match(html, /Scene audio/);
  assert.match(html, /Looping scene music/);
  assert.match(html, /Theme loop/);
  assert.match(html, /Music volume/);
  assert.match(html, /Import audio clip · up to 3 MiB each, 12 MiB per project/);
});

test('terrain creation shows logical dimensions and distinguishes them from resident or rendered cells', () => {
  const html = renderToStaticMarkup(
    React.createElement(SceneSettings, {
      scene: sceneSchema.parse({ id: 'scene', name: 'Scene' }),
      worlds: [],
      apply: async () => undefined,
      createWorld: async () => undefined,
      updateWorld: async () => undefined,
    }),
  );

  assert.match(
    html,
    /Logical terrain extent \(width × depth\): 256 × 256 cells at 0\.5 m per cell = 128\.00 m × 128\.00 m\./,
  );
  assert.match(html, /does not indicate how many terrain cells are currently resident or rendered/i);
  assert.match(html, /independent voxel size/i);
});

test('existing terrain shows saved logical bounds in meters using its draft cell size', () => {
  const world = worldDocumentSchema.parse({
    id: 'existing-world',
    name: 'Existing world',
    seed: 42,
    chunkSize: 16,
    voxelSize: 0.25,
    generator: {
      type: 'terrain',
      version: 1,
      mode: 'heightfield',
      origin: [-320, -160],
      size: [640, 320],
      minY: -32,
      maxY: 128,
      baseHeight: 16,
      amplitude: 32,
      noise: 0.35,
      palette: { surface: 0x79a94e, subsurface: 0x806044, deep: 0x5e6269, materialType: 'STANDARD' },
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(SceneSettings, {
      scene: sceneSchema.parse({ id: 'scene', name: 'Scene', worldId: world.id }),
      worlds: [world],
      apply: async () => undefined,
      createWorld: async () => undefined,
      updateWorld: async () => undefined,
    }),
  );

  assert.match(
    html,
    /Logical terrain extent \(width × depth\): 640 × 320 cells at 0\.25 m per cell = 160\.00 m × 80\.00 m\./,
  );
  assert.match(html, /uses the saved world bounds/i);
  assert.match(html, /does not indicate how many terrain cells are currently resident or rendered/i);
});

test('voxel3d settings expose validated cave-field density through the world update schema', () => {
  const world = worldDocumentSchema.parse({
    id: 'voxel-world',
    name: 'Voxel world',
    seed: 17,
    chunkSize: 16,
    voxelSize: 0.5,
    generator: {
      type: 'terrain',
      version: 1,
      mode: 'voxel3d',
      origin: [-32, -32],
      size: [64, 64],
      minY: -16,
      maxY: 80,
      baseHeight: 16,
      amplitude: 20,
      noise: 0.35,
      caveDensity: 0.4,
      caveDepth: 28,
      caveCrossPassage: true,
      caveNetwork: true,
      overhangDensity: 0.6,
      overhangMaxHeight: 24,
      overhangFootprint: [
        [0, 0.5],
        [1, 1],
      ],
      overhangHeightMap: [
        [0, 0.25],
        [0.75, 1],
      ],
      palette: { surface: 0x79a94e, subsurface: 0x806044, deep: 0x5e6269, materialType: 'STANDARD' },
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(SceneSettings, {
      scene: sceneSchema.parse({ id: 'scene', name: 'Scene', worldId: world.id }),
      worlds: [world],
      apply: async () => undefined,
      createWorld: async () => undefined,
      updateWorld: async () => undefined,
    }),
  );

  assert.match(html, /Additional cave field density \(0–1\)/);
  assert.match(html, /Main cave passage depth \(terrain cells; 0 = automatic\)/);
  assert.match(html, /Generate connected cross-passage/);
  assert.match(html, /Generate a curved, world-spanning cave trunk/);
  assert.match(html, /Connected overhang density \(0–1\)/);
  assert.match(html, /Maximum overhang height \(terrain cells\)/);
  assert.match(html, /Overhang layer-density profile \(comma-separated 0–1 samples\)/);
  assert.match(html, /Horizontal overhang footprint \(rows \+Z, columns \+X; comma-separated 0–1 samples\)/);
  assert.match(html, /Deterministic overhang height map \(normalized 0–1; rows \+Z, columns \+X\)/);
  assert.match(html, /fully controls the overhang silhouette/);
  assert.match(html, /value="0\.4"/);
  const update = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { caveDensity: 0.75 },
  });
  assert.equal(update.type, 'world.update');
  if (update.type === 'world.update') assert.equal(update.generator?.caveDensity, 0.75);
  const overhangUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { overhangDensity: 0.75 },
  });
  assert.equal(overhangUpdate.type, 'world.update');
  if (overhangUpdate.type === 'world.update') assert.equal(overhangUpdate.generator?.overhangDensity, 0.75);
  const overhangHeightUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { overhangMaxHeight: 48 },
  });
  assert.equal(overhangHeightUpdate.type, 'world.update');
  if (overhangHeightUpdate.type === 'world.update')
    assert.equal(overhangHeightUpdate.generator?.overhangMaxHeight, 48);
  const overhangProfileUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { overhangProfile: [1, 0.5, 0] },
  });
  assert.equal(overhangProfileUpdate.type, 'world.update');
  if (overhangProfileUpdate.type === 'world.update')
    assert.deepEqual(overhangProfileUpdate.generator?.overhangProfile, [1, 0.5, 0]);
  const overhangFootprintUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: {
      overhangFootprint: [
        [0, 0.5],
        [1, 1],
      ],
    },
  });
  assert.equal(overhangFootprintUpdate.type, 'world.update');
  if (overhangFootprintUpdate.type === 'world.update')
    assert.deepEqual(overhangFootprintUpdate.generator?.overhangFootprint, [
      [0, 0.5],
      [1, 1],
    ]);
  const overhangHeightMapUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: {
      overhangHeightMap: [
        [0, 0.25],
        [0.75, 1],
      ],
    },
  });
  assert.equal(overhangHeightMapUpdate.type, 'world.update');
  if (overhangHeightMapUpdate.type === 'world.update')
    assert.deepEqual(overhangHeightMapUpdate.generator?.overhangHeightMap, [
      [0, 0.25],
      [0.75, 1],
    ]);
  const clearOverhangHeightMap = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { overhangHeightMap: null },
  });
  assert.equal(clearOverhangHeightMap.type, 'world.update');
  if (clearOverhangHeightMap.type === 'world.update')
    assert.equal(clearOverhangHeightMap.generator?.overhangHeightMap, null);
  const clearOverhangFootprint = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { overhangFootprint: null },
  });
  assert.equal(clearOverhangFootprint.type, 'world.update');
  if (clearOverhangFootprint.type === 'world.update')
    assert.equal(clearOverhangFootprint.generator?.overhangFootprint, null);
  const clearOverhangProfile = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { overhangProfile: null },
  });
  assert.equal(clearOverhangProfile.type, 'world.update');
  if (clearOverhangProfile.type === 'world.update')
    assert.equal(clearOverhangProfile.generator?.overhangProfile, null);
  assert.equal(
    operationSchema.safeParse({
      type: 'world.update',
      worldId: world.id,
      generator: { overhangProfile: [1, 1.1] },
    }).success,
    false,
  );
  const caveDepthUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { caveDepth: 48 },
  });
  assert.equal(caveDepthUpdate.type, 'world.update');
  if (caveDepthUpdate.type === 'world.update') assert.equal(caveDepthUpdate.generator?.caveDepth, 48);
  const caveCrossPassageUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { caveCrossPassage: false },
  });
  assert.equal(caveCrossPassageUpdate.type, 'world.update');
  if (caveCrossPassageUpdate.type === 'world.update')
    assert.equal(caveCrossPassageUpdate.generator?.caveCrossPassage, false);
  const caveNetworkUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { caveNetwork: false },
  });
  assert.equal(caveNetworkUpdate.type, 'world.update');
  if (caveNetworkUpdate.type === 'world.update')
    assert.equal(caveNetworkUpdate.generator?.caveNetwork, false);
  const caveNetworkReachUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { caveNetworkReach: 512 },
  });
  assert.equal(caveNetworkReachUpdate.type, 'world.update');
  if (caveNetworkReachUpdate.type === 'world.update')
    assert.equal(caveNetworkReachUpdate.generator?.caveNetworkReach, 512);
  const caveBranchUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { caveBranchCount: 4 },
  });
  assert.equal(caveBranchUpdate.type, 'world.update');
  if (caveBranchUpdate.type === 'world.update') assert.equal(caveBranchUpdate.generator?.caveBranchCount, 4);
  const caveEntrancesUpdate = operationSchema.parse({
    type: 'world.update',
    worldId: world.id,
    generator: { caveEntrancesPerRegion: 4 },
  });
  assert.equal(caveEntrancesUpdate.type, 'world.update');
  if (caveEntrancesUpdate.type === 'world.update')
    assert.equal(caveEntrancesUpdate.generator?.caveEntrancesPerRegion, 4);
  assert.equal(
    operationSchema.safeParse({
      type: 'world.update',
      worldId: world.id,
      generator: { overhangMaxHeight: 65 },
    }).success,
    false,
  );
  assert.equal(
    operationSchema.safeParse({ type: 'world.update', worldId: world.id, generator: { caveDepth: 257 } })
      .success,
    false,
  );
  assert.equal(
    operationSchema.safeParse({
      type: 'world.update',
      worldId: world.id,
      generator: { caveNetworkReach: 4097 },
    }).success,
    false,
  );
  assert.equal(
    operationSchema.safeParse({
      type: 'world.update',
      worldId: world.id,
      generator: { caveBranchCount: 5 },
    }).success,
    false,
  );
  assert.equal(
    operationSchema.safeParse({
      type: 'world.update',
      worldId: world.id,
      generator: { caveEntrancesPerRegion: 5 },
    }).success,
    false,
  );
  assert.equal(
    operationSchema.safeParse({ type: 'world.update', worldId: world.id, generator: { caveDensity: 1.01 } })
      .success,
    false,
  );
  assert.equal(
    operationSchema.safeParse({
      type: 'world.update',
      worldId: world.id,
      generator: { overhangDensity: -0.01 },
    }).success,
    false,
  );
});
