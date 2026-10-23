import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION } from '../services/appMetadata';
import { GameSession } from '../runtime/GameSession';
import { CampaignProgressStore } from '../runtime/campaignProgress';
import { applyProjectOperations, type ProjectDocument, type SceneNode } from '../services/projectDocument';
import { createExample } from '../services/examples';

const PROJECT_ID = 'core-workflows-acceptance-20261023';
const FIXTURE_NAME = 'Core workflows acceptance — 2026-10-23';
const args = process.argv.slice(2);
const directoryArgument = args.find((argument) => !argument.startsWith('--'));
const dryRun = args.includes('--dry-run');
if (!directoryArgument && !dryRun)
  throw Error(
    'Pass the data directory of a disposable running VoxShop editor. Add --capture [origin] only after coordinating the editor tab owner.',
  );
const directory = directoryArgument ? path.resolve(directoryArgument) : '';
const captureRequested = args.includes('--capture');
const captureOrigin = captureRequested ? args[args.indexOf('--capture') + 1] : undefined;
const output = directory ? path.join(directory, 'visual-evidence') : '';
if (!dryRun) {
  await fs.access(path.join(directory, 'access.json')).catch(() => {
    throw Error(`No access.json exists in ${directory}.`);
  });
  await fs.mkdir(output, { recursive: true });
}

const client = new Client({ name: 'voxshop-core-workflows', version: APP_VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'mcp/server.ts'],
  cwd: process.cwd(),
  env: { ...(process.env as Record<string, string>), VOXSHOP_DATA_DIR: directory },
  stderr: 'pipe',
});
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: input });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent as any;
};
const sceneNode = (
  id: string,
  name: string,
  assetId: string | null,
  position: [number, number, number],
  components: unknown[] = [],
  extra: Record<string, unknown> = {},
): SceneNode =>
  ({
    id,
    name,
    assetId,
    parentId: null,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components,
    attachments: [],
    ...extra,
  }) as SceneNode;

function roomGate(
  id: string,
  name: string,
  destination: string,
  position: [number, number, number],
): SceneNode {
  return sceneNode(id, name, 'campfire', position, [
    { type: 'collider', size: [1.2, 1.8, 1.2], offset: [0, 0.9, 0], solid: false },
    { type: 'interactable', prompt: name, range: 3 },
    {
      type: 'rules',
      apiVersion: 1,
      rules: [
        {
          event: 'interact',
          interval: 1,
          once: false,
          ...(id === 'gate-lookout'
            ? { condition: { variable: 'campfireBuilt', scope: 'campaign', op: '==', value: 1 } }
            : {}),
          actions:
            id === 'gate-lookout'
              ? [
                  { type: 'set', variable: 'chapter', scope: 'campaign', value: 1 },
                  { type: 'transition', sceneId: destination },
                ]
              : [{ type: 'transition', sceneId: destination }],
        },
      ],
    },
  ]);
}

const hud = [
  {
    id: 'acceptance-hud',
    type: 'panel',
    anchor: 'top-left',
    offsetX: 12,
    offsetY: 12,
    width: 330,
    height: 190,
    layout: 'column',
    gap: 6,
    padding: 10,
  },
  {
    id: 'tab-status',
    type: 'tab-button',
    parentId: 'acceptance-hud',
    text: 'Status',
    groupId: 'acceptance-tabs',
    tabId: 'status',
    width: 90,
  },
  {
    id: 'tab-inventory',
    type: 'tab-button',
    parentId: 'acceptance-hud',
    text: 'Inventory',
    groupId: 'acceptance-tabs',
    tabId: 'inventory',
    width: 110,
  },
  {
    id: 'status-page',
    type: 'panel',
    parentId: 'acceptance-hud',
    visibleWhenTab: { groupId: 'acceptance-tabs', tabId: 'status' },
    width: 300,
    height: 95,
    layout: 'column',
    padding: 8,
  },
  {
    id: 'status-title',
    type: 'text',
    parentId: 'status-page',
    text: 'Camp scout field log',
    width: 260,
  },
  {
    id: 'chapter-value',
    type: 'value',
    parentId: 'status-page',
    binding: { kind: 'variable', id: 'chapter', scope: 'campaign' },
    prefix: 'Chapter: ',
    width: 260,
  },
  {
    id: 'inventory-page',
    type: 'panel',
    parentId: 'acceptance-hud',
    visibleWhenTab: { groupId: 'acceptance-tabs', tabId: 'inventory' },
    width: 300,
    height: 95,
    layout: 'column',
    padding: 8,
  },
  {
    id: 'inventory-grid',
    type: 'inventory',
    parentId: 'inventory-page',
    maxItems: 8,
    columns: 4,
    showUseButtons: true,
    width: 270,
  },
];

