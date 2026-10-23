import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION } from '../services/appMetadata';

// Uses only a disposable workspace, the public MCP contract, and actual connected renderer PNGs.
const directory = process.argv[2] && path.resolve(process.argv[2]);
if (!directory || !process.argv[3]) throw Error('Pass a disposable editor data directory and editor origin.');
await fs.access(path.join(directory, 'access.json'));
const output = path.join(directory, 'animation-evidence');
await fs.mkdir(output, { recursive: true });
const client = new Client({ name: 'voxshop-animation-acceptance', version: APP_VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'mcp/server.ts'],
  env: { ...(process.env as Record<string, string>), VOXSHOP_DATA_DIR: directory },
  cwd: process.cwd(),
  stderr: 'pipe',
});
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return result.structuredContent as any;
};
const captures: any[] = [],
  projects: any[] = [];
try {
  await client.connect(transport);
  const discovery = await client.listTools();
  for (const name of ['project_create', 'project_apply', 'viewport_observe', 'game_build'])
    assert.ok(discovery.tools.some((tool) => tool.name === name));
  let editor;
  for (let attempt = 0; attempt < 30 && !editor; attempt++) {
    editor = (await call('viewport_clients')).clients.find((entry: any) => entry.origin === process.argv[3]);
    if (!editor) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(editor, 'Open the disposable editor before running the visual acceptance.');
  for (const profile of ['biped', 'machine', 'quadruped']) {
    const project = await call('project_create', {
      id: `motion-${profile}-${Date.now()}`,
      name: `${profile} motion review`,
    });
    const clips = ['idle', 'walk', 'run', 'jump', 'attack', 'wave'];
    const full = await call('project_inspect', { projectId: project.id, full: true });
    const nodes = clips.map((clip, index) => ({
      id: `actor-${clip}`,
      name: clip,
      assetId: 'body',
      transform: { position: [(index % 3) * 3 - 3, 0, Math.floor(index / 3) * 4 - 2] },
      components: [{ type: 'animation', idle: clip, moving: 'walk' }],
      attachments: [
        { slot: 'back', socket: 'back', assetId: 'pack', transform: {} },
        { slot: 'body', socket: 'body', assetId: 'armor', transform: {}, hiddenBones: ['torso'] },
        ...(profile === 'quadruped'
          ? []
          : [{ slot: 'hand', socket: 'hand', assetId: 'blade', transform: {} }]),
      ],
    }));
    const applied = await call('project_apply', {
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: 'motion-fixture',
      label: 'All six editable starter motions with fitted equipment',
      operations: [
        { type: 'asset.character', id: 'body', name: `${profile} body`, profile, height: 18, width: 8 },
        ...['jump', 'attack', 'wave'].map((preset) => ({
          type: 'asset.animation-preset',
          assetId: 'body',
          preset,
          clipName: preset,
        })),
        { type: 'equipment.fit', bodyId: 'body', id: 'pack', name: 'Pack', kind: 'backpack' },
        { type: 'equipment.fit', bodyId: 'body', id: 'armor', name: 'Armor', kind: 'shell' },
        ...(profile === 'quadruped'
          ? []
          : [{ type: 'equipment.fit', bodyId: 'body', id: 'blade', name: 'Blade', kind: 'blade' }]),
        { type: 'scene.put', scene: { ...full.scenes[0], nodes, bounds: 20 } },
      ],
    });
    project.revision = applied.appliedRevision;
    const observe = async (label: string, command: unknown) => {
      // Activation and the editor's SSE project fetch race by a few frames; bounded retry only for that case.
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await client.callTool({
          name: 'viewport_observe',
          arguments: {
            projectId: project.id,
            expectedRevision: project.revision,
            clientId: editor.id,
            command,
          },
        });
        if (
          result.isError &&
          /still opening|does not match|Project changed/.test(JSON.stringify(result.content))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        const png = (result.content as any[]).find((item: any) => item.type === 'image');
        assert.ok(png?.data, 'Capture must come from the real renderer.');
        const file = `${profile}-${label}.png`;
        await fs.writeFile(path.join(output, file), Buffer.from(png.data, 'base64'));
        const observation = (result.structuredContent as any).observation;
        assert.deepEqual(observation.state?.errors ?? [], []);
        captures.push({ file, projectId: project.id, revision: project.revision, ...observation });
        return;
      }
      throw Error('The activated project did not finish loading.');
    };
    await observe('play', { type: 'play' });
    for (const [angle, position] of Object.entries({
      front: [0, 5, -13],
      side: [13, 5, 0],
      back: [0, 5, 13],
    })) {
      await observe(`${angle}-start`, { type: 'camera', position, target: [0, 0.9, 0] });
      await observe(`${angle}-pose`, { type: 'step', frames: 15, input: {} });
    }
    await observe('stop', { type: 'stop' });
    const job = await call('game_build', { projectId: project.id, sceneId: full.scenes[0].id });
    let result = await call('job_status', { jobId: job.id });
    while (result.status === 'queued' || result.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await call('job_status', { jobId: job.id });
    }
    assert.equal(result.status, 'completed', result.error);
    projects.push({
      id: project.id,
      name: project.name,
      revision: project.revision,
      profile,
      export: result.result,
    });
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ projects, captures, visualReviewPending: true }, null, 2),
  );
  console.log(
    JSON.stringify({ report: path.join(output, 'report.json'), projects, captures: captures.length }),
  );
} finally {
  await client.close();
}
