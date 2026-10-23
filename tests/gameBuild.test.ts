import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createExample, exampleKinds } from '../services/examples';
import { buildGame, exportProject, sceneHasRigidBodies } from '../server/gameBuild';
import { GameSimulation } from '../runtime/GameSimulation';
import { applyProjectOperations, newProject, validateProject } from '../services/projectDocument';
import type { Component, ProjectDocument } from '../services/projectDocument';
import { keyboardActionForCode, resolvePlayerControls } from '../services/playerControls';

test('creator walkthrough exposes sprint through a named input field', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'runtime/creatorWalkthrough.ts'), 'utf8');
  assert.match(source, /name="sprint" type="checkbox"/);
  assert.match(source, /sprint: field\('sprint'\)\.checked/);
  assert.doesNotMatch(source, /fields\[\d+\]/);
});

function assertMultiplayerConnectPolicy(html: string) {
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy, 'Expected a standalone Content Security Policy.');
  const connectDirective = policy.split(';').find((directive) => directive.trim().startsWith('connect-src '));
  assert.equal(connectDirective?.trim(), 'connect-src wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*');
  const scriptDirective = policy.split(';').find((directive) => directive.trim().startsWith('script-src '));
  assert.equal(
    scriptDirective?.trim(),
    "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
    'Rapier must compile its embedded WebAssembly without enabling JavaScript eval.',
  );
}

function interactionProject(): ProjectDocument {
  const project = newProject('standalone-interaction', 'Standalone interaction');
  project.scenes[0].variables = { score: 0, touches: 0, leaves: 0 };
  const rules = {
    type: 'rules',
    apiVersion: 1,
    rules: [
      {
        event: 'interact',
        interval: 1,
        once: false,
        actions: [{ type: 'add', variable: 'score', value: 1 }],
      },
      { event: 'touch', interval: 1, once: false, actions: [{ type: 'add', variable: 'touches', value: 1 }] },
      {
        event: 'untouch',
        interval: 1,
        once: false,
        actions: [{ type: 'add', variable: 'leaves', value: 1 }],
      },
    ],
  } satisfies Extract<Component, { type: 'rules' }>;
  const targets: { id: string; position: [number, number, number]; prompt: string }[] = [
    { id: 'near', position: [1, 0, 0], prompt: 'Open chest' },
    { id: 'far', position: [2, 0, 0], prompt: 'Talk' },
  ];
  const targetNodes = targets.map(({ id, position, prompt }) => {
    const components: Component[] = [
      { type: 'collider', size: [1, 1, 1], offset: [0, 0.5, 0], solid: false },
      { type: 'interactable', prompt, range: 3 },
      rules,
    ];
    return {
      id,
      name: id,
      assetId: null,
      parentId: null,
      transform: {
        position,
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      enabled: true,
      components,
      attachments: [],
    };
  });
  project.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      enabled: true,
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
      ],
      attachments: [],
    },
    ...targetNodes,
  ];
  return validateProject(project);
}

function physicsProject(): ProjectDocument {
  const project = createExample('exploration', 'standalone-physics');
  project.scenes[0].nodes.push({
    id: 'physics-body',
    name: 'Physics body',
    assetId: null,
    parentId: null,
    transform: { position: [100, 10, 100], rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components: [
      { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0], solid: true },
      { type: 'rigid-body', gravity: 9.81, linearDamping: 0, restitution: 0, velocity: [0, 0, 0] },
    ],
    attachments: [],
  });
  return validateProject(project);
}