function makeLookoutScene(project: ProjectDocument) {
  const entry = structuredClone(project.scenes.find((scene) => scene.id === 'main')!);
  const player = structuredClone(entry.nodes.find((node) => node.id === 'player')!);
  player.transform.position = [0, 0, 8];
  const chapterMarker = sceneNode(
    'chapter-marker',
    'Chapter marker',
    null,
    [0, 0, 5],
    [
      {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'start',
            interval: 1,
            once: true,
            actions: [{ type: 'add', variable: 'chapterVisits', scope: 'campaign', value: 1 }],
          },
        ],
      },
    ],
  );
  const lookout = {
    ...entry,
    id: 'level-two',
    name: 'Lookout and training yard',
    background: 0x26384b,
    groundColor: 0x4b6049,
    bounds: 28,
    nodes: [
      player,
      roomGate('gate-home', 'Return to camp', 'main', [0, 0, 6.4]),
      chapterMarker,
      sceneNode(
        'lookout-enemy',
        'Training sentinel',
        'hero',
        [-7, 0, -2],
        [
          { type: 'enemy', speed: 0.7, damage: 2, range: 1.2 },
          { type: 'collider', size: [0.8, 1.5, 0.8], offset: [0, 0.75, 0], solid: true },
          { type: 'health', maximum: 50 },
        ],
      ),
      sceneNode(
        'kinematic-platform',
        'Kinematic overlook platform',
        'bench',
        [4, 0.1, -1],
        [
          { type: 'collider', size: [3.5, 0.5, 2.6], offset: [0, 0.25, 0], solid: true },
          { type: 'rigid-body', bodyType: 'kinematic-position', gravity: 0, lockRotation: true },
        ],
      ),
      sceneNode(
        'lookout-wall',
        'Rotated navigation wall',
        'training-wall',
        [0, 1.5, -2],
        [{ type: 'collider', size: [3, 3, 0.8], offset: [0, 0, 0], solid: true }],
        { transform: { position: [0, 1.5, -2], rotation: [0, 0.12, 0], scale: [1, 1, 1] } },
      ),
    ],
    hud: structuredClone(hud),
    instructions: 'Inspect the sentinel and raised platform, then return to camp through the gate.',
  };
  return lookout;
}

function makePrefab() {
  const root = sceneNode('lookout-sign', 'Lookout sign', 'bench', [0, 0, 0]);
  const plaque = sceneNode('lookout-plaque', 'Camp marker', 'campfire', [0, 1, 0], [], {
    parentId: root.id,
  });
  return {
    id: 'lookout-sign-prefab',
    name: 'Lookout sign assembly',
    rootId: root.id,
    attachmentParentId: null,
    nodes: [root, plaque],
  };
}

function baseOperations(project: ProjectDocument) {
  const main = structuredClone(project.scenes.find((scene) => scene.id === 'main')!);
  main.hud = structuredClone(hud) as any;
  main.instructions = 'Gather wood and stone, craft a campfire kit, then use the lookout gate.';
  const workbench = main.nodes.find((node) => node.id === 'workbench')!;
  const workbenchRules = workbench.components.find((component) => component.type === 'rules') as any;
  assert.ok(workbenchRules?.rules?.[0], 'The survival starter needs its authored workbench rule.');
  workbenchRules.rules[0].actions = [
    { type: 'craft', recipeId: 'campfire', batches: 1 },
    { type: 'set', variable: 'campfireBuilt', scope: 'campaign', value: 1 },
    { type: 'enable', target: 'workbench', value: false },
    { type: 'message', text: 'Campfire crafted. The lookout gate is open.' },
  ];
  const oldSite = main.nodes.find((node) => node.id === 'campfire-site');
  if (oldSite) oldSite.enabled = false;
  main.nodes.push(roomGate('gate-lookout', 'Enter the lookout', 'level-two', [0, 0, -8]));

  const second = makeLookoutScene(project);
  const prefab = makePrefab();
  return [
    {
      type: 'asset.generate',
      id: 'training-wall',
      name: 'Training wall',
      voxelSize: 0.1,
      recipe: {
        version: 1,
        seed: 7,
        shapes: [{ kind: 'box', center: [0, 8, 0], size: [20, 16, 3], color: 0x676b75 }],
      },
    },
    { type: 'scene.put', scene: main },
    { type: 'scene.put', scene: second },
    { type: 'prefab.put', prefab },
    {
      type: 'prefab.instantiate',
      prefabId: prefab.id,
      sceneId: 'level-two',
      nodeIds: ['sign-left', 'plaque-left'],
      position: [-5, 0, -5],
    },
    {
      type: 'prefab.instantiate',
      prefabId: prefab.id,
      sceneId: 'level-two',
      nodeIds: ['sign-right', 'plaque-right'],
      position: [5, 0, -5],
    },
  ];
}

