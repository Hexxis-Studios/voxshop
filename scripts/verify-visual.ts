import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION } from '../services/appMetadata';
import { generateRecipe } from '../services/recipeGenerator';
import { TERRAIN_LOD_CELL_SIZE, TERRAIN_FAR_LOD_CELL_SIZE } from '../runtime/voxelGeometry';

if (!process.argv[2])
  throw Error(
    'Pass the data directory of an isolated running VoxShop editor, plus its origin if several editors are open.',
  );
const directory = path.resolve(process.argv[2]),
  output = path.join(directory, 'visual-evidence');
try {
  await fs.access(path.join(directory, 'access.json'));
} catch {
  throw Error(
    `No local access.json exists in ${directory}. Pass the data directory used by the connected VoxShop editor. The visual verifier creates and retains test projects in that workspace; use a disposable workspace to keep them out of your normal project list.`,
  );
}
await fs.mkdir(output, { recursive: true });
const client = new Client({ name: 'voxshop-visual-check', version: APP_VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'mcp/server.ts'],
  cwd: process.cwd(),
  env: { ...(process.env as Record<string, string>), VOXSHOP_DATA_DIR: directory },
  stderr: 'pipe',
});
const screenshots: any[] = [];
let firstPersonEvidence: Record<string, unknown> | null = null;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent as any;
};
try {
  await client.connect(transport);
  let editors = (await call('viewport_clients')).clients;
  for (
    let i = 0;
    i < 20 && !(process.argv[3] ? editors.some((e: any) => e.origin === process.argv[3]) : editors.length);
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    editors = (await call('viewport_clients')).clients;
  }
  const editor = process.argv[3]
    ? editors.filter((e: any) => e.origin === process.argv[3]).at(-1)
    : editors.length === 1
      ? editors[0]
      : null;
  if (!editor)
    throw Error('Open the matching local editor, or pass its origin to select one connected window.');
  const observer =
    (project: { id: string; revision: number }, kind: string) => async (label: string, command: unknown) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await client.callTool({
          name: 'viewport_observe',
          arguments: {
            projectId: project.id,
            expectedRevision: project.revision,
            clientId: editor.id,
            command,
          },
        });
        if (response.isError) {
          const error = JSON.stringify(response);
          if (/does not match|still opening|Project changed/.test(error)) {
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          throw Error(error);
        }
        const content = response.content as Array<{ type: string; mimeType?: string; data?: string }>;
        const image = content.find((c) => c.type === 'image' && c.mimeType === 'image/png');
        assert.ok(image?.data, 'The actual editor must return a rendered PNG.');
        const filename = path.join(output, `${kind}-${label}.png`);
        await fs.writeFile(filename, Buffer.from(image.data, 'base64'));
        const metadata = response.structuredContent as any;
        assert.equal(metadata.revision, project.revision);
        assert.ok(metadata.observation.width > 0 && metadata.observation.height > 0);
        screenshots.push({ kind, label, path: filename, ...metadata.observation });
        return metadata.observation;
      }
      throw Error('The editor did not load the activated project.');
    };
  for (const kind of ['exploration', 'arena', 'survival'] as const) {
    const project = await call('example_create', { kind, id: `visual-${kind}-${Date.now()}` });
    const observe = observer(project, kind);
    const p = await call('project_inspect', { projectId: project.id, full: true });
    const playerNode = p.scenes[0].nodes.find((n: any) => n.components.some((c: any) => c.type === 'player'));
    const position = playerNode.transform.position;
    if (kind === 'arena') {
      const firstPersonNode = {
        ...playerNode,
        components: playerNode.components.map((component: any) =>
          component.type === 'player'
            ? { ...component, style: 'first-person', cameraHeight: 1.6 }
            : component,
        ),
      };
      await call('project_apply', {
        projectId: project.id,
        expectedRevision: project.revision,
        requestId: 'first-person-camera',
        label: 'Set the arena player to first-person',
        operations: [{ type: 'node.put', sceneId: p.scenes[0].id, node: firstPersonNode }],
      });
      project.revision = (await call('project_inspect', { projectId: project.id, full: false })).revision;
      firstPersonEvidence = {
        projectId: project.id,
        revision: project.revision,
        style: 'first-person',
        cameraHeight: 1.6,
      };
    }
    await observe('authoring', { type: 'capture' });
    await observe('performance', { type: 'benchmark', frames: 120 });
    await observe('model-front', {
      type: 'camera',
      position: [position[0] + 1.5, position[1] + 2.5, position[2] - 4],
      target: [position[0], position[1] + 1, position[2]],
    });
    await observe('equipment-back', {
      type: 'camera',
      position: [position[0] + 1.5, position[1] + 2.5, position[2] + 4],
      target: [position[0], position[1] + 1, position[2]],
    });
    await observe('play-start', { type: 'play' });
    if (kind === 'arena') {
      const firstPerson = await observe('play-first-person-start', { type: 'capture' });
      firstPersonEvidence = { ...firstPersonEvidence, startState: firstPerson.state };
    }
    let last: any;
    if (kind === 'exploration') {
      for (const [index, frames] of [100, 100, 100, 130].entries())
        last = await observe(`walk-${index + 1}`, { type: 'step', frames, input: { moveZ: -1 } });
    } else if (kind === 'arena') {
      await observe('approach', { type: 'step', frames: 240, input: { moveZ: -1 } });
      for (const [index, repeats] of [22, 23].entries())
        await observe(`combat-${index + 1}`, {
          type: 'sequence',
          steps: Array.from({ length: repeats }, () => [
            { frames: 20, input: { attack: true } },
            { frames: 1, input: {} },
          ]).flat(),
        });
      last = await observe('exit', { type: 'step', frames: 220, input: { moveZ: -1 } });
    } else {
      const supplies = await observe('workbench-approach', {
        type: 'step',
        frames: 240,
        input: { moveZ: -1 },
      });
      assert.deepEqual(
        supplies.state.inventory.map((item: any) => [item.itemId, item.quantity]),
        [
          ['wood', 2],
          ['stone', 1],
        ],
      );
      await observe('workbench-interact', { type: 'step', frames: 1, input: { interact: true } });
      last = await observe('campfire-site', { type: 'step', frames: 160, input: { moveZ: -1 } });
      assert.deepEqual(
        last.state.inventory.map((item: any) => [item.itemId, item.quantity]),
        [['campfire-kit', 1]],
      );
      assert.ok(last.state.events.some((event: any) => event.type === 'crafted'));
    }
    assert.equal(last.state.status, 'won');
    assert.deepEqual(last.state.errors, []);
    const stopped = await observe('stopped', { type: 'stop' });
    assert.equal(stopped.state, null);
    assert.equal(
      (await call('project_inspect', { projectId: project.id, full: false })).revision,
      project.revision,
    );
  }
  const stress = await call('project_create', {
    id: `visual-instancing-${Date.now()}`,
    name: 'Instancing performance check',
  });
  const full = await call('project_inspect', { projectId: stress.id, full: true });
  const stressScene = {
    ...full.scenes[0],
    bounds: 100,
    nodes: Array.from({ length: 1000 }, (_, i) => ({
      id: `prop-${i}`,
      name: `Prop ${i}`,
      assetId: 'block',
      transform: { position: [(i % 32) * 2 - 31, 0, Math.floor(i / 32) * 2 - 31] },
    })),
  };
  const populated = await call('project_apply', {
    projectId: stress.id,
    expectedRevision: stress.revision,
    requestId: 'populate',
    label: 'Create 1,000 shared voxel props',
    operations: [
      {
        type: 'asset.generate',
        id: 'block',
        name: 'Shared block',
        voxelSize: 0.1,
        recipe: {
          version: 1,
          seed: 0,
          shapes: [{ kind: 'box', center: [0, 8, 0], size: [16, 16, 16], color: 0x69944e }],
        },
      },
      { type: 'scene.put', scene: stressScene },
    ],
  });
  const stressSnapshot = await call('project_inspect', { projectId: stress.id, full: true });
  assert.equal(stressSnapshot.scenes[0].nodes.length, 1000);
  assert.equal(stressSnapshot.assets.length, 1);
  const stressObserve = observer(populated, 'instancing');
  await stressObserve('overview', { type: 'camera', position: [50, 40, 50], target: [0, 0, 0] });
  const measured = await stressObserve('performance', { type: 'benchmark', frames: 120 });
  console.log('Instancing renderer metrics:', JSON.stringify(measured.render));
  assert.equal(measured.render.instances, 1000);
  assert.equal(measured.render.sharedAssets, 1);
  assert.ok(measured.render.batches <= 9);
  assert.ok(measured.render.geometries <= 3);
  const outside = await stressObserve('outside-frustum', {
    type: 'camera',
    position: [50, 40, 50],
    target: [200, 50, 200],
  });
  assert.ok(
    outside.render.triangles < measured.render.triangles,
    'Offscreen batches must be frustum culled.',
  );
  const terrain = await call('project_create', {
    id: `visual-mountain-lod-${Date.now()}`,
    name: 'Mountain LOD render check',
  });
  const terrainProject = await call('project_inspect', { projectId: terrain.id, full: true }),
    terrainScene = {
      ...terrainProject.scenes[0],
      bounds: 120,
      nodes: [
        {
          id: 'terrain-node',
          name: 'Generated terrain',
          assetId: 'terrain',
          transform: { position: [0, 0, 0] },
        },
      ],
    };
  const terrainRecipe = {
    version: 1,
    seed: 42,
    shapes: [
      {
        kind: 'terrain',
        center: [0, 28, 0],
        size: [64, 56, 64],
        color: 0x69944e,
        noise: 0.65,
        palette: {
          surface: 0x719b4c,
          subsurface: 0x725439,
          deep: 0x686b70,
          surfaceDepth: 1,
          subsurfaceDepth: 3,
        },
      },
    ],
  } as const;
  const generatedTerrain = generateRecipe(terrainRecipe);
  const populatedTerrain = await call('project_apply', {
    projectId: terrain.id,
    expectedRevision: terrain.revision,
    requestId: 'terrain-check',
    label: 'Create chunked procedural terrain',
    operations: [
      {
        type: 'asset.generate',
        id: 'terrain',
        name: '64 voxel mountain',
        voxelSize: 0.5,
        recipe: terrainRecipe,
      },
      { type: 'scene.put', scene: terrainScene },
    ],
  });
  const terrainSnapshot = await call('project_inspect', { projectId: terrain.id });
  const terrainVoxelCount = generatedTerrain.length;
  assert.equal(terrainSnapshot.assets[0].voxels, terrainVoxelCount);
  assert.equal(terrainSnapshot.scenes[0].nodes, 1);
  assert.ok(terrainVoxelCount > 4096);
  const elevation = generatedTerrain.reduce(
    ({ min, max }, voxel) => ({ min: Math.min(min, voxel.y), max: Math.max(max, voxel.y) }),
    { min: Infinity, max: -Infinity },
  );
  assert.ok(elevation.max - elevation.min > 32, 'The terrain sample must contain a broad mountain profile.');
  const terrainObserve = observer(populatedTerrain, 'chunk-terrain');
  const terrainView = await terrainObserve('overview', {
    type: 'camera',
    position: [25, 35, 25],
    target: [0, 10, 0],
  });
  assert.equal(terrainView.render.chunkedAssets, 1);
  assert.ok(terrainView.render.chunkMeshes > 1);
  assert.ok(terrainView.render.terrainLodMeshes > 0);
  assert.equal(terrainView.render.terrainLodTiers.fine, 1);
  // LOD follows projected voxel spacing, so fixed camera distances cease to test
  // the intended tiers when render height/DPR changes. Aim below the 1.8px entry band.
  const pixelsPerDepthUnit =
    terrainView.height / (2 * Math.tan((terrainView.camera.verticalFov * Math.PI) / 360));
  const lodCameraPosition = (spacing: number) => {
    const distance = (0.5 * (spacing - 1) * pixelsPerDepthUnit) / 1.6;
    return [distance / Math.SQRT2, 12, distance / Math.SQRT2];
  };
  const terrainDistance = await terrainObserve('medium-lod', {
    type: 'camera',
    position: lodCameraPosition(TERRAIN_LOD_CELL_SIZE),
    target: [0, 12, 0],
  });
  assert.equal(terrainDistance.render.terrainLods, 1);
  assert.ok(
    terrainDistance.render.triangles < terrainView.render.triangles,
    'Distant static terrain must use its coarser representation.',
  );
  const terrainFar = await terrainObserve('far-lod', {
    type: 'camera',
    position: lodCameraPosition(TERRAIN_FAR_LOD_CELL_SIZE),
    target: [0, 14, 0],
  });
  console.log(
    'Terrain LOD tiers:',
    JSON.stringify({
      overview: terrainView.render,
      medium: terrainDistance.render,
      far: { camera: terrainFar.camera, render: terrainFar.render },
    }),
  );
  assert.equal(terrainDistance.render.terrainLodTiers.medium, 1);
  assert.equal(terrainFar.render.terrainLodTiers.far, 1);
  assert.ok(
    terrainFar.render.triangles < terrainDistance.render.triangles,
    'Very distant static terrain must use its far representation.',
  );
  const terrainClose = await terrainObserve('close-up', {
    type: 'camera',
    position: [5, 25, 6],
    target: [2, 16, 2],
  });
  assert.equal(terrainClose.render.terrainLodTiers.fine, 1);
  assert.ok(
    terrainClose.render.triangles < terrainView.render.triangles && terrainClose.render.triangles > 2,
    'A close camera must render only the visible terrain chunks.',
  );
  const terrainBenchmark = await terrainObserve('performance', {
    type: 'benchmark',
    frames: 120,
  });
  console.log(
    'Chunk terrain renderer metrics:',
    JSON.stringify({ render: terrainBenchmark.render, benchmark: terrainBenchmark.benchmark }),
  );
  const terrainHidden = await terrainObserve('outside-frustum', {
    type: 'camera',
    position: [25, 35, 25],
    target: [100, 30, 100],
  });
  assert.ok(
    terrainHidden.render.triangles < terrainView.render.triangles,
    'The terrain mesh chunks must leave the frame when the camera turns away.',
  );
  const report = {
    verifiedAt: new Date().toISOString(),
    source: 'Actual connected local editor controlled through stdio MCP; no fixture images',
    editor,
    automationPassed: true,
    visualReviewPending: true,
    checks: {
      instancing: {
        visible: measured.render,
        benchmark: measured.benchmark,
        outsideFrustum: {
          drawCalls: outside.render.calls,
          triangles: outside.render.triangles,
        },
      },
      chunkedTerrain: {
        world: {
          width: 64,
          depth: 64,
          voxelSize: 0.5,
          nominalGridMeters: { width: 32, height: 28, depth: 32 },
          voxelCount: terrainVoxelCount,
          seed: 42,
          noise: 0.65,
          palette: {
            surface: 0x719b4c,
            subsurface: 0x725439,
            deep: 0x686b70,
            surfaceDepth: 1,
            subsurfaceDepth: 3,
          },
        },
        overview: {
          drawCalls: terrainView.render.calls,
          triangles: terrainView.render.triangles,
          chunks: terrainView.render.chunkMeshes,
          lodChunks: terrainView.render.terrainLodMeshes,
          activeLodTiers: terrainView.render.terrainLodTiers,
        },
        mediumLod: {
          camera: [60, 28, 60],
          target: [0, 12, 0],
          drawCalls: terrainDistance.render.calls,
          triangles: terrainDistance.render.triangles,
          activeLodTiers: terrainDistance.render.terrainLodTiers,
        },
        farLod: {
          camera: [100, 37, 100],
          target: [0, 14, 0],
          drawCalls: terrainFar.render.calls,
          triangles: terrainFar.render.triangles,
          activeLodTiers: terrainFar.render.terrainLodTiers,
        },
        closeUp: {
          drawCalls: terrainClose.render.calls,
          triangles: terrainClose.render.triangles,
          activeLodTiers: terrainClose.render.terrainLodTiers,
        },
        benchmark: terrainBenchmark.benchmark,
        outsideFrustum: {
          drawCalls: terrainHidden.render.calls,
          triangles: terrainHidden.render.triangles,
        },
      },
      firstPerson: firstPersonEvidence,
    },
    screenshots,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        automationPassed: true,
        visualReviewPending: true,
        report: path.join(output, 'report.json'),
        screenshots: screenshots.map((s) => s.path),
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