test('standalone exports contain only selected scene assets, embedded runtime, safe data and license notices', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-export-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-export-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const kind of exampleKinds) {
    let p = createExample(kind, `export-${kind}`);
    p = applyProjectOperations(p, [
      { type: 'asset.variant', sourceId: 'hero', id: 'unused-variant', name: 'Unused' },
      { type: 'project.rename', name: 'Safe </script><img src=x> title' },
    ]);
    const game = exportProject(p, 'main');
    assert.ok(!game.assets.some((a) => a.id === 'unused-variant'));
    assert.ok(game.assets.every((a) => !a.recipe && !a.variantOf));
    assert.equal(game.editorDraft, null);
    const result = await buildGame(p, 'main', { root: process.cwd(), directory });
    const html = await fs.readFile(result.path, 'utf8');
    assert.equal(result.sha256, createHash('sha256').update(html).digest('hex'));
    assert.equal(result.bytes, Buffer.byteLength(html));
    assertMultiplayerConnectPolicy(html);
    assert.match(html, /id="multiplayer-form" method="post"/);
    assert.match(
      html,
      /id="multiplayer-credential" type="password" maxlength="43" required autocomplete="off"/,
    );
    assert.match(html, /Offline\. Multiplayer is optional\./);
    assert.doesNotMatch(html, /id="multiplayer-(?:endpoint|room-id|credential)"[^>]*value=/);
    assert.match(html, /worker-src blob:/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.match(html, /THE SOFTWARE IS PROVIDED/);
    assert.match(html, /third-party-notices/);
    assert.match(html, /rendererCallsPerSecond/);
    assert.match(html, /rendererCallMsPerCall/);
    assert.match(html, /measurePerformance/);
    assert.match(html, /id="cap-frame-rate" type="checkbox"/);
    assert.match(html, /Limit render rate/);
    assert.match(html, /Maximum render rate/);
    assert.match(html, /Off by default/);
    assert.match(html, /uses timing deadlines to schedule render work/);
    assert.match(html, /display control presentation/);
    assert.match(html, /value="360"/);
    assert.match(html, /animationFrameCallbacksPerSecond/);
    assert.match(html, /averageFps/);
    assert.doesNotMatch(html, /delivered FPS/);
    assert.doesNotMatch(html, /renderedFps/);
    assert.doesNotMatch(html, /<img src=x>/);
    const embedded = JSON.parse(
      html.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
    );
    assert.deepEqual(embedded, game);
    const embeddedWorkers = JSON.parse(
      html.match(/<script id="voxshop-workers" type="application\/json">([\s\S]*?)<\/script>/)![1],
    );
    if (game.worlds.length) {
      assert.ok(embeddedWorkers.terrain.length > 1000, 'World games embed the terrain worker in the HTML.');
      assert.match(embeddedWorkers.terrain, /onmessage/);
    } else assert.equal(embeddedWorkers.terrain, '');
    if (game.worlds.some((world) => world.generator.mode === 'voxel3d')) {
      assert.ok(embeddedWorkers.voxel.length > 1000, 'Voxel worlds embed the voxel worker in the HTML.');
      assert.match(embeddedWorkers.voxel, /onmessage/);
    } else assert.equal(embeddedWorkers.voxel, '');
    if (kind === 'survival') {
      assert.equal(embedded.scenes[0].items.length, 3);
      assert.equal(embedded.scenes[0].recipes[0].id, 'campfire');
      assert.equal(embedded.scenes[0].recipes[0].outputs[0].itemId, 'campfire-kit');
    }
    if (kind === 'construction') {
      assert.equal(embedded.scenes[0].worldId, 'construction-world');
      assert.equal(embedded.worlds[0].generator.mode, 'voxel3d');
      assert.equal(embedded.worlds[0].voxelSize, 1.5);
      assert.deepEqual(
        embedded.scenes[0].items.map((item: any) => item.id),
        ['stone'],
      );
      assert.ok(
        embedded.scenes[0].nodes.some((node: any) =>
          node.components.some(
            (component: any) =>
              component.type === 'construction' &&
              component.range === 6 &&
              component.placeCost[0]?.itemId === 'stone' &&
              component.removeYield[0]?.itemId === 'stone',
          ),
        ),
      );
      assert.match(embedded.scenes[0].instructions, /place cells, and harvest them/);
    }
  }
});

