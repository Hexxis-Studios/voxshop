import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../server/app';
import { ProjectStore } from '../server/projectStore';
import { exampleKinds, exampleTests } from '../services/examples';
import { MCP_TOOL_DESCRIPTIONS } from '../services/mcpToolDescriptions';
import { MultiplayerClient } from '../runtime/MultiplayerClient';
import { assetInspectionView, assetSchema, identityTransform, nodeSchema } from '../services/projectDocument';
import { createModelDocument } from '../services/modelDocument';
import { constructionProject } from './fixtures/constructionProject';

test('external MCP client creates, generates, previews, edits, undoes, saves and reopens through the authenticated broker', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-mcp-'));
  const dataDir = path.join(directory, '.voxshop');
  const service = await createApp({
    root: process.cwd(),
    dataDir,
    port: 0,
    clientPort: 3002,
    multiplayerPort: 0,
  });
  const multiplayerUrl = await service.multiplayer.listen();
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => listener.once('listening', r));
  const port = (listener.address() as any).port,
    url = `http://127.0.0.1:${port}`;
  await fs.writeFile(path.join(dataDir, 'access.json'), JSON.stringify({ url, token: service.token }));
  const allowedOrigin = await fetch(`${url}/api/session`, { headers: { Origin: 'http://127.0.0.1:3002' } });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(allowedOrigin.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:3002');
  const unconfiguredOrigin = await fetch(`${url}/api/session`, {
    headers: { Origin: 'http://127.0.0.1:3001' },
  });
  assert.equal(unconfiguredOrigin.status, 403);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'mcp/server.ts'],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), VOXSHOP_DATA_DIR: dataDir },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (c) => (stderr += c.toString()));
  const client = new Client({ name: 'voxshop-acceptance', version: '1.0.0' });
  let multiplayerClient: MultiplayerClient | undefined;
  t.after(async () => {
    await multiplayerClient?.leave();
    await client.close();
    await service.multiplayer.close();
    listener.closeAllConnections();
    await new Promise<void>((r) => listener.close(() => r()));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-mcp-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const resourceList = await client.listResources();
  const workflowResource = resourceList.resources.find(
      (resource) => resource.uri === 'voxshop://agent/workflow',
    ),
    skillResource = resourceList.resources.find((resource) => resource.uri === 'voxshop://engine/skill'),
    findingsResource = resourceList.resources.find(
      (resource) => resource.uri === 'voxshop://engine/findings',
    );
  assert.ok(workflowResource, 'The connected agent should discover the shared authoring workflow.');
  assert.ok(skillResource, 'The connected agent should discover the shared engine skill.');
  assert.ok(findingsResource, 'The connected agent should discover verified engine findings.');
  const workflow = await client.readResource({ uri: workflowResource.uri }),
    skill = await client.readResource({ uri: skillResource.uri }),
    findings = await client.readResource({ uri: findingsResource.uri });
  const resourceText = (contents: Array<{ text: string } | { blob: string }>) =>
    contents.map((content) => ('text' in content ? content.text : '')).join('\n');
  assert.match(resourceText(workflow.contents), /tools\/list/);
  assert.match(resourceText(skill.contents), /tools\/list/);
  assert.match(resourceText(findings.contents), /alpha limits/);
  assert.match(resourceText(findings.contents), /heightfields/);
  const call = async (name: string, args: any = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return r.structuredContent as any;
  };
  const wait = async (job: any) => {
    for (let i = 0; i < 100; i++) {
      const state = await call('job_status', { jobId: job.id });
      if (state.status === 'completed') return state.result;
      if (state.status === 'failed' || state.status === 'cancelled')
        throw new Error(state.error ?? state.status);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Job did not finish.');
  };
  const tools = await client.listTools();
  const projectApplyTool = tools.tools.find((tool) => tool.name === 'project_apply');
  const assetGenerateTool = tools.tools.find((tool) => tool.name === 'asset_generate');
  const assetInspectTool = tools.tools.find((tool) => tool.name === 'asset_inspect');
  const exampleCreateTool = tools.tools.find((tool) => tool.name === 'example_create');
  const projectInspectTool = tools.tools.find((tool) => tool.name === 'project_inspect');
  const playtestTool = tools.tools.find((tool) => tool.name === 'playtest_run');
  const viewportObserveTool = tools.tools.find((tool) => tool.name === 'viewport_observe');
  const projectSaveTool = tools.tools.find((tool) => tool.name === 'project_save');
  const gameBuildTool = tools.tools.find((tool) => tool.name === 'game_build');
  const multiplayerListTool = tools.tools.find((tool) => tool.name === 'multiplayer_room_list');
  const multiplayerCreateTool = tools.tools.find((tool) => tool.name === 'multiplayer_room_create');
  const multiplayerDeleteTool = tools.tools.find((tool) => tool.name === 'multiplayer_room_delete');
  assert.ok(projectApplyTool);
  assert.ok(assetGenerateTool);
  assert.ok(assetInspectTool);
  assert.ok(exampleCreateTool);
  assert.ok(projectInspectTool);
  assert.ok(playtestTool);
  assert.ok(viewportObserveTool);
  assert.match(viewportObserveTool.description ?? '', /shape casts/);
  assert.match(JSON.stringify(viewportObserveTool.inputSchema), /shape-cast/);
  assert.ok(projectSaveTool);
  assert.ok(gameBuildTool);
  assert.ok(multiplayerListTool);
  assert.ok(multiplayerCreateTool);
  assert.ok(multiplayerDeleteTool);
  assert.equal(multiplayerListTool.description, MCP_TOOL_DESCRIPTIONS.multiplayerRoomList);
  assert.equal(multiplayerCreateTool.description, MCP_TOOL_DESCRIPTIONS.multiplayerRoomCreate);
  assert.equal(multiplayerDeleteTool.description, MCP_TOOL_DESCRIPTIONS.multiplayerRoomDelete);
  assert.match(JSON.stringify(multiplayerCreateTool.inputSchema), /128/);
  assert.match(JSON.stringify(multiplayerCreateTool.inputSchema), /projectBinding/);
  const emptyRooms = await call('multiplayer_room_list');
  assert.deepEqual(emptyRooms.rooms, []);
  let multiplayerProject = await service.store.create('MCP multiplayer game', 'mcp-multiplayer');
  const multiplayerPlayer = nodeSchema.parse({
    id: 'player',
    name: 'Player',
    transform: {},
    components: [
      { type: 'player', style: 'top-down', speed: 3 },
      { type: 'health', maximum: 100 },
    ],
  });
  multiplayerProject = (
    await service.store.commit(multiplayerProject.id, {
      expectedRevision: multiplayerProject.revision,
      requestId: 'add-multiplayer-player',
      operations: [
        { type: 'scene.put', scene: { ...multiplayerProject.scenes[0], nodes: [multiplayerPlayer] } },
      ],
    })
  ).project;
  const projectBinding = {
    projectId: multiplayerProject.id,
    revision: multiplayerProject.revision,
    sceneId: multiplayerProject.activeSceneId,
  };
  const createdRoom = await call('multiplayer_room_create', { maxPlayers: 2, projectBinding });
  assert.equal(createdRoom.maxPlayers, 2);
  assert.deepEqual(createdRoom.projectBinding, projectBinding);
  assert.equal(createdRoom.websocketUrl, multiplayerUrl);
  assert.match(createdRoom.credential, /^[A-Za-z0-9_-]{43}$/);
  multiplayerClient = new MultiplayerClient({
    websocketUrl: createdRoom.websocketUrl,
    gameId: createdRoom.gameId,
    credential: createdRoom.credential,
  });
  const connectedPlayer = await multiplayerClient.connect();
  assert.equal(multiplayerClient.playerId, connectedPlayer.playerId);
  const listedRooms = await call('multiplayer_room_list');
  assert.deepEqual(listedRooms.rooms, [
    {
      gameId: createdRoom.gameId,
      projectBinding,
      maxPlayers: 2,
      playerCount: 1,
      reservedPlayerCount: 0,
    },
  ]);
  assert.equal(JSON.stringify(listedRooms).includes(createdRoom.credential), false);
  const roomClosed = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Room deletion did not notify its connected player.')),
      1000,
    );
    const stop = multiplayerClient!.onMessage((message) => {
      if (message.type !== 'error') return;
      clearTimeout(timer);
      stop();
      resolve(message.code);
    });
  });
  assert.deepEqual(await call('multiplayer_room_delete', { gameId: createdRoom.gameId }), { ok: true });
  assert.equal(await roomClosed, 'unknown-room');
  for (let attempt = 0; attempt < 100 && multiplayerClient.playerId; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(multiplayerClient.playerId, undefined);
  assert.equal(multiplayerClient.connectionState, 'disconnected');
  assert.deepEqual((await call('multiplayer_room_list')).rooms, []);
  assert.equal(projectInspectTool.description, MCP_TOOL_DESCRIPTIONS.projectInspect);
  assert.ok((projectInspectTool.description?.length ?? Infinity) < 200);
  assert.match(projectInspectTool.description ?? '', /tools\/list/);
  assert.match(projectInspectTool.description ?? '', /revision/);
  assert.match(JSON.stringify(viewportObserveTool.inputSchema), /shape-cast/);
  const projectInspectSchema = JSON.stringify(projectInspectTool.inputSchema);
  assert.match(projectInspectSchema, /takes precedence over compact/);
  assert.match(projectInspectSchema, /without voxel arrays/);
  assert.equal(projectApplyTool.description, MCP_TOOL_DESCRIPTIONS.projectApply);
  assert.ok((projectApplyTool.description?.length ?? Infinity) < 180);
  assert.match(projectApplyTool.description ?? '', /expectedRevision/);
  assert.match(projectApplyTool.description ?? '', /unique requestId/);
  assert.match(projectApplyTool.description ?? '', /returned appliedRevision.*re-inspect before iterating/);
  const projectApplySchema = JSON.stringify(projectApplyTool.inputSchema);
  assert.ok(projectApplySchema.includes('node.fit-attachment'));
  assert.match(projectApplySchema, /socket-local meter-space rest-pose fitBounds/);
  assert.ok(projectApplySchema.includes('maxItems'));
  assert.ok(projectApplySchema.includes('objectives'));
  assert.match(projectApplySchema, /unique-ID progress goals/);
  assert.ok(projectApplySchema.includes('lighting'));
  assert.match(projectApplySchema, /omission preserves renderer defaults/);
  assert.match(projectApplySchema, /Logical terrain-cell coordinate/);
  assert.match(projectApplySchema, /Meters per terrain cell/);
  assert.match(projectApplySchema, /Meters per asset voxel/);
  assert.match(projectApplySchema, /asset\.animation-preset/);
  assert.match(projectApplySchema, /editable idle, walk, run, jump, attack, or wave clip/);
  assert.match(projectApplySchema, /unique new ID per stored prefab node/);
  assert.match(projectApplySchema, /Current project revision/);
  assert.match(playtestTool.description ?? '', /objective completion by stable objective ID/);
  assert.match(playtestTool.description ?? '', /simulation, not visual rendering/);
  assert.ok(JSON.stringify(playtestTool.inputSchema).includes('objectiveId'));
  assert.equal(assetGenerateTool.description, MCP_TOOL_DESCRIPTIONS.assetGenerate);
  assert.ok((assetGenerateTool.description?.length ?? Infinity) < 140);
  assert.equal(assetInspectTool.description, MCP_TOOL_DESCRIPTIONS.assetInspect);
  assert.match(JSON.stringify(assetGenerateTool.inputSchema), /Meters per asset voxel/);
  assert.match(JSON.stringify(assetGenerateTool.inputSchema), /not valid for terrain/);
  assert.match(viewportObserveTool.description ?? '', /actual open editor viewport as PNG/);
  assert.match(viewportObserveTool.description ?? '', /bounded step/);
  assert.ok(JSON.stringify(viewportObserveTool.inputSchema).includes('uiTab'));
  assert.match(projectSaveTool.description ?? '', /portable .*snapshot/);
  assert.match(gameBuildTool.description ?? '', /self-contained HTML game/);
  const hostedMcpSource = await fs.readFile(path.join(process.cwd(), 'hosting/sites/mcp.ts'), 'utf8');
  assert.ok(hostedMcpSource.includes('value.assets && value.scenes && !a.full && !a.compact'));
  assert.ok(hostedMcpSource.includes("'asset_inspect',"));
  assert.ok(hostedMcpSource.includes('offset: z.number().int().nonnegative().default(0)'));
  assert.ok(hostedMcpSource.includes('limit: z.number().int().min(0).max(2000).default(0)'));
  assert.ok(hostedMcpSource.includes("if (name === 'project_inspect' && a.compact && !a.full)"));
  assert.ok(hostedMcpSource.includes('assetInspectionView(project, a.assetId, a.offset, a.limit)'));
  assert.deepEqual((exampleCreateTool.inputSchema as any).properties.kind.enum, [...exampleKinds]);
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('world.update'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('rigid-body'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('bodyType'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('shape'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('craft'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('spawn'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('untouch'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('collision'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('separation'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('$other'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('recipes'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('weight'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('prefab.instantiate'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('Euler XYZ rotation in radians'));
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('Optional positive per-axis scale'));
  assert.ok(
    JSON.stringify(projectApplyTool.inputSchema).includes(
      'One to eight variable or inventory-count comparisons',
    ),
  );
  assert.ok(JSON.stringify(projectApplyTool.inputSchema).includes('Use all to require every comparison'));
  assert.match(projectApplyTool.description ?? '', /prefab\.instantiate remaps references/);
  assert.ok(tools.tools.some((t) => t.name === 'viewport_observe'));
  assert.deepEqual((await call('viewport_clients')).clients, []);
  await call('project_create', { id: 'mcp-equipment-fit', name: 'MCP equipment fit' });
  const fitBody = assetSchema.parse({
      id: 'fit-body',
      name: 'Fit body',
      model: createModelDocument([
        { x: 0, y: 0, z: 0, color: 0xffffff, bone: 'root', weights: [{ bone: 'root', weight: 1 }] },
      ]),
      rig: {
        profile: 'humanoid',
        version: 1,
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          { name: 'hand', parent: 'root', position: [0, 1, 0] },
        ],
        landmarks: {},
        sockets: [
          {
            name: 'hand',
            joint: 'hand',
            transform: {},
            fitBounds: { min: [-0.15, -0.1, -0.1], max: [0.45, 0.3, 0.1] },
          },
        ],
        clips: [],
      },
    }),
    fitGear = assetSchema.parse({
      id: 'fit-gear',
      name: 'Fit gear',
      voxelSize: 0.1,
      model: createModelDocument([
        { x: 0, y: 0, z: 0, color: 0x885533, bone: 'gear-root', weights: [{ bone: 'gear-root', weight: 1 }] },
        { x: 2, y: 0, z: 0, color: 0x885533, bone: 'gear-root', weights: [{ bone: 'gear-root', weight: 1 }] },
      ]),
      rig: {
        profile: 'humanoid',
        version: 1,
        joints: [{ name: 'gear-root', parent: null, position: [0, 0, 0] }],
        sockets: [],
        clips: [],
      },
    });
  await call('project_apply', {
    projectId: 'mcp-equipment-fit',
    expectedRevision: 0,
    requestId: 'author-fit-equipment',
    operations: [
      { type: 'asset.put', asset: fitBody },
      { type: 'asset.put', asset: fitGear },
      {
        type: 'node.put',
        sceneId: 'main',
        node: {
          id: 'fit-wearer',
          name: 'Fit wearer',
          assetId: fitBody.id,
          parentId: null,
          transform: identityTransform(),
          enabled: true,
          components: [],
          attachments: [
            {
              assetId: fitGear.id,
              socket: 'hand',
              slot: 'custom',
              transform: identityTransform(),
              hiddenBones: [],
            },
          ],
        },
      },
    ],
  });
  await call('project_apply', {
    projectId: 'mcp-equipment-fit',
    expectedRevision: 1,
    requestId: 'fit-equipment',
    operations: [{ type: 'node.fit-attachment', sceneId: 'main', nodeId: 'fit-wearer', slot: 'custom' }],
  });
  const savedFit = await new ProjectStore(path.join(dataDir, 'projects')).read('mcp-equipment-fit');
  assert.deepEqual(
    savedFit.assets.find((asset) => asset.id === fitBody.id)?.rig?.sockets[0].fitBounds,
    fitBody.rig?.sockets[0].fitBounds,
  );
  assert.deepEqual(savedFit.scenes[0].nodes[0].attachments[0].transform.scale, [2, 2, 2]);
  await call('project_undo', {
    projectId: 'mcp-equipment-fit',
    expectedRevision: 2,
    requestId: 'undo-equipment-fit',
  });
  const undoneFit = await call('project_inspect', { projectId: 'mcp-equipment-fit', full: true });
  assert.deepEqual(undoneFit.scenes[0].nodes[0].attachments[0].transform, identityTransform());
  await call('project_redo', {
    projectId: 'mcp-equipment-fit',
    expectedRevision: 3,
    requestId: 'redo-equipment-fit',
  });
  const redoneFit = await call('project_inspect', { projectId: 'mcp-equipment-fit', full: true });
  assert.deepEqual(redoneFit.scenes[0].nodes[0].attachments[0].transform.scale, [2, 2, 2]);
  await call('project_apply', {
    projectId: 'mcp-equipment-fit',
    expectedRevision: 4,
    requestId: 'add-wave-motion',
    operations: [{ type: 'asset.animation-preset', assetId: fitBody.id, preset: 'wave' }],
  });
  const waveRig = (
    await new ProjectStore(path.join(dataDir, 'projects')).read('mcp-equipment-fit')
  ).assets.find((asset) => asset.id === fitBody.id)!.rig!;
  assert.equal(waveRig.clips[0].name, 'wave');
  assert.deepEqual(
    waveRig.clips[0].tracks.map((track) => track.joint),
    ['root', 'hand'],
  );
  await call('project_create', { id: 'mcp-counterpart', name: 'MCP collision counterpart' });
  await call('project_apply', {
    projectId: 'mcp-counterpart',
    expectedRevision: 0,
    requestId: 'author-counterpart-rule',
    operations: [
      {
        type: 'node.put',
        sceneId: 'main',
        node: {
          id: 'trigger',
          name: 'Trigger',
          transform: {},
          components: [
            {
              type: 'rules',
              apiVersion: 1,
              rules: [{ event: 'collision', actions: [{ type: 'damage', target: '$other', amount: 10 }] }],
            },
          ],
        },
      },
    ],
  });
  const counterpartProject = await call('project_inspect', { projectId: 'mcp-counterpart', full: true });
  assert.equal(counterpartProject.scenes[0].nodes[0].components[0].rules[0].actions[0].target, '$other');
  await call('project_create', { id: 'mcp-lighting', name: 'MCP scene lighting' });
  await call('project_apply', {
    projectId: 'mcp-lighting',
    expectedRevision: 0,
    requestId: 'author-scene-lighting',
    operations: [
      {
        type: 'scene.put',
        scene: {
          id: 'main',
          name: 'Main',
          lighting: {
            hemisphere: { intensity: 0.75 },
            directional: { color: 0xffcc88, intensity: 1.5, position: [6, 12, -3], castShadow: false },
          },
        },
      },
    ],
  });
  const lightingProject = await call('project_inspect', { projectId: 'mcp-lighting', full: true });
  assert.deepEqual(lightingProject.scenes[0].lighting, {
    hemisphere: { skyColor: 0xc5e3ff, groundColor: 0x334025, intensity: 0.75 },
    directional: { color: 0xffcc88, intensity: 1.5, position: [6, 12, -3], castShadow: false },
  });
  await call('project_create', { id: 'mcp-prefabs', name: 'MCP prefab authoring' });
  await call('project_apply', {
    projectId: 'mcp-prefabs',
    expectedRevision: 0,
    requestId: 'save-prefab',
    operations: [
      {
        type: 'prefab.put',
        prefab: {
          id: 'crate-prefab',
          name: 'Crate',
          rootId: 'crate',
          nodes: [{ id: 'crate', name: 'Crate', transform: {} }],
        },
      },
    ],
  });
  await call('project_apply', {
    projectId: 'mcp-prefabs',
    expectedRevision: 1,
    requestId: 'place-prefab',
    operations: [
      {
        type: 'prefab.instantiate',
        prefabId: 'crate-prefab',
        sceneId: 'main',
        nodeIds: ['crate-copy'],
      },
    ],
  });
  const prefabProject = await call('project_inspect', { projectId: 'mcp-prefabs', full: true });
  assert.equal(prefabProject.scenes[0].nodes[0].id, 'crate-copy');
  assert.equal(prefabProject.prefabs[0].id, 'crate-prefab');
  await call('project_create', { id: 'mcp-physics', name: 'MCP physics authoring' });
  await call('project_apply', {
    projectId: 'mcp-physics',
    expectedRevision: 0,
    requestId: 'register-rigid-body',
    operations: [
      {
        type: 'node.put',
        sceneId: 'main',
        node: {
          id: 'falling-prop',
          name: 'Falling prop',
          transform: { position: [0, 4, 0] },
          components: [
            {
              type: 'collider',
              shape: 'sphere',
              size: [1, 1, 1],
              offset: [0, 0.5, 0],
              solid: true,
              friction: 0.8,
              restitution: 0.1,
            },
            {
              type: 'rigid-body',
              bodyType: 'dynamic',
              mass: 2,
              gravity: 9.8,
              linearDamping: 0.3,
              angularDamping: 0.4,
              restitution: 0.65,
              velocity: [1, 2, 3],
              angularVelocity: [0, 0.5, 0],
              ccd: true,
              canSleep: false,
            },
            { type: 'collectible', variable: 'score', amount: 1 },
          ],
        },
      },
    ],
  });
  let physicsProject = await call('project_inspect', { projectId: 'mcp-physics', full: true });
  const physicsComponents = physicsProject.scenes[0].nodes[0].components;
  assert.deepEqual(
    physicsComponents.map((component: any) => component.type),
    ['collider', 'rigid-body', 'collectible'],
  );
  assert.equal(physicsComponents[1].gravity, 9.8);
  assert.equal(physicsComponents[0].shape, 'sphere');
  assert.equal(physicsComponents[0].friction, 0.8);
  assert.equal(physicsComponents[1].bodyType, 'dynamic');
  assert.equal(physicsComponents[1].mass, 2);
  assert.equal(physicsComponents[1].angularDamping, 0.4);
  assert.deepEqual(physicsComponents[1].angularVelocity, [0, 0.5, 0]);
  assert.equal(physicsComponents[1].ccd, true);
  assert.equal(physicsComponents[1].canSleep, false);
  assert.deepEqual(physicsComponents[1].velocity, [1, 2, 3]);
  const physicsSave = await call('project_save', { projectId: 'mcp-physics' });
  assert.deepEqual(
    JSON.parse(await fs.readFile(physicsSave.path, 'utf8')).scenes[0].nodes[0].components,
    physicsComponents,
  );
  await call('project_undo', {
    projectId: 'mcp-physics',
    expectedRevision: 1,
    requestId: 'undo-rigid-body',
  });
  assert.equal(
    (await call('project_inspect', { projectId: 'mcp-physics', full: true })).scenes[0].nodes.length,
    0,
  );
  await call('project_redo', {
    projectId: 'mcp-physics',
    expectedRevision: 2,
    requestId: 'redo-rigid-body',
  });
  physicsProject = await call('project_inspect', { projectId: 'mcp-physics', full: true });
  assert.deepEqual(physicsProject.scenes[0].nodes[0].components, physicsComponents);
  await call('project_create', { id: 'mcp-inventory', name: 'MCP inventory authoring' });
  await call('project_apply', {
    projectId: 'mcp-inventory',
    expectedRevision: 0,
    requestId: 'author-inventory-and-recipe',
    operations: [
      {
        type: 'scene.put',
        scene: {
          id: 'main',
          name: 'Main',
          variables: { crafted: 0 },
          items: [
            { id: 'wood', name: 'Wood', maxStack: 20 },
            { id: 'plank', name: 'Plank', maxStack: 20 },
          ],
          recipes: [
            {
              id: 'make-plank',
              name: 'Make plank',
              ingredients: [{ itemId: 'wood', quantity: 2 }],
              outputs: [{ itemId: 'plank', quantity: 1 }],
            },
          ],
          nodes: [
            {
              id: 'player',
              name: 'Player',
              transform: {},
              components: [
                { type: 'player', style: 'top-down', speed: 3 },
                { type: 'inventory', slots: 12 },
                {
                  type: 'rules',
                  apiVersion: 1,
                  rules: [
                    {
                      event: 'start',
                      once: true,
                      actions: [{ type: 'inventory', add: [{ itemId: 'wood', quantity: 2 }] }],
                    },
                  ],
                },
              ],
            },
            {
              id: 'bench',
              name: 'Crafting bench',
              transform: {},
              components: [
                {
                  type: 'rules',
                  apiVersion: 1,
                  rules: [
                    {
                      event: 'interact',
                      once: true,
                      conditionGroup: {
                        mode: 'all',
                        conditions: [
                          { itemId: 'wood', op: '>=', value: 2 },
                          { itemId: 'plank', op: '==', value: 0 },
                        ],
                      },
                      actions: [
                        { type: 'craft', recipeId: 'make-plank' },
                        { type: 'add', variable: 'crafted', value: 1 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const inventoryProject = await call('project_inspect', { projectId: 'mcp-inventory', full: true });
  assert.equal(inventoryProject.scenes[0].recipes[0].id, 'make-plank');
  assert.deepEqual(
    inventoryProject.scenes[0].nodes[0].components.map((component: any) => component.type),
    ['player', 'inventory', 'rules'],
  );
  const benchRules = inventoryProject.scenes[0].nodes[1].components.find(
    (component: any) => component.type === 'rules',
  );
  assert.equal(benchRules.rules[0].conditionGroup.mode, 'all');
  assert.equal(benchRules.rules[0].conditionGroup.conditions.length, 2);
  const inventorySave = await call('project_save', { projectId: 'mcp-inventory' });
  assert.equal(JSON.parse(await fs.readFile(inventorySave.path, 'utf8')).scenes[0].items[0].id, 'wood');
  const inventoryReport = await wait(
    await call('playtest_run', {
      projectId: 'mcp-inventory',
      sceneId: 'main',
      steps: [{ frames: 1, input: { interact: true } }],
      assertions: [
        { type: 'inventory', itemId: 'wood', equals: 0 },
        { type: 'inventory', itemId: 'plank', equals: 1 },
        { type: 'variable', name: 'crafted', minimum: 1 },
        { type: 'no-errors' },
      ],
    }),
  );
  assert.equal(inventoryReport.passed, true, JSON.stringify(inventoryReport));
  const construction = constructionProject(
    {
      palette: [
        { id: 'grass', name: 'Grass', color: 0x55aa44, materialType: 'STANDARD' },
        { id: 'lamp', name: 'Lamp', color: 0xffcc88, materialType: 'EMISSIVE' },
      ],
    },
    { id: 'mcp-build-controls' },
  );
  await call('project_create', { id: construction.id, name: construction.name });
  await call('project_apply', {
    projectId: construction.id,
    expectedRevision: 0,
    requestId: 'author-construction',
    operations: [
      { type: 'world.create', ...construction.worlds[0] },
      { type: 'scene.put', scene: construction.scenes[0] },
    ],
  });
  const block = { x: 2, y: 4, z: 0, value: { color: 0x55aa44, materialType: 'STANDARD' } };
  const constructionReport = await wait(
    await call('playtest_run', {
      projectId: construction.id,
      sceneId: 'main',
      steps: [
        { frames: 1, input: { constructionPaint: 'lamp' }, terrainEdit: block },
        { frames: 1, terrainEdit: { ...block, value: null } },
        { frames: 1, terrainEdit: { ...block, x: 3 } },
      ],
      assertions: [
        { type: 'construction-paint', equals: 'lamp' },
        { type: 'terrain-cell', ...block, value: null },
        { type: 'terrain-cell', ...block, x: 3 },
        { type: 'inventory', itemId: 'stone', equals: 1 },
        { type: 'no-errors' },
      ],
    }),
  );
  assert.equal(constructionReport.passed, true, JSON.stringify(constructionReport.assertions));
  const constructionSaved = await call('project_save', { projectId: construction.id });
  const savedConstruction = JSON.parse(await fs.readFile(constructionSaved.path, 'utf8'));
  const constructionBuild = await wait(
    await call('game_build', { projectId: construction.id, sceneId: 'main' }),
  );
  const constructionHtml = await fs.readFile(constructionBuild.path, 'utf8');
  const exportedConstruction = JSON.parse(
    constructionHtml.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
  );
  assert.deepEqual(
    exportedConstruction.scenes[0].nodes[0].components.find(
      (component: any) => component.type === 'construction',
    ),
    savedConstruction.scenes[0].nodes[0].components.find(
      (component: any) => component.type === 'construction',
    ),
  );
  await call('project_create', { id: 'mcp-heal', name: 'MCP healing authoring' });
  await call('project_apply', {
    projectId: 'mcp-heal',
    expectedRevision: 0,
    requestId: 'author-heal-rule',
    operations: [
      {
        type: 'scene.put',
        scene: {
          id: 'main',
          name: 'Main',
          nodes: [
            {
              id: 'player',
              name: 'Player',
              transform: {},
              components: [
                { type: 'player', style: 'top-down', speed: 3 },
                { type: 'health', maximum: 100 },
              ],
            },
            {
              id: 'spring',
              name: 'Healing spring',
              transform: {},
              components: [
                {
                  type: 'rules',
                  apiVersion: 1,
                  rules: [{ event: 'interact', actions: [{ type: 'heal', target: 'player', amount: 15 }] }],
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const healingProject = await call('project_inspect', { projectId: 'mcp-heal', full: true });
  assert.deepEqual(healingProject.scenes[0].nodes[1].components[0].rules[0].actions[0], {
    type: 'heal',
    target: 'player',
    amount: 15,
  });
  await call('project_create', { id: 'mcp-game', name: 'MCP game' });
  const job = await call('asset_generate', {
    projectId: 'mcp-game',
    expectedRevision: 0,
    requestId: 'generate-one',
    id: 'original',
    name: 'Original prop',
    voxelSize: 0.25,
    recipe: {
      version: 1,
      shapes: [
        { kind: 'ellipsoid', center: [0, 3, 0], size: [5, 6, 5], color: 0x55aaff },
        { kind: 'ramp', center: [8, 3, 0], size: [5, 5, 5], color: 0x4488cc },
      ],
    },
  });
  await wait(job);
  let inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'original' });
  assert.equal(inspected.voxelSize, 0.25);
  const generatedVoxelCount = inspected.count;
  await call('project_apply', {
    projectId: 'mcp-game',
    expectedRevision: 1,
    requestId: 'character-one',
    operations: [
      {
        type: 'asset.character',
        id: 'character',
        name: 'Custom scale character',
        profile: 'biped',
        voxelSize: 0.4,
      },
    ],
  });
  inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'character', limit: 2000 });
  assert.equal(inspected.voxelSize, 0.4);
  assert.ok(inspected.count > 0);
  assert.ok(inspected.rig.joints.length > 1);
  const characterVoxel = inspected.voxels[0];
  const originalCharacterBone = characterVoxel.bone;
  const originalCharacterWeights = structuredClone(characterVoxel.weights ?? []);
  assert.equal(
    (await call('asset_inspect', { projectId: 'mcp-game', assetId: 'original' })).count,
    generatedVoxelCount,
  );
  const preview = await client.callTool({
    name: 'preview_capture',
    arguments: { projectId: 'mcp-game', assetId: 'original' },
  });
  assert.notEqual(preview.isError, true, JSON.stringify(preview));
  const img = (preview as any).content[0];
  assert.equal(img.type, 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.equal(Buffer.from(img.data, 'base64').subarray(1, 4).toString(), 'PNG');
  await call('project_apply', {
    projectId: 'mcp-game',
    expectedRevision: 2,
    requestId: 'paint-one',
    operations: [
      {
        type: 'asset.edit',
        id: 'original',
        edit: { mode: 'paint', targets: [{ x: 0, y: 3, z: 0 }], color: 0 },
      },
      {
        type: 'asset.edit',
        id: 'character',
        edit: {
          mode: 'weight',
          targets: [{ x: characterVoxel.x, y: characterVoxel.y, z: characterVoxel.z }],
          weights: [
            { bone: inspected.rig.joints[0].name, weight: 0.75 },
            { bone: inspected.rig.joints[1].name, weight: 0.25 },
          ],
        },
      },
    ],
  });
  inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'original', limit: 2000 });
  assert.equal(inspected.voxels.find((v: any) => v.x === 0 && v.y === 3 && v.z === 0).color, 0);
  inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'character', limit: 2000 });
  const weightedVoxel = inspected.voxels.find(
    (v: any) => v.x === characterVoxel.x && v.y === characterVoxel.y && v.z === characterVoxel.z,
  );
  assert.deepEqual(weightedVoxel.weights, [
    { bone: inspected.rig.joints[0].name, weight: 0.75 },
    { bone: inspected.rig.joints[1].name, weight: 0.25 },
  ]);
  assert.equal(weightedVoxel.bone, inspected.rig.joints[0].name);
  await call('project_undo', { projectId: 'mcp-game', expectedRevision: 3, requestId: 'undo-one' });
  inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'original', limit: 2000 });
  assert.equal(inspected.voxels.find((v: any) => v.x === 0 && v.y === 3 && v.z === 0).color, 0x55aaff);
  inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'character', limit: 2000 });
  const restoredCharacterVoxel = inspected.voxels.find(
    (v: any) => v.x === characterVoxel.x && v.y === characterVoxel.y && v.z === characterVoxel.z,
  );
  assert.equal(restoredCharacterVoxel.bone, originalCharacterBone);
  assert.deepEqual(restoredCharacterVoxel.weights ?? [], originalCharacterWeights);
  assert.equal((await call('asset_inspect', { projectId: 'mcp-game', assetId: 'character' })).voxelSize, 0.4);
  const saved = await call('project_save', { projectId: 'mcp-game' });
  const exported = JSON.parse(await fs.readFile(saved.path, 'utf8'));
  assert.equal(exported.revision, 4);
  assert.equal(exported.assets.length, 2);
  assert.equal(exported.assets.find((asset: any) => asset.id === 'original').voxelSize, 0.25);
  assert.equal(exported.assets.find((asset: any) => asset.id === 'character').voxelSize, 0.4);
  const authoringView = await call('project_inspect', {
    projectId: 'mcp-game',
    compact: true,
  });
  assert.equal(
    authoringView.assets.find((asset: any) => asset.id === 'original').modelSummary.voxelCount,
    generatedVoxelCount,
  );
  assert.equal(authoringView.assets.find((asset: any) => asset.id === 'original').model, undefined);
  assert.equal(authoringView.editorDraft, undefined);
  const portableDocument = await call('project_inspect', {
    projectId: 'mcp-game',
    full: true,
    compact: true,
  });
  assert.equal(
    portableDocument.assets.find((asset: any) => asset.id === 'original').model.voxels.length,
    generatedVoxelCount,
  );
  const firstVoxelPage = await call('asset_inspect', {
    projectId: 'mcp-game',
    assetId: 'original',
    limit: 2,
  });
  assert.deepEqual(
    firstVoxelPage,
    assetInspectionView(
      await call('project_inspect', { projectId: 'mcp-game', full: true }),
      'original',
      0,
      2,
    ),
  );
  assert.equal(firstVoxelPage.voxels.length, 2);
  assert.equal(firstVoxelPage.nextOffset, 2);
  const fakeEditor = new AbortController();
  const stream = await fetch(url + '/api/events?clientId=fixture-editor', {
    headers: { 'X-VoxShop-Token': service.token },
    signal: fakeEditor.signal,
  });
  const reader = stream.body!.getReader();
  await reader.read();
  const visualRequest = client.callTool({
    name: 'viewport_observe',
    arguments: { projectId: 'mcp-game', expectedRevision: 4, command: { type: 'capture' } },
  });
  let text = '',
    visualCommand: any;
  while (!visualCommand) {
    text += new TextDecoder().decode((await reader.read()).value);
    const message = text.match(/event: viewport\ndata: (.+)\n/);
    if (message) visualCommand = JSON.parse(message[1]);
  }
  // This is a transport fixture, not a substitute for inspecting a real rendered frame.
  const fixturePNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
  const delivered = await fetch(url + '/api/viewport/result', {
    method: 'POST',
    headers: { 'X-VoxShop-Token': service.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...visualCommand,
      revision: 4,
      image: 'data:image/png;base64,' + fixturePNG,
      observation: { fixture: true },
    }),
  });
  assert.equal(delivered.status, 200);
  const observed = await visualRequest;
  assert.equal(observed.isError, undefined);
  assert.ok(
    (observed.content as Array<{ type: string; data?: string }>).some(
      (part) => part.type === 'image' && part.data === fixturePNG,
    ),
  );
  fakeEditor.abort();
  await reader.cancel().catch(() => {});
  const reopened = await call('project_inspect', {
    projectId: 'mcp-game',
    full: true,
  });
  assert.deepEqual(reopened, exported);
  const worldCreated = await call('project_apply', {
    projectId: 'mcp-game',
    expectedRevision: 4,
    requestId: 'create-world',
    operations: [
      {
        type: 'world.create',
        id: 'island',
        name: 'Island',
        seed: 42,
        chunkSize: 16,
        voxelSize: 0.5,
        generator: {
          type: 'terrain',
          version: 1,
          origin: [0, 0],
          size: [32, 32],
          minY: 0,
          maxY: 12,
          baseHeight: 5,
          amplitude: 8,
          noise: 0.4,
          palette: {
            surface: 0x62964b,
            subsurface: 0x725439,
            deep: 0x686b70,
            surfaceDepth: 2,
            subsurfaceDepth: 3,
            materialType: 'STANDARD',
          },
        },
      },
    ],
  });
  assert.equal(worldCreated.appliedRevision, 5);
  assert.equal(worldCreated.worlds[0].voxelSize, 0.5);
  const worldEdited = await call('project_apply', {
    projectId: 'mcp-game',
    expectedRevision: 5,
    requestId: 'edit-world',
    operations: [
      {
        type: 'world.edit',
        worldId: 'island',
        edits: [
          { x: 4, y: 2, z: 8, value: null },
          { x: 7, y: 7, z: 8, value: { color: 0xffffff, materialType: 'EMISSIVE' } },
        ],
      },
    ],
  });
  assert.equal(worldEdited.appliedRevision, 6);
  assert.equal(worldEdited.worlds[0].edits, 2);
  const invalidWorldUpdate = await client.callTool({
    name: 'project_apply',
    arguments: {
      projectId: 'mcp-game',
      expectedRevision: 6,
      requestId: 'invalid-world-update',
      operations: [{ type: 'world.update', worldId: 'island', generator: { maxY: 4 } }],
    },
  });
  assert.equal(invalidWorldUpdate.isError, true);
  assert.equal((await call('project_inspect', { projectId: 'mcp-game', full: true })).revision, 6);
  const worldUpdated = await call('project_apply', {
    projectId: 'mcp-game',
    expectedRevision: 6,
    requestId: 'update-world',
    operations: [
      {
        type: 'world.update',
        worldId: 'island',
        name: 'Updated island',
        seed: 84,
        chunkSize: 8,
        voxelSize: 0.25,
        generator: { amplitude: 12, landformScale: 96, palette: { surface: 0x445566 } },
      },
    ],
  });
  assert.equal(worldUpdated.appliedRevision, 7);
  assert.equal(worldUpdated.worlds[0].name, 'Updated island');
  assert.equal(worldUpdated.worlds[0].voxelSize, 0.25);
  assert.equal(worldUpdated.worlds[0].edits, 2);
  let worldDocument = (await call('project_inspect', { projectId: 'mcp-game', full: true })).worlds[0];
  assert.equal(worldDocument.generator.landformScale, 96);
  assert.equal(worldDocument.generator.noise, 0.4);
  assert.equal(worldDocument.generator.palette.surface, 0x445566);
  assert.equal(worldDocument.seed, 84);
  assert.equal(worldDocument.chunkSize, 8);
  assert.equal(worldDocument.edits.length, 2);
  const undoneWorldUpdate = await call('project_undo', {
    projectId: 'mcp-game',
    expectedRevision: 7,
    requestId: 'undo-world-update',
  });
  assert.equal(undoneWorldUpdate.worlds[0].name, 'Island');
  assert.equal(undoneWorldUpdate.worlds[0].voxelSize, 0.5);
  worldDocument = (await call('project_inspect', { projectId: 'mcp-game', full: true })).worlds[0];
  assert.equal(worldDocument.generator.landformScale, undefined);
  assert.equal(worldDocument.seed, 42);
  assert.equal(worldDocument.chunkSize, 16);
  assert.equal(worldDocument.edits.length, 2);
  const redoneWorldUpdate = await call('project_redo', {
    projectId: 'mcp-game',
    expectedRevision: 8,
    requestId: 'redo-world-update',
  });
  assert.equal(redoneWorldUpdate.worlds[0].name, 'Updated island');
  assert.equal(redoneWorldUpdate.worlds[0].voxelSize, 0.25);
  const revertedWorldUpdate = await call('project_undo', {
    projectId: 'mcp-game',
    expectedRevision: 9,
    requestId: 'undo-world',
  });
  assert.equal(revertedWorldUpdate.worlds[0].edits, 2);
  const undoneWorldEdits = await call('project_undo', {
    projectId: 'mcp-game',
    expectedRevision: 10,
    requestId: 'undo-world-edits',
  });
  assert.equal(undoneWorldEdits.worlds[0].edits, 0);
  const undoneWorldCreation = await call('project_undo', {
    projectId: 'mcp-game',
    expectedRevision: 11,
    requestId: 'undo-world-create',
  });
  assert.deepEqual(undoneWorldCreation.worlds, []);
  const redoneWorldCreation = await call('project_redo', {
    projectId: 'mcp-game',
    expectedRevision: 12,
    requestId: 'redo-world-create',
  });
  assert.equal(redoneWorldCreation.worlds[0].edits, 0);
  const redoneWorldEdits = await call('project_redo', {
    projectId: 'mcp-game',
    expectedRevision: 13,
    requestId: 'redo-world-edits',
  });
  assert.equal(redoneWorldEdits.worlds[0].edits, 2);
  const redoneWorld = await call('project_redo', {
    projectId: 'mcp-game',
    expectedRevision: 14,
    requestId: 'redo-world-update-again',
  });
  assert.equal(redoneWorld.worlds[0].name, 'Updated island');
  assert.equal(redoneWorld.worlds[0].edits, 2);
  const worldSave = await call('project_save', { projectId: 'mcp-game' });
  const persistedWorld = JSON.parse(await fs.readFile(worldSave.path, 'utf8'));
  assert.equal(persistedWorld.revision, 15);
  assert.equal(persistedWorld.worlds[0].name, 'Updated island');
  assert.equal(persistedWorld.worlds[0].voxelSize, 0.25);
  assert.equal(persistedWorld.worlds[0].generator.landformScale, 96);
  assert.equal(persistedWorld.worlds[0].edits.length, 2);
  assert.deepEqual(await call('project_inspect', { projectId: 'mcp-game', full: true }), persistedWorld);
  for (const kind of exampleKinds) {
    const example = await call('example_create', { kind, id: `mcp-${kind}` });
    assert.equal(example.id, `mcp-${kind}`);
    const report = await wait(await call('playtest_run', { projectId: example.id, ...exampleTests[kind] }));
    assert.equal(report.passed, true, JSON.stringify(report));
    if (kind === 'survival') {
      assert.deepEqual(report.state.inventory, [
        { itemId: 'campfire-kit', quantity: 1, name: 'Campfire kit' },
      ]);
      assert.ok(report.state.events.some((event: any) => event.type === 'crafted'));
    }
    const built = await wait(await call('game_build', { projectId: example.id, sceneId: 'main' }));
    assert.equal(built.projectId, example.id);
    assert.ok((await fs.stat(built.path)).size > 500000);
    const download = await fetch(`${url}/api/games/${built.filename}`, {
      headers: { 'X-VoxShop-Token': service.token },
    });
    assert.equal(download.status, 200, 'Games in the hidden workspace must be downloadable.');
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await download.arrayBuffer()))
        .digest('hex'),
      built.sha256,
    );
    assert.equal((await fetch(`${url}/api/games/${built.filename}`)).status, 401);
  }
  assert.equal((await fetch(url + '/api/projects')).status, 401);
  assert.equal(
    (await fetch(url + '/api/session', { headers: { Origin: 'https://evil.example' } })).status,
    403,
  );
  const rebinding = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(url + '/api/session', { headers: { Host: 'evil.example' } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(rebinding, 403);
  assert.equal(
    (
      await fetch(url + '/api/proxy', {
        method: 'POST',
        headers: { 'X-VoxShop-Token': service.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'http://169.254.169.254/metadata' }),
      })
    ).status,
    403,
  );
  const conflict = await client.callTool({
    name: 'project_apply',
    arguments: {
      projectId: 'mcp-game',
      expectedRevision: 0,
      requestId: 'stale-write',
      operations: [{ type: 'project.rename', name: 'Stale' }],
    },
  });
  assert.equal(conflict.isError, true);
  const accessPath = path.join(dataDir, 'access.json');
  const savedAccess = await fs.readFile(accessPath);
  try {
    const access = JSON.parse(savedAccess.toString());
    await fs.writeFile(accessPath, JSON.stringify({ ...access, url: 'http://127.0.0.1:0' }));
    const unavailable = await client.callTool({ name: 'project_list', arguments: {} });
    assert.equal(unavailable.isError, true);
    assert.match(
      JSON.stringify(unavailable),
      /Could not reach the local VoxShop broker at http:\/\/127\.0\.0\.1/,
    );
    assert.match(JSON.stringify(unavailable), /Check that the local editor service is running/);
  } finally {
    await fs.writeFile(accessPath, savedAccess);
  }
  assert.equal(stderr, '');
});
