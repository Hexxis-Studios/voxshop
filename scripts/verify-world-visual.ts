import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION } from '../services/appMetadata';

const directory = process.argv[2];
if (!directory)
  throw Error('Pass an isolated running VoxShop editor data directory and, when needed, its exact origin.');
const dataDir = path.resolve(directory);
const requestedOrigin = process.argv[3];
const requestedProjectId = process.argv[4];
const output = path.join(dataDir, 'world-visual-evidence');
await fs.mkdir(output, { recursive: true });

const client = new Client({ name: 'voxshop-world-visual-check', version: APP_VERSION });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'mcp/server.ts'],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), VOXSHOP_DATA_DIR: dataDir },
    stderr: 'pipe',
  }),
);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent as any;
};
const screenshots: Array<{ label: string; path: string; observation: unknown }> = [];
try {
  const project = requestedProjectId
    ? await call('project_inspect', { projectId: requestedProjectId, full: true })
    : await (async () => {
        const created = await call('project_create', {
          id: `world-visual-${Date.now()}`,
          name: 'VoxShop terrain visual check',
        });
        return call('project_inspect', { projectId: created.id, full: true });
      })();
  await call('project_activate', { projectId: project.id });
  if (!requestedProjectId) {
    const scene = { ...project.scenes[0], worldId: 'mountain-world', bounds: 1000 };
    await call('project_apply', {
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: 'create-mountain-world',
      label: 'Create terrain for visual check',
      operations: [
        {
          type: 'world.create',
          id: 'mountain-world',
          name: 'High ridge',
          seed: 817,
          chunkSize: 16,
          voxelSize: 0.5,
          generator: {
            type: 'terrain',
            version: 1,
            mode: 'voxel3d',
            origin: [-512, -512],
            size: [1024, 1024],
            minY: 0,
            maxY: 127,
            baseHeight: 64,
            amplitude: 24,
            noise: 0.82,
            landformScale: 96,
            palette: {
              surface: 0x79a94e,
              subsurface: 0x806044,
              deep: 0x5e6269,
              surfaceDepth: 3,
              subsurfaceDepth: 6,
              materialType: 'STANDARD',
            },
            biomeField: {
              scale: 96,
              biomes: [
                {
                  id: 'grassland',
                  name: 'Grassland',
                  palette: {
                    surface: 0x38b34b,
                    subsurface: 0x806044,
                    deep: 0x5e6269,
                    surfaceDepth: 3,
                    subsurfaceDepth: 6,
                    materialType: 'STANDARD',
                  },
                },
                {
                  id: 'tundra',
                  name: 'Tundra',
                  palette: {
                    surface: 0x90dcf2,
                    subsurface: 0x817969,
                    deep: 0x526376,
                    surfaceDepth: 3,
                    subsurfaceDepth: 6,
                    materialType: 'STANDARD',
                  },
                },
                {
                  id: 'desert',
                  name: 'Desert',
                  palette: {
                    surface: 0xd2a85a,
                    subsurface: 0x986d43,
                    deep: 0x514b48,
                    surfaceDepth: 3,
                    subsurfaceDepth: 6,
                    materialType: 'STANDARD',
                  },
                },
                {
                  id: 'volcanic',
                  name: 'Volcanic',
                  palette: {
                    surface: 0xd34b32,
                    subsurface: 0x332c30,
                    deep: 0x171a20,
                    surfaceDepth: 3,
                    subsurfaceDepth: 6,
                    materialType: 'STANDARD',
                  },
                },
              ],
            },
          },
        },
        { type: 'scene.put', scene },
      ],
    });
  }
  let projectState = await call('project_inspect', { projectId: project.id, full: true });
  const activeScene = projectState.scenes.find(
    (candidate: any) => candidate.id === projectState.activeSceneId,
  );
  let world = projectState.worlds.find((candidate: any) => candidate.id === activeScene?.worldId);
  assert.ok(world, 'The active scene must select a terrain world before visual capture.');
  if (world.generator.landformScale !== 96) {
    await call('project_apply', {
      projectId: project.id,
      expectedRevision: projectState.revision,
      requestId: `set-landform-scale-${Date.now()}`,
      label: 'Set broad meter-scale terrain landforms',
      operations: [{ type: 'world.update', worldId: world.id, generator: { landformScale: 96 } }],
    });
    projectState = await call('project_inspect', { projectId: project.id, full: true });
    world = projectState.worlds.find((candidate: any) => candidate.id === activeScene?.worldId);
  }
  assert.equal(world?.generator.landformScale, 96, 'The terrain uses a 96 meter landform scale.');

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
    'Open this isolated editor in a new browser tab and pass its origin if multiple local editors are connected.',
  );

  const capture = async (label: string, command: unknown) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await client.callTool({
        name: 'viewport_observe',
        arguments: {
          projectId: project.id,
          expectedRevision: projectState.revision,
          clientId: editor.id,
          command,
        },
      });
      if (response.isError && /does not match|still opening|Project changed/.test(JSON.stringify(response))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const image = (response.content as any[]).find((content) => content.type === 'image');
      assert.ok(image?.data, 'The actual editor viewport must return a rendered PNG.');
      const filename = path.join(output, `${label}.png`);
      await fs.writeFile(filename, Buffer.from(image.data, 'base64'));
      const observation = (response.structuredContent as any).observation;
      screenshots.push({ label, path: filename, observation });
      return observation;
    }
    throw Error('The editor did not finish opening the terrain project.');
  };

  const nearCamera = {
    type: 'camera',
    position: [0, 54, 82],
    target: [0, 26, 0],
  };
  await capture('mountain-default-start', { type: 'stop' });
  const defaultWarmup = await capture('mountain-default-window', { type: 'benchmark', frames: 120 });
  await capture('mountain-default', { type: 'stop' });
  await capture('mountain-near-start', nearCamera);
  const warmed = await capture('mountain-resident-window', { type: 'benchmark', frames: 120 });
  // Tile creation is deliberately bounded to one mesh per update; take the visual after warmup.
  await capture('mountain-near', nearCamera);
  const entryCamera = { type: 'camera', position: [4, 35, 6], target: [0, 31, 0] };
  await capture('voxel-surface-entry-start', entryCamera);
  const entryWarmup = await capture('voxel-surface-entry-window', {
    type: 'benchmark',
    frames: 60,
  });
  await capture('voxel-surface-entry', entryCamera);
  const caveCamera = { type: 'camera', position: [2, 29, 0], target: [-2, 29.5, 0] };
  await capture('voxel-cave-interior-start', caveCamera);
  const caveWarmup = await capture('voxel-cave-interior-window', {
    type: 'benchmark',
    frames: 60,
  });
  await capture('voxel-cave-interior', caveCamera);
  const horizonCamera = {
    type: 'camera',
    position: [0, 40, -80],
    target: [0, 20, 100],
  };
  await capture('mountain-horizon-start', horizonCamera);
  const horizonWarmup = await capture('mountain-horizon-window', { type: 'benchmark', frames: 120 });
  await capture('mountain-horizon', horizonCamera);
  const settled = await capture('mountain-horizon-settled-window', {
    type: 'benchmark',
    frames: 120,
  });
  await capture('mountain-horizon-settled', { type: 'stop' });

  const report = {
    verifiedAt: new Date().toISOString(),
    source: 'Actual isolated production editor viewport through the local viewport bridge.',
    editorOrigin: editor.origin,
    projectId: project.id,
    terrainMode: world.generator.mode,
    voxelSizeMeters: 0.5,
    generatedExtentCells: world.generator.size,
    surfaceColumns: world.generator.size[0] * world.generator.size[1],
    biomeScaleMeters: world.generator.biomeField?.scale ?? null,
    biomePalettes: world.generator.biomeField?.biomes.map(({ id, name }) => ({ id, name })) ?? [],
    verticalCellBounds: [world.generator.minY, world.generator.maxY],
    maximumCellLatticeWithinBounds:
      world.generator.size[0] * world.generator.size[1] * (world.generator.maxY - world.generator.minY + 1),
    screenshots,
    defaultWarmedRender: defaultWarmup.render,
    warmedRender: warmed.render,
    entryWarmupRender: entryWarmup.render,
    caveWarmupRender: caveWarmup.render,
    horizonWarmedRender: horizonWarmup.render,
    benchmark: settled.benchmark,
    visualReviewPending: true,
    limitations: [
      'The finite 1,024×1,024 surface has about one million columns and a larger theoretical 3D cell lattice; only bounded streamed chunks are hydrated/rendered.',
      'Nearby terrain uses bounded 16³ voxel chunks. Distant surface tiles and sampled cave/overhang shells use coarser geometry; sub-cell details may disappear at distance.',
      'Voxel3d terrain collision samples generated occupancy and sparse edits. Explicit player shapes use Rapier when selected; legacy no-body scenes retain bounded AABB movement. See the physics acceptance fixture for rendered contact evidence.',
      'The generated cave is one finite seeded passage around the small surface shaft, not an unbounded cave network.',
      'This visual fixture is not a full-world or million-cell GPU benchmark.',
      'Animation-frame delivery includes rendering and browser scheduling; it is not a GPU timer.',
      'Sparse authored edits use the persisted world-chunk store and override generated occupancy.',
    ],
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), screenshots: screenshots.length }));
} finally {
  await client.close();
}
