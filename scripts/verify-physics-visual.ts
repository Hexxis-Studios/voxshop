import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION } from '../services/appMetadata';
import { createTerrainSurfaceSampler } from '../services/terrainNoise';

const [mode, directory, firstArg, secondArg] = process.argv.slice(2);
if (!['seed', 'capture', 'export'].includes(mode ?? '') || !directory)
  throw Error(
    'Usage: tsx scripts/verify-physics-visual.ts seed <stable-data-dir> [seed] | capture <stable-data-dir> [editor-origin] [project-id] | export <stable-data-dir> <project-id>',
  );
const dataDir = path.resolve(directory);
const output = path.join(dataDir, 'physics-visual-evidence');
await fs.access(path.join(dataDir, 'access.json')).catch(() => {
  throw Error(`No access.json in ${dataDir}; pass the connected disposable editor data directory.`);
});
await fs.mkdir(output, { recursive: true });

const client = new Client({ name: 'voxshop-physics-visual-check', version: APP_VERSION });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'mcp/server.ts'],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), VOXSHOP_DATA_DIR: dataDir },
    stderr: 'pipe',
  }),
);
const toolSchemas = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool.inputSchema]));
const requireFields = (name: string, fields: string[]) => {
  const properties = (toolSchemas.get(name) as any)?.properties;
  assert.ok(properties, `The connected VoxShop adapter did not expose an input schema for ${name}.`);
  for (const field of fields) assert.ok(field in properties, `${name} input schema is missing ${field}.`);
};
requireFields('project_create', ['id', 'name']);
requireFields('project_apply', ['projectId', 'expectedRevision', 'requestId', 'operations']);
requireFields('project_inspect', ['projectId', 'full']);
requireFields('project_activate', ['projectId']);
requireFields('project_save', ['projectId']);
requireFields('game_build', ['projectId', 'sceneId']);
requireFields('job_status', ['jobId']);
requireFields('viewport_clients', []);
requireFields('viewport_observe', ['projectId', 'expectedRevision', 'clientId', 'command']);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  assert.ok(toolSchemas.has(name), `The connected VoxShop adapter does not expose ${name}.`);
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent as any;
};
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;
const isVector3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((component) => typeof component === 'number' && Number.isFinite(component));
const nodePosition = (state: any, nodeId: string): [number, number, number] => {
  const position: unknown = state?.state?.nodes?.find((node: any) => node.id === nodeId)?.position;
  assert.ok(isVector3(position), `Missing finite runtime position for ${nodeId}.`);
  return position;
};