test('standalone projects retain fitted gear assets referenced by item use effects', () => {
  const project = createExample('arena', 'export-equipment-item'),
    player = project.scenes[0].nodes.find((node) => node.id === 'player')!;
  player.attachments = [];
  project.scenes[0].nodes = project.scenes[0].nodes.filter((node) => node.id !== 'shell-pickup');
  project.scenes[0].objectives = project.scenes[0].objectives.filter(
    (objective) => objective.id !== 'find-shell',
  );
  project.scenes[0].items = [
    {
      id: 'shell-token',
      name: 'Shell token',
      description: '',
      maxStack: 1,
      use: { type: 'equip', assetId: 'armor' },
    },
  ];
  const game = exportProject(project, 'main'),
    shell = game.assets.find((asset) => asset.id === 'armor');
  assert.equal(shell?.equipment?.kind, 'shell');
  assert.equal(game.scenes[0].items[0].use?.type, 'equip');
});

test('standalone build selects a Rapier-free runtime only when the scene has no rigid bodies', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-physics-export-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-physics-export-')));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const runtimeDirectory = path.join(process.cwd(), 'dist');
  const [runtimeLite, runtimeFull] = await Promise.all([
    fs.readFile(path.join(runtimeDirectory, 'runtime-lite.js'), 'utf8'),
    fs.readFile(path.join(runtimeDirectory, 'runtime.js'), 'utf8'),
  ]);
  assert.ok(runtimeLite.length < runtimeFull.length);
  assert.ok(
    runtimeFull.length - runtimeLite.length > 1_000_000,
    'The no-body build leaves out the bundled Rapier WebAssembly payload; progress-schema field names may still mention physics.',
  );
  assert.doesNotMatch(runtimeLite, /@dimforge/i);
  assert.match(runtimeFull, /rapier/i);

  const extractRuntime = async (project: ProjectDocument) => {
    const result = await buildGame(project, 'main', { root: process.cwd(), directory });
    const html = await fs.readFile(result.path, 'utf8');
    const runtime = html.match(
      /<script id="voxshop-project" type="application\/json">[\s\S]*?<\/script><script id="voxshop-workers" type="application\/json">[\s\S]*?<\/script><script>([\s\S]*?)<\/script>/,
    )?.[1];
    assert.ok(runtime, 'Expected an embedded standalone runtime.');
    return { html, runtime };
  };

  const noPhysics = createExample('exploration', 'standalone-lite-export');
  assert.equal(sceneHasRigidBodies(noPhysics.scenes[0]), false);
  const lite = await extractRuntime(noPhysics);
  assert.equal(lite.runtime, runtimeLite);
  assert.match(lite.html, /id="voxshop-runtime-notice"/);
  assert.match(lite.html, /Required Notice: Copyright 2025-2026 Hexxis Studios/);
  assert.match(lite.html, /blob\/v2\.0\.0-alpha\.1\/LICENSE/);
  assert.match(lite.html, /commercial games and assets without engine royalties/);
  assert.doesNotMatch(lite.html, /Dimforge EURL|Apache License/i);

  const withPhysics = physicsProject();
  assert.equal(sceneHasRigidBodies(withPhysics.scenes[0]), true);
  const full = await extractRuntime(withPhysics);
  assert.equal(full.runtime, runtimeFull);
  assert.match(full.html, /Rapier 3D compatibility build 0\.21\.0 \(Apache-2\.0\)/);
  assert.match(full.html, /Copyright 2020 Dimforge EURL/);
  assert.match(full.html, /Version 2\.0, January 2004/);
  assertMultiplayerConnectPolicy(full.html);
  assert.doesNotMatch(full.html, /<script[^>]+src=/i);
  assert.doesNotMatch(full.html, /<link[^>]+href=/i);

  const simulation = new GameSimulation(exportProject(withPhysics, 'main'));
  await simulation.ready;
  assert.deepEqual(simulation.errors, []);
  simulation.step();
  assert.ok(simulation.worldPosition(simulation.nodes.get('physics-body')!).y < 10);
  simulation.dispose();
});