async function assertCampaign(project: ProjectDocument) {
  const original = new GameSession(project, 'main');
  const storage = new Map<string, string>();
  const progressStore = new CampaignProgressStore(project.id, 'main', () => ({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }));
  let resumed: GameSession | undefined;
  let restarted: GameSession | undefined;
  try {
    await original.ready;
    for (let frame = 0; frame < 240; frame++) original.step({ moveZ: -1 });
    const supplies = original.simulation.inventory.map((stack) => [stack.itemId, stack.quantity]);
    assert.deepEqual(
      supplies,
      [
        ['wood', 2],
        ['stone', 1],
      ],
      'Walking the trail gathers the authored recipe inputs.',
    );

    original.step({ interact: true });
    original.step({});
    assert.deepEqual(
      original.simulation.inventory.map((stack) => [stack.itemId, stack.quantity]),
      [['campfire-kit', 1]],
      'The workbench rule crafts the kit and consumes its ingredients.',
    );
    assert.equal(original.simulation.campaignVariables.campfireBuilt, 1);
    assert.equal(original.simulation.nodes.get('workbench')?.enabled, false);
    for (let frame = 0; frame < 80; frame++) original.step({ moveZ: -1 });
    original.step({ interact: true });
    assert.equal(
      original.simulation.scene.id,
      'level-two',
      'The authored gate transitions from camp to lookout.',
    );
    await original.ready;
    assert.equal(original.simulation.campaignVariables.chapterVisits, 1);

    const snapshot = original.progressSnapshot();
    assert.ok(snapshot, 'The visited campaign produces a save snapshot.');
    assert.equal(snapshot.activeSceneId, 'level-two');
    assert.deepEqual(
      snapshot.scenes.map((scene) => scene.sceneId),
      ['main', 'level-two'],
    );
    assert.equal(progressStore.save(snapshot), 'saved');
    original.dispose();

    const loaded = progressStore.load();
    assert.equal(loaded.status, 'loaded');
    if (loaded.status !== 'loaded') return;
    resumed = new GameSession(project, 'main', loaded.snapshot);
    await resumed.ready;
    assert.equal(resumed.simulation.scene.id, 'level-two', 'Load resumes the active non-entry scene.');
    assert.equal(resumed.simulation.campaignVariables.campfireBuilt, 1);
    assert.equal(resumed.simulation.campaignVariables.chapterVisits, 1);
    assert.deepEqual(
      resumed.simulation.inventory.map((stack) => [stack.itemId, stack.quantity]),
      [['campfire-kit', 1]],
    );
    resumed.step({ interact: true });
    assert.equal(
      resumed.simulation.scene.id,
      'main',
      'The return gate brings the saved campaign back to camp.',
    );
    assert.equal(
      resumed.simulation.nodes.get('workbench')?.enabled,
      false,
      'A local scene change survives resume.',
    );
    assert.deepEqual(
      resumed.simulation.inventory.map((stack) => [stack.itemId, stack.quantity]),
      [['campfire-kit', 1]],
    );

    restarted = new GameSession(project, 'main');
    await restarted.ready;
    assert.equal(restarted.simulation.scene.id, 'main');
    assert.deepEqual(
      restarted.simulation.inventory,
      [],
      'Fresh Play starts independently of the saved campaign.',
    );
    assert.equal(restarted.simulation.campaignVariables.campfireBuilt, undefined);
  } finally {
    original.dispose();
    resumed?.dispose();
    restarted?.dispose();
  }
}