try {
  if (mode === 'export') {
    const projectId = firstArg;
    assert.ok(projectId, 'Export mode requires a project ID from the seeded fixture.');
    const fixture = JSON.parse(await fs.readFile(path.join(output, `fixture-${projectId}.json`), 'utf8'));
    const project = await call('project_inspect', { projectId, full: true });
    const scene = project.scenes.find((entry: any) => entry.id === fixture.sceneId);
    assert.ok(scene, `Fixture scene ${fixture.sceneId} is missing.`);
    const build = await call('game_build', { projectId, sceneId: scene.id });
    let status = await call('job_status', { jobId: build.id });
    for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(status.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await call('job_status', { jobId: build.id });
    }
    assert.equal(status.status, 'completed', status.error);
    const reportPath = path.join(output, `report-${projectId}.json`);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    report.standaloneBuild = status.result;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ projectId, sceneId: scene.id, standaloneBuild: status.result }));
  } else if (mode === 'seed') {
    const seed = Number(firstArg ?? 817);
    assert.ok(
      Number.isInteger(seed) && seed >= -2147483648 && seed <= 2147483647,
      'Seed must be a signed 32-bit integer.',
    );
    const voxelSize = 0.5;
    const generator = {
      type: 'terrain',
      version: 1,
      mode: 'heightfield',
      origin: [-64, -64],
      size: [128, 128],
      minY: 0,
      maxY: 31,
      baseHeight: 14,
      amplitude: 5,
      noise: 0.55,
      landformScale: 24,
      palette: {
        surface: 0x67935a,
        subsurface: 0x766049,
        deep: 0x55585e,
        surfaceDepth: 3,
        subsurfaceDepth: 6,
        materialType: 'STANDARD',
      },
    };
    const world = { seed, voxelSize, generator };
    const surfaceAt = createTerrainSurfaceSampler(world);
    const route = (() => {
      let best: { x: number; z: number; rise: number; score: number } | null = null;
      for (let x = -16; x <= 16; x++)
        for (let z = -48; z <= 48; z++) {
          const heights = Array.from({ length: 13 }, (_, step) => surfaceAt(x, z - step));
          const rise = heights.at(-1)! - heights[0]!;
          const largestStep = Math.max(
            ...heights.slice(1).map((height, i) => Math.abs(height - heights[i]!)),
          );
          if (Math.abs(rise) < 2 || largestStep > 1) continue;
          const score = Math.abs(Math.abs(rise) - 3) + largestStep * 0.1;
          if (!best || score < best.score) best = { x, z, rise, score };
        }
      assert.ok(best, 'This seed has no bounded 6 meter walkable heightfield grade; choose another seed.');
      return best;
    })();
    const nav = (() => {
      let best: { x: number; z: number; spread: number } | null = null;
      for (let x = -48; x <= -36; x++)
        for (let z = -20; z <= 20; z++) {
          const heights: number[] = [];
          for (let dx = -8; dx <= 8; dx++)
            for (let dz = -12; dz <= 12; dz++) heights.push(surfaceAt(x + dx, z + dz));
          const spread = Math.max(...heights) - Math.min(...heights);
          if (!best || spread < best.spread) best = { x, z, spread };
        }
      assert.ok(best, 'Could not choose a bounded enemy navigation area.');
      return best;
    })();
    const project = await call('project_create', {
      id: id('physics-acceptance'),
      name: 'Physics and navigation acceptance',
    });
    const current = await call('project_inspect', { projectId: project.id, full: true });
    const cellY = (x: number, z: number) => (surfaceAt(x, z) + 0.5) * voxelSize;
    const platformX = 48;
    const platformZ = 0;
    const platformCenterY = cellY(platformX, platformZ) + 2.5;
    const navX = nav.x * voxelSize;
    const navZ = nav.z * voxelSize;
    const player = {
      id: 'player',
      name: 'Trail tester',
      assetId: 'trail-tester',
      parentId: null,
      enabled: true,
      transform: {
        position: [route.x * voxelSize, cellY(route.x, route.z) + 8, route.z * voxelSize],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      components: [
        { type: 'player', style: 'third-person', speed: 3, jump: 6 },
        {
          type: 'collider',
          shape: 'capsule',
          size: [0.7, 1.7, 0.7],
          offset: [0, 0.85, 0],
          solid: true,
          friction: 0.8,
        },
        { type: 'health', maximum: 100 },
        { type: 'animation', idle: 'idle', moving: 'walk' },
      ],
      attachments: [],
    };
    const enemy = {
      id: 'enemy',
      name: 'Navigation tester',
      assetId: 'navigation-tester',
      parentId: null,
      enabled: true,
      transform: {
        position: [navX, cellY(nav.x, nav.z - 8), navZ - 4],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      components: [
        { type: 'enemy', speed: 2, damage: 1, range: 0.3 },
        { type: 'collider', size: [0.8, 1, 0.6], offset: [0, 0.5, 0], solid: true },
        { type: 'animation', idle: 'idle', moving: 'walk' },
      ],
      attachments: [],
    };
    const nodes = [
      player,
      enemy,
      {
        id: 'platform-root',
        name: 'Platform parent transform',
        assetId: null,
        parentId: null,
        enabled: true,
        transform: {
          position: [platformX * voxelSize, 0, platformZ * voxelSize],
          rotation: [0, 0.24, 0],
          scale: [1, 1, 1],
        },
        components: [],
        attachments: [],
      },
      {
        id: 'rotation-platform',
        name: 'Rotating carry platform',
        assetId: 'carry-platform',
        parentId: 'platform-root',
        enabled: true,
        transform: { position: [0, platformCenterY, 0], rotation: [0.08, 0, 0], scale: [1, 1, 1] },
        components: [
          { type: 'collider', size: [4, 0.5, 4], solid: true, friction: 1 },
          {
            type: 'rigid-body',
            bodyType: 'kinematic-velocity',
            gravity: 0,
            linearDamping: 0,
            angularDamping: 0,
            velocity: [0, 0, 0],
            angularVelocity: [0, 0.55, 0],
            canSleep: false,
          },
        ],
        attachments: [],
      },
      {
        id: 'navigation-wall',
        name: 'Wall for enemy route',
        assetId: 'navigation-wall',
        parentId: null,
        enabled: true,
        transform: { position: [navX, cellY(nav.x, nav.z), navZ], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ type: 'collider', size: [3, 3, 1], offset: [0, 1.5, 0], solid: true }],
        attachments: [],
      },
    ];
    const operations = [
      {
        type: 'asset.character',
        id: 'trail-tester',
        name: 'Trail tester',
        profile: 'biped',
        height: 18,
        width: 8,
        color: 0xd17e38,
        accent: 0xf1d4a8,
      },
      {
        type: 'asset.character',
        id: 'navigation-tester',
        name: 'Navigation tester',
        profile: 'machine',
        height: 18,
        width: 10,
        color: 0xb94c4c,
        accent: 0xe4bd72,
      },
      {
        type: 'asset.generate',
        id: 'carry-platform',
        name: 'Rotating platform',
        voxelSize: 0.25,
        recipe: {
          version: 1,
          seed,
          shapes: [
            { kind: 'box', center: [0, 0, 0], size: [16, 2, 16], color: 0x527f96, material: 'METALLIC' },
          ],
        },
      },
      {
        type: 'asset.generate',
        id: 'navigation-wall',
        name: 'Navigation wall',
        voxelSize: 0.25,
        recipe: {
          version: 1,
          seed: seed ^ 0x5a17,
          shapes: [
            { kind: 'box', center: [0, 6, 0], size: [12, 12, 4], color: 0x8c7051, material: 'STANDARD' },
          ],
        },
      },
      {
        type: 'world.create',
        id: 'physics-world',
        name: 'Seeded rolling ground',
        seed,
        chunkSize: 16,
        voxelSize,
        generator,
      },
      {
        type: 'scene.put',
        scene: {
          ...current.scenes[0],
          id: 'main',
          name: 'Physics acceptance course',
          worldId: 'physics-world',
          bounds: 64,
          background: 0xa9c7db,
          groundColor: 0x586b4d,
          instructions:
            'Walk the seeded grade, jump, ride the rotating platform, and watch the enemy route around the wall.',
          nodes,
        },
      },
    ];
    const applied = await call('project_apply', {
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: id('seed-physics'),
      label: 'Seed bounded physics acceptance course',
      operations,
    });
    const metadata = {
      createdAt: new Date().toISOString(),
      projectId: project.id,
      revision: applied.revision ?? applied.appliedRevision,
      seed,
      sceneId: 'main',
      worldId: 'physics-world',
      voxelSize,
      route: {
        startCell: [route.x, route.z],
        endCell: [route.x, route.z - 12],
        expectedRiseCells: route.rise,
        lengthMeters: 6,
      },
      platform: {
        worldPosition: [platformX * voxelSize, platformCenterY, platformZ * voxelSize],
        parentRotationY: 0.24,
        localTiltX: 0.08,
        angularVelocityY: 0.55,
      },
      navigation: {
        wallCell: [nav.x, nav.z],
        wallWorldPosition: [navX, cellY(nav.x, nav.z), navZ],
        groundHeightSpreadCells: nav.spread,
        enemyCollider: { size: [0.8, 1, 0.6], offset: [0, 0.5, 0] },
        platformRigidBodyRemovedForNavigation: true,
      },
      evidenceDirectory: output,
    };
    await fs.writeFile(
      path.join(output, `fixture-${project.id}.json`),
      JSON.stringify(metadata, null, 2) + '\n',
    );
    console.log(JSON.stringify({ mode, ...metadata }));
  } else {
    const requestedOrigin = firstArg;
    const requestedProjectId = secondArg;
    const fixture = requestedProjectId
      ? JSON.parse(await fs.readFile(path.join(output, `fixture-${requestedProjectId}.json`), 'utf8'))
      : await (async () => {
          const files = (await fs.readdir(output)).filter((file) => /^fixture-.*\.json$/.test(file));
          assert.ok(files.length, `No fixture metadata in ${output}; run seed first.`);
          const newest = (
            await Promise.all(
              files.map(async (file) => ({ file, mtime: (await fs.stat(path.join(output, file))).mtimeMs })),
            )
          ).sort((a, b) => b.mtime - a.mtime)[0]!;
          return JSON.parse(await fs.readFile(path.join(output, newest.file), 'utf8'));
        })();
    const project = await call('project_inspect', { projectId: fixture.projectId, full: true });
    await call('project_activate', { projectId: fixture.projectId });
    const world = project.worlds.find((entry: any) => entry.id === fixture.worldId);
    assert.ok(world, `Fixture world ${fixture.worldId} is missing.`);
    const surfaceAt = createTerrainSurfaceSampler({
      seed: fixture.seed,
      voxelSize: fixture.voxelSize,
      generator: world.generator,
    });
    let editor: any;
    for (let attempt = 0; attempt < 40; attempt++) {
      const editors = (await call('viewport_clients')).clients as Array<{ id: string; origin: string }>;
      editor = requestedOrigin
        ? editors.filter((candidate) => candidate.origin === requestedOrigin).at(-1)
        : editors.length === 1
          ? editors[0]
          : null;
      if (editor) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(
      editor,
      'Open the seeded disposable editor in the browser and pass its exact origin if needed.',
    );
    let revision = project.revision;
    const screenshots: Array<{ label: string; path: string; observation: unknown }> = [];
    const observe = async (label: string, command: unknown) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await client.callTool({
          name: 'viewport_observe',
          arguments: {
            projectId: fixture.projectId,
            expectedRevision: revision,
            clientId: editor.id,
            command,
          },
        });
        if (
          response.isError &&
          /does not match|still opening|Project changed/.test(JSON.stringify(response))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        assert.notEqual(response.isError, true, JSON.stringify(response));
        const image = (response.content as any[]).find(
          (content) => content.type === 'image' && content.mimeType === 'image/png',
        );
        assert.ok(image?.data, 'The connected editor must return its real viewport PNG.');
        const file = path.join(output, `${fixture.projectId}-${label}.png`);
        await fs.writeFile(file, Buffer.from(image.data, 'base64'));
        const observation = (response.structuredContent as any).observation;
        assert.equal(observation.revision, revision);
        assert.ok(observation.width > 0 && observation.height > 0);
        screenshots.push({ label, path: file, observation });
        return observation;
      }
      throw Error('The editor did not finish loading the current fixture revision.');
    };
    const resetFixture = async (label = 'before-fixture-reset') => {
      await observe(label, { type: 'stop' });
      const current = await call('project_inspect', { projectId: fixture.projectId, full: true });
      const scene = current.scenes.find((entry: any) => entry.id === fixture.sceneId);
      assert.ok(scene, `Fixture scene ${fixture.sceneId} is missing.`);
      const getNode = (nodeId: string) => {
        const node = scene.nodes.find((entry: any) => entry.id === nodeId);
        assert.ok(node, `Fixture node ${nodeId} is missing.`);
        return node;
      };
      const startCell = fixture.route.startCell;
      const navCell = fixture.navigation.wallCell;
      const player = getNode('player');
      const enemy = getNode('enemy');
      const wall = getNode('navigation-wall');
      const root = getNode('platform-root');
      const platform = getNode('rotation-platform');
      const platformBody = {
        type: 'rigid-body',
        bodyType: 'kinematic-velocity',
        gravity: 0,
        linearDamping: 0,
        angularDamping: 0,
        velocity: [0, 0, 0],
        angularVelocity: [0, fixture.platform.angularVelocityY, 0],
        canSleep: false,
      };
      player.enabled = true;
      player.transform.position = [
        startCell[0] * fixture.voxelSize,
        (surfaceAt(startCell[0], startCell[1]) + 0.5) * fixture.voxelSize + 8,
        startCell[1] * fixture.voxelSize,
      ];
      enemy.enabled = true;
      enemy.transform.position = [
        fixture.navigation.wallWorldPosition[0],
        (surfaceAt(navCell[0], navCell[1] - 8) + 0.5) * fixture.voxelSize,
        fixture.navigation.wallWorldPosition[2] - 4,
      ];
      enemy.components = enemy.components.map((component: any) =>
        component.type === 'collider'
          ? { ...component, size: [0.8, 1, 0.6], offset: [0, 0.5, 0] }
          : component,
      );
      wall.transform.position = fixture.navigation.wallWorldPosition;
      root.enabled = true;
      root.transform.rotation = [0, fixture.platform.parentRotationY, 0];
      platform.enabled = true;
      platform.transform.position = [0, fixture.platform.worldPosition[1], 0];
      platform.transform.rotation = [fixture.platform.localTiltX, 0, 0];
      platform.components = [
        ...platform.components.filter((component: any) => component.type !== 'rigid-body'),
        platformBody,
      ];
      const reset = await call('project_apply', {
        projectId: fixture.projectId,
        expectedRevision: current.revision,
        requestId: id('reset-physics-fixture'),
        label: 'Reset bounded physics acceptance fixture',
        operations: [root, platform, player, enemy, wall].map((node: any) => ({
          type: 'node.put',
          sceneId: scene.id,
          node,
        })),
      });
      revision = reset.revision ?? reset.appliedRevision;
      assert.ok(Number.isInteger(revision), 'Fixture reset returned no revision.');
    };
    const reposition = async (nodeId: string, position: number[]) => {
      await observe(`before-reposition-${nodeId}`, { type: 'stop' });
      const current = await call('project_inspect', { projectId: fixture.projectId, full: true });
      const scene = current.scenes.find((entry: any) => entry.id === fixture.sceneId);
      const node = scene.nodes.find((entry: any) => entry.id === nodeId);
      assert.ok(node, `Fixture node ${nodeId} is missing.`);
      const updated = { ...node, transform: { ...node.transform, position } };
      const result = await call('project_apply', {
        projectId: fixture.projectId,
        expectedRevision: current.revision,
        requestId: id(`place-${nodeId}`),
        label: `Place ${nodeId} for next physics check`,
        operations: [{ type: 'node.put', sceneId: scene.id, node: updated }],
      });
      revision = result.revision ?? result.appliedRevision;
      assert.ok(Number.isInteger(revision), 'Project mutation returned no revision.');
    };

    await resetFixture();
    await observe('terrain-play-start', { type: 'play' });
    const landed = await observe('terrain-landed', { type: 'step', frames: 180, input: {} });
    assert.equal(landed.state.status, 'playing');
    assert.deepEqual(landed.state.errors, []);
    const landedPosition = nodePosition(landed, 'player');
    const terrainRay = await observe('terrain-contact-ray', {
      type: 'physics-query',
      queries: [
        {
          shape: 'ray',
          origin: [landedPosition[0], 40, landedPosition[2]],
          direction: [0, -1, 0],
          maxDistance: 50,
          excludeNodeIds: ['player', 'enemy'],
        },
      ],
    });
    const hit = terrainRay.physicsQueries?.[0]?.hit;
    assert.ok(
      terrainRay.physicsQueries?.[0]?.available && hit?.source === 'terrain',
      'A real Rapier ray must hit generated terrain under the player.',
    );
    assert.ok(
      Math.abs(landedPosition[1] - hit.position[1]) < 0.2,
      'The player capsule must settle on the queried terrain collision surface.',
    );
    const cellX = Math.round(landedPosition[0] / fixture.voxelSize);
    const cellZ = Math.round(landedPosition[2] / fixture.voxelSize);
    const blockTopY = (surfaceAt(cellX, cellZ) + 0.5) * fixture.voxelSize;
    const surfaceAlignment = {
      playerPosition: landedPosition,
      collisionRayPosition: hit.position,
      nearestRenderedVoxelColumn: [cellX, cellZ],
      renderedVoxelTopY: blockTopY,
      collisionMinusVoxelTopMeters: hit.position[1] - blockTopY,
      note: 'Compare the saved real viewport PNG with this ray hit and nearest stepped terrain-column top.',
    };
    const walk = await observe('terrain-walk-up-grade', { type: 'step', frames: 120, input: { moveZ: -1 } });
    const walkedPosition = nodePosition(walk, 'player');
    assert.ok(
      Math.hypot(walkedPosition[0] - landedPosition[0], walkedPosition[2] - landedPosition[2]) > 2.5,
      'Player input must move across the grade.',
    );
    assert.ok(
      Math.abs(walkedPosition[1] - landedPosition[1]) > 0.35,
      'The walk must change elevation on the seeded slope.',
    );
    const jumpBase = walkedPosition[1];
    await observe('jump-launch', { type: 'step', frames: 1, input: { jump: true } });
    const jump = await observe('jump-airborne', { type: 'step', frames: 22, input: {} });
    const jumpPosition = nodePosition(jump, 'player');
    assert.ok(jumpPosition[1] > jumpBase + 0.6, 'The player must rise after the jump input.');

    const platformX = fixture.platform.worldPosition[0];
    const platformTop = fixture.platform.worldPosition[1] + 0.25;
    const platformZ = fixture.platform.worldPosition[2] + 1;
    await reposition('player', [platformX, platformTop + 0.03, platformZ]);
    await observe('platform-play-start', { type: 'play' });
    await observe('platform-camera', {
      type: 'camera',
      position: [platformX + 7, platformTop + 5, platformZ + 7],
      target: [platformX, platformTop + 0.7, fixture.platform.worldPosition[2]],
    });
    const platformSettled = await observe('platform-rider-settled', { type: 'step', frames: 30, input: {} });
    const platformBefore = nodePosition(platformSettled, 'player');
    const carried = await observe('platform-rider-carried', { type: 'step', frames: 90, input: {} });
    const platformAfter = nodePosition(carried, 'player');
    const carryDistance = Math.hypot(
      platformAfter[0] - platformBefore[0],
      platformAfter[2] - platformBefore[2],
    );
    assert.ok(
      Math.abs(platformAfter[1] - platformTop) < 0.25,
      'The rider must remain supported at platform height.',
    );
    assert.ok(
      carryDistance > 0.3,
      `The rotating parented platform must carry its rider; horizontal displacement was ${carryDistance}.`,
    );

    await observe('before-navigation-stage', { type: 'stop' });
    const navWall = fixture.navigation.wallWorldPosition;
    const navPlayerY =
      (surfaceAt(
        Math.round(navWall[0] / fixture.voxelSize),
        Math.round((navWall[2] + 4) / fixture.voxelSize),
      ) +
        0.5) *
      fixture.voxelSize;
    const navEnemyY =
      (surfaceAt(
        Math.round(navWall[0] / fixture.voxelSize),
        Math.round((navWall[2] - 4) / fixture.voxelSize),
      ) +
        0.5) *
      fixture.voxelSize;
    const current = await call('project_inspect', { projectId: fixture.projectId, full: true });
    const scene = current.scenes.find((entry: any) => entry.id === fixture.sceneId);
    assert.ok(scene, `Fixture scene ${fixture.sceneId} is missing.`);
    const platformNode = scene.nodes.find((entry: any) => entry.id === 'rotation-platform');
    const playerNode = scene.nodes.find((entry: any) => entry.id === 'player');
    const enemyNode = scene.nodes.find((entry: any) => entry.id === 'enemy');
    assert.ok(platformNode && playerNode && enemyNode, 'The navigation stage is missing fixture nodes.');
    const staticPlatform = {
      ...platformNode,
      components: platformNode.components.filter((component: any) => component.type !== 'rigid-body'),
    };
    const navigationEnemy = {
      ...enemyNode,
      transform: { ...enemyNode.transform, position: [navWall[0], navEnemyY, navWall[2] - 4] },
      components: enemyNode.components.map((component: any) =>
        component.type === 'collider'
          ? { ...component, size: [0.8, 1, 0.6], offset: [0, 0.5, 0] }
          : component,
      ),
    };
    const navigationPlayer = {
      ...playerNode,
      transform: { ...playerNode.transform, position: [navWall[0], navPlayerY, navWall[2] + 4] },
    };
    const navSetup = await call('project_apply', {
      projectId: fixture.projectId,
      expectedRevision: current.revision,
      requestId: id('prepare-enemy-navigation'),
      label: 'Prepare bounded enemy route around the wall',
      operations: [
        { type: 'node.put', sceneId: scene.id, node: staticPlatform },
        { type: 'node.put', sceneId: scene.id, node: navigationEnemy },
        { type: 'node.put', sceneId: scene.id, node: navigationPlayer },
      ],
    });
    revision = navSetup.revision ?? navSetup.appliedRevision;
    assert.ok(Number.isInteger(revision), 'Navigation fixture setup returned no revision.');
    await observe('navigation-play-start', { type: 'play' });
    await observe('navigation-camera', {
      type: 'camera',
      position: [navWall[0] - 8, navWall[1] + 8, navWall[2] - 8],
      target: [navWall[0], navWall[1] + 1.5, navWall[2]],
    });
    const navigation = await observe('enemy-around-wall', { type: 'step', frames: 150, input: {} });
    const enemyPosition = nodePosition(navigation, 'enemy');
    assert.ok(
      Math.abs(enemyPosition[0] - navWall[0]) > 1.8,
      'The enemy route must go around an end of the wall.',
    );
    assert.deepEqual(navigation.state.errors, []);
    await observe('navigation-stopped', { type: 'stop' });
    const captureRevision = revision;
    await resetFixture('before-export-restore');
    await observe('portable-fixture-restored', { type: 'stop' });
    const portableProject = await call('project_save', { projectId: fixture.projectId });

    const report = {
      verifiedAt: new Date().toISOString(),
      source: 'Connected VoxShop editor viewport PNGs and bounded Play physics observations.',
      projectId: fixture.projectId,
      editorOrigin: editor.origin,
      revision: captureRevision,
      portableProject,
      finalProjectRevision: revision,
      screenshots,
      assertions: {
        terrainContactRay: hit,
        surfaceAlignment,
        walkedPosition: { from: landedPosition, to: walkedPosition },
        jumpPosition: { baseY: jumpBase, airborne: jumpPosition },
        platformCarry: { from: platformBefore, to: platformAfter, horizontalDistance: carryDistance },
        enemyNavigation: { wall: navWall, enemy: enemyPosition },
      },
      visualReviewPending: true,
    };
    const reportPath = path.join(output, `report-${fixture.projectId}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({
        report: reportPath,
        screenshots: screenshots.map((item) => item.path),
        assertions: report.assertions,
      }),
    );
  }
} finally {
  await client.close();
}