test('standalone interaction export exposes inspection and dispatches the nearest target action', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-interaction-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-interaction-')));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await buildGame(interactionProject(), 'main', { root: process.cwd(), directory });
  const html = await fs.readFile(result.path, 'utf8');
  const runtime = html.match(
    /<script id="voxshop-project" type="application\/json">[\s\S]*?<\/script><script>([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(runtime, 'Expected the standalone runtime bundle after the embedded project.');
  const apiMarker = 'VoxShopGame:';
  const apiStart = runtime.indexOf(apiMarker);
  assert.notEqual(apiStart, -1, 'Expected the standalone inspection API in the runtime bundle.');
  const objectStart = runtime.indexOf('{', apiStart + apiMarker.length);
  let depth = 0,
    quote = '',
    escaped = false,
    objectEnd = -1;
  for (let index = objectStart; index < runtime.length; index++) {
    const character = runtime[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      objectEnd = index + 1;
      break;
    }
  }
  assert.ok(objectEnd > objectStart, 'Expected a complete standalone API object.');
  const apiSource = runtime.slice(objectStart, objectEnd);
  const viewportName = apiSource.match(/inspect:\(\)=>([\w$]+)\.simulation\.inspect\(\)/)?.[1];
  assert.ok(viewportName, 'Expected the standalone inspect API to expose simulation inspection.');
  const keyDownStart = runtime.indexOf('this.keyDown=');
  const keyDownEnd = runtime.indexOf(';this.keyUp=', keyDownStart);
  assert.ok(keyDownStart >= 0 && keyDownEnd > keyDownStart, 'Expected the standalone keyboard handler.');
  const methodStart = runtime.indexOf('handleKeyDown(', keyDownEnd),
    methodEnd = runtime.indexOf('pollGamepad(', methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'Expected the shared keyboard input method.');
  const methodOpen = runtime.indexOf('{', methodStart);
  const actionLookup = runtime
    .slice(methodOpen, methodEnd)
    .match(/(?<![\w$])([\w$]+)\(\w+\.code,this\.activePlayerControls\(\)\.keyboard\)/);
  assert.ok(actionLookup, 'Expected the exported keyboard binding lookup.');
  const embedded = JSON.parse(
    html.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
  ) as ProjectDocument;
  const simulation = new GameSimulation(embedded);
  let framePacing = { capFrameRate: false, maxFpsTarget: 144 };
  const viewport = {
    simulation,
    framePacingSettings: () => ({ ...framePacing }),
    setFramePacing(settings: typeof framePacing) {
      framePacing = { ...settings };
      return this.framePacingSettings();
    },
    step(input: { interact?: boolean } = {}, frames = 1) {
      for (let frame = 0; frame < frames; frame++) simulation.step(input);
      return simulation.inspect();
    },
    pending: {} as { interact?: boolean },
    keys: new Set<string>(),
    agentPaused: false,
    cameraOverride: false,
    activePlayerControls: () => resolvePlayerControls(),
    pressGameplayAction(action: string) {
      if (action === 'interact') this.pending.interact = true;
      return true;
    },
    handleKeyDown: (_event: { code: string; preventDefault: () => void }) => {},
  };
  viewport.handleKeyDown = new Function(
    actionLookup[1],
    `return function(${runtime.slice(methodStart + 'handleKeyDown('.length, runtime.indexOf(')', methodStart))})${runtime.slice(methodOpen, methodEnd)}`,
  )(keyboardActionForCode).bind(viewport);
  const keyDown = new Function(
    `return (${runtime.slice(keyDownStart + 'this.keyDown='.length, keyDownEnd)})`,
  ).call(viewport) as (event: { code: string; preventDefault: () => void }) => void;
  const apiContext: Record<string, unknown> = { [viewportName]: viewport };
  for (const match of apiSource.matchAll(/(?:saveProgress|loadProgress|restart):([\w$]+)/g))
    apiContext[match[1]] = () => 'unavailable';
  const pacingSetter = apiSource.match(/setFramePacing:([\w$]+)/)?.[1];
  assert.ok(pacingSetter, 'Expected the standalone frame-pacing API.');
  apiContext[pacingSetter] = (settings: typeof framePacing) => ({
    settings: viewport.setFramePacing(settings),
    saved: true,
  });
  const api = runInNewContext(`(${apiSource})`, apiContext) as {
    inspect: () => ReturnType<GameSimulation['inspect']>;
    step: (input: { interact?: boolean; moveX?: number }) => ReturnType<GameSimulation['inspect']>;
    framePacing: () => typeof framePacing;
    setFramePacing: (settings: typeof framePacing) => { settings: typeof framePacing; saved: boolean };
    saveProgress: () => string;
    loadProgress: () => string;
  };

  assert.deepEqual(api.framePacing(), { capFrameRate: false, maxFpsTarget: 144 });
  assert.deepEqual(api.setFramePacing({ capFrameRate: true, maxFpsTarget: 60 }), {
    settings: { capFrameRate: true, maxFpsTarget: 60 },
    saved: true,
  });
  assert.deepEqual(api.framePacing(), { capFrameRate: true, maxFpsTarget: 60 });
  api.step({ interact: false });
  assert.deepEqual(api.inspect().interactionTarget, {
    nodeId: 'near',
    prompt: 'Open chest',
    distanceMeters: 0.5,
  });

  let prevented = false;
  keyDown({ code: 'KeyE', preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(viewport.pending.interact, true);
  api.step(viewport.pending);
  assert.equal(api.inspect().variables.score, 1);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'interact').map((event) => event.nodeId),
    ['near'],
  );
  for (let frame = 0; frame < 10; frame++) api.step({ moveX: 1 });
  assert.equal(api.inspect().variables.touches, 1);
  for (let frame = 0; frame < 20; frame++) api.step({ moveX: -1 });
  assert.equal(api.inspect().variables.leaves, 1);
  assert.deepEqual(
    simulation.events.filter((event) => event.type === 'untouch').map((event) => event.nodeId),
    ['near'],
  );
});

test('standalone exports retain only the terrain world selected by their scene', () => {
  const base = createExample('exploration', 'world-export');
  const worlds = ['selected-world', 'unused-world'].map((id, index) => ({
    id,
    name: id,
    seed: index,
    chunkSize: 16,
    voxelSize: index ? 0.25 : 0.5,
    generator: {
      type: 'terrain' as const,
      version: 1 as const,
      origin: [0, 0] as [number, number],
      size: [32, 32] as [number, number],
      minY: -8,
      maxY: 64,
      baseHeight: 12,
      amplitude: 20,
      noise: 0.25,
      palette: {
        surface: 0x55aa44,
        subsurface: 0x725439,
        deep: 0x686b70,
        surfaceDepth: 2,
        subsurfaceDepth: 3,
        materialType: 'STANDARD' as const,
      },
    },
    edits: [],
  }));
  const project = {
    ...base,
    worlds,
    scenes: [{ ...base.scenes[0], worldId: 'selected-world' }],
  } as ProjectDocument;

  const exported = exportProject(project, 'main');
  assert.deepEqual(
    exported.worlds.map((world) => world.id),
    ['selected-world'],
  );
  assert.equal(exported.worlds[0].voxelSize, 0.5);

  const noWorld = exportProject({ ...project, scenes: [{ ...project.scenes[0], worldId: null }] }, 'main');
  assert.deepEqual(noWorld.worlds, []);
});