async function captureViewport(project: { id: string; revision: number }) {
  const current = await call('project_inspect', { projectId: project.id, compact: true });
  if (current.activeSceneId !== 'main') {
    const updated = await call('project_apply', {
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: `core-capture-entry-${project.revision}`,
      label: 'Open campaign entry scene for acceptance',
      operations: [{ type: 'editor.set', sceneId: 'main' }],
    });
    project.revision = updated.revision;
  }
  await call('project_activate', { projectId: project.id });
  let editors = (await call('viewport_clients')).clients;
  for (
    let attempt = 0;
    attempt < 20 &&
    !(captureOrigin ? editors.some((editor: any) => editor.origin === captureOrigin) : editors.length);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    editors = (await call('viewport_clients')).clients;
  }
  const editor = captureOrigin
    ? editors.filter((candidate: any) => candidate.origin === captureOrigin).at(-1)
    : editors.length === 1
      ? editors[0]
      : null;
  if (!editor) throw Error('Open the intended editor and pass its origin after --capture.');

  const screenshots: { label: string; path: string; state: unknown }[] = [];
  const observe = async (label: string, command: unknown) => {
    let response;
    for (let attempt = 0; attempt < 30; attempt++) {
      response = await client.callTool({
        name: 'viewport_observe',
        arguments: {
          projectId: project.id,
          expectedRevision: project.revision,
          clientId: editor.id,
          command,
        },
      });
      const error = response.isError ? JSON.stringify(response) : '';
      if (!response.isError || !/does not match|still opening|Project changed/i.test(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(response, 'Viewport observation did not return a response.');
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const image = (response.content as Array<{ type: string; mimeType?: string; data?: string }>).find(
      (item) => item.type === 'image' && item.mimeType === 'image/png',
    );
    assert.ok(image?.data, 'Viewport capture must return a rendered PNG.');
    const filename = path.join(output, `core-${label}.png`);
    await fs.writeFile(filename, Buffer.from(image.data, 'base64'));
    const observation = (response.structuredContent as any).observation;
    screenshots.push({ label, path: filename, state: observation.state });
    return observation;
  };

  await observe('main-authoring', { type: 'capture' });
  await observe('play-start', { type: 'play' });
  await observe('hud-inventory-tab', {
    type: 'step',
    frames: 1,
    input: { uiTab: { groupId: 'acceptance-tabs', tabId: 'inventory' } },
  });
  await observe('main-gathered', { type: 'step', frames: 240, input: { moveZ: -1 } });
  const crafted = await observe('main-crafted', { type: 'step', frames: 1, input: { interact: true } });
  assert.equal(
    crafted.state?.campaignVariables.campfireBuilt,
    1,
    'The rendered walkthrough must actually craft.',
  );
  await observe('main-release', { type: 'step', frames: 1, input: {} });
  await observe('approach-lookout', { type: 'step', frames: 80, input: { moveZ: -1 } });
  const transitioned = await observe('lookout-transition', {
    type: 'step',
    frames: 1,
    input: { interact: true },
  });
  assert.equal(transitioned.state?.sceneId, 'level-two');
  await observe('lookout-overview', { type: 'capture' });
  await observe('lookout-hud-status', {
    type: 'step',
    frames: 1,
    input: { uiTab: { groupId: 'acceptance-tabs', tabId: 'status' } },
  });
  await observe('lookout-return-release', { type: 'step', frames: 1, input: {} });
  const returned = await observe('return-to-camp', { type: 'step', frames: 1, input: { interact: true } });
  assert.equal(returned.state?.sceneId, 'main');
  await observe('camp-restored', { type: 'capture' });
  await observe('play-stopped', { type: 'stop' });
  await fs.writeFile(
    path.join(output, 'core-workflows-captures.json'),
    JSON.stringify(
      { projectId: project.id, revision: project.revision, origin: editor.origin, screenshots },
      null,
      2,
    ),
  );
}

if (dryRun) {
  const starter = createExample('survival', PROJECT_ID);
  const project = applyProjectOperations(starter, baseOperations(starter));
  await assertCampaign(project);
  console.log('Local fixture schema and two-scene craft/transition/save/load/restart checks passed.');
} else
  try {
    await client.connect(transport);
    const listed = await call('project_list');
    const existing = listed.projects.find((project: any) => project.id === PROJECT_ID);
    let project: { id: string; revision: number };
    if (existing) {
      const current = await call('project_inspect', { projectId: PROJECT_ID, full: true });
      if (
        current.name !== FIXTURE_NAME ||
        !current.scenes.some((scene: any) => scene.id === 'level-two') ||
        !current.prefabs.some((prefab: any) => prefab.id === 'lookout-sign-prefab')
      )
        throw Error(
          `Project ${PROJECT_ID} exists but is not this completed fixture; refusing to overwrite it.`,
        );
      project = { id: current.id, revision: current.revision };
    } else {
      await call('example_create', { kind: 'survival', id: PROJECT_ID });
      const initial = await call('project_inspect', { projectId: PROJECT_ID, full: true });
      const created = await call('project_apply', {
        projectId: PROJECT_ID,
        expectedRevision: initial.revision,
        requestId: 'core-workflows-build-20261023',
        label: 'Build two-scene core workflow acceptance fixture',
        operations: [{ type: 'project.rename', name: FIXTURE_NAME }, ...baseOperations(initial)],
      });
      project = { id: created.id, revision: created.revision };

      let full = await call('project_inspect', { projectId: project.id, full: true });
      const sourcePrefab = structuredClone(
        full.prefabs.find((prefab: any) => prefab.id === 'lookout-sign-prefab'),
      );
      sourcePrefab.nodes[0].name = 'Lookout sign v2';
      sourcePrefab.nodes[1].name = 'Shelter marker';
      const sourceChanged = await call('project_apply', {
        projectId: project.id,
        expectedRevision: full.revision,
        requestId: 'core-workflows-prefab-update-20261023',
        label: 'Update linked lookout sign source',
        operations: [
          {
            type: 'prefab.put',
            prefab: sourcePrefab,
            sourceInstanceRootId: 'sign-left',
            sourceInstanceNodeIds: { 'lookout-sign': 'sign-left', 'lookout-plaque': 'plaque-left' },
          },
        ],
      });
      project.revision = sourceChanged.revision;
      full = await call('project_inspect', { projectId: project.id, full: true });
      assert.equal(
        full.scenes
          .find((scene: any) => scene.id === 'level-two')
          .nodes.find((node: any) => node.id === 'sign-right').name,
        'Lookout sign v2',
      );
      assert.equal(
        full.scenes
          .find((scene: any) => scene.id === 'level-two')
          .nodes.find((node: any) => node.id === 'plaque-right').name,
        'Shelter marker',
      );

      const overridden = full.scenes
        .find((scene: any) => scene.id === 'level-two')
        .nodes.find((node: any) => node.id === 'plaque-right');
      const reset = await call('project_apply', {
        projectId: project.id,
        expectedRevision: full.revision,
        requestId: 'core-workflows-prefab-reset-20261023',
        label: 'Reset linked plaque override',
        operations: [
          { type: 'node.put', sceneId: 'level-two', node: { ...overridden, name: 'Local test override' } },
          {
            type: 'prefab.reset',
            sceneId: 'level-two',
            instanceRootId: 'sign-right',
            preserveRootPosition: true,
          },
        ],
      });
      project.revision = reset.revision;
      full = await call('project_inspect', { projectId: project.id, full: true });
      assert.equal(
        full.scenes
          .find((scene: any) => scene.id === 'level-two')
          .nodes.find((node: any) => node.id === 'plaque-right').name,
        'Shelter marker',
      );

      const main = structuredClone(full.scenes.find((scene: any) => scene.id === 'main'));
      main.recipes.find((recipe: any) => recipe.id === 'campfire').name = 'Campfire kit — 2 wood + 1 stone';
      const workbenchRules = main.nodes
        .find((node: any) => node.id === 'workbench')
        .components.find((component: any) => component.type === 'rules');
      workbenchRules.rules[0].actions[3].text = 'Craft complete. The lookout gate is open.';
      const authoredEdit = await call('project_apply', {
        projectId: project.id,
        expectedRevision: full.revision,
        requestId: 'core-workflows-recipe-rule-edit-20261023',
        label: 'Edit recipe and workbench rule feedback',
        operations: [{ type: 'scene.put', scene: main }],
      });
      project.revision = authoredEdit.revision;

      const undone = await call('project_undo', {
        projectId: project.id,
        expectedRevision: project.revision,
        requestId: 'core-workflows-undo-20261023',
      });
      project.revision = undone.revision;
      full = await call('project_inspect', { projectId: project.id, full: true });
      assert.equal(
        full.scenes
          .find((scene: any) => scene.id === 'main')
          .recipes.find((recipe: any) => recipe.id === 'campfire').name,
        'Campfire kit',
      );
      const undoMessage = full.scenes
        .find((scene: any) => scene.id === 'main')
        .nodes.find((node: any) => node.id === 'workbench')
        .components.find((component: any) => component.type === 'rules').rules[0].actions[3].text;
      assert.equal(undoMessage, 'Campfire crafted. The lookout gate is open.');

      const redone = await call('project_redo', {
        projectId: project.id,
        expectedRevision: project.revision,
        requestId: 'core-workflows-redo-20261023',
      });
      project.revision = redone.revision;
      full = await call('project_inspect', { projectId: project.id, full: true });
      assert.equal(
        full.scenes
          .find((scene: any) => scene.id === 'main')
          .recipes.find((recipe: any) => recipe.id === 'campfire').name,
        'Campfire kit — 2 wood + 1 stone',
      );
      assert.equal(
        full.scenes
          .find((scene: any) => scene.id === 'main')
          .nodes.find((node: any) => node.id === 'workbench')
          .components.find((component: any) => component.type === 'rules').rules[0].actions[3].text,
        'Craft complete. The lookout gate is open.',
      );

      const saved = await call('project_save', { projectId: project.id });
      assert.equal(saved.revision, project.revision);
      console.log(`Saved authored fixture ${project.id} at revision ${project.revision}: ${saved.path}`);
    }

    const projectDocument = (await call('project_inspect', {
      projectId: project.id,
      full: true,
    })) as ProjectDocument;
    assert.equal(projectDocument.revision, project.revision);
    await assertCampaign(projectDocument);

    const build = await call('game_build', { projectId: project.id, sceneId: 'main' });
    let buildStatus = await call('job_status', { jobId: build.id });
    for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(buildStatus.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      buildStatus = await call('job_status', { jobId: build.id });
    }
    assert.equal(buildStatus.status, 'completed', buildStatus.error);
    const standalone = buildStatus.result;

    const capturePlan = {
      projectId: project.id,
      revision: project.revision,
      standalone,
      commands: [
        { label: 'main-authoring', command: { type: 'capture' } },
        { label: 'play-start', command: { type: 'play' } },
        {
          label: 'hud-inventory-tab',
          command: {
            type: 'step',
            frames: 1,
            input: { uiTab: { groupId: 'acceptance-tabs', tabId: 'inventory' } },
          },
        },
        { label: 'main-gathered', command: { type: 'step', frames: 240, input: { moveZ: -1 } } },
        { label: 'main-crafted', command: { type: 'step', frames: 1, input: { interact: true } } },
        { label: 'main-release', command: { type: 'step', frames: 1, input: {} } },
        { label: 'approach-lookout', command: { type: 'step', frames: 80, input: { moveZ: -1 } } },
        { label: 'lookout-transition', command: { type: 'step', frames: 1, input: { interact: true } } },
        { label: 'lookout-overview', command: { type: 'capture' } },
        {
          label: 'lookout-hud-status',
          command: {
            type: 'step',
            frames: 1,
            input: { uiTab: { groupId: 'acceptance-tabs', tabId: 'status' } },
          },
        },
        { label: 'lookout-return-release', command: { type: 'step', frames: 1, input: {} } },
        { label: 'return-to-camp', command: { type: 'step', frames: 1, input: { interact: true } } },
        { label: 'camp-restored', command: { type: 'capture' } },
        { label: 'play-stopped', command: { type: 'stop' } },
      ],
      manualVisualReview: [
        'Open the HUD editor, switch both tabs, inspect the nested panels and inventory grid, then Play and test inventory use/reorder.',
        'Open the catalog/recipe editor, change an ingredient or label, apply, undo/redo, and reopen to verify persistence.',
        'Open the rule editor for the workbench and gates, verify the campaign guard/action order, and interact in Play.',
        'In the prefab library, edit/update the left linked sign, confirm propagation to the right, add a local override, then reset it.',
        'Inspect the lookout from front and side while the player moves/jumps; observe enemy pathing around the rotated wall and player carry on the platform.',
        'Build the standalone export and repeat the campaign, HUD and save/load walkthrough in the browser export.',
      ],
    };
    await fs.writeFile(
      path.join(output, 'core-workflows-capture-plan.json'),
      JSON.stringify(capturePlan, null, 2),
    );
    console.log(
      `Campaign transition, save/load, restart, prefab propagation/reset, recipe/rule undo-redo passed for ${project.id}.`,
    );
    console.log(`Capture plan retained at ${path.join(output, 'core-workflows-capture-plan.json')}.`);
    console.log(`Standalone export built: ${JSON.stringify(standalone)}.`);
    if (captureRequested) await captureViewport(project);
  } finally {
    await client.close();
  }
