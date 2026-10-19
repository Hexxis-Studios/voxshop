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
import { exampleTests } from '../services/examples';

test('external MCP client creates, generates, previews, edits, undoes, saves and reopens through the authenticated broker', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-mcp-'));
  const dataDir = path.join(directory, '.voxshop');
  const service = await createApp({ root: process.cwd(), dataDir, port: 0 });
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => listener.once('listening', r));
  const port = (listener.address() as any).port,
    url = `http://127.0.0.1:${port}`;
  await fs.writeFile(path.join(dataDir, 'access.json'), JSON.stringify({ url, token: service.token }));
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
  t.after(async () => {
    await client.close();
    listener.closeAllConnections();
    await new Promise<void>((r) => listener.close(() => r()));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-mcp-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = async (name: string, args: any = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return r.structuredContent as any;
  };
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'project_apply'));
  await call('project_create', { id: 'mcp-game', name: 'MCP game' });
  const job = await call('asset_generate', {
    projectId: 'mcp-game',
    expectedRevision: 0,
    requestId: 'generate-one',
    id: 'original',
    name: 'Original prop',
    recipe: {
      version: 1,
      shapes: [{ kind: 'ellipsoid', center: [0, 3, 0], size: [5, 6, 5], color: 0x55aaff }],
    },
  });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await call('job_status', { jobId: job.id });
    if (state.status === 'completed' || state.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.status, 'completed', JSON.stringify(state));
  const preview = await client.callTool({
    name: 'preview_capture',
    arguments: { projectId: 'mcp-game', assetId: 'original' },
  });
  assert.notEqual(preview.isError, true);
  const img = (preview as any).content[0];
  assert.equal(img.type, 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.equal(Buffer.from(img.data, 'base64').subarray(1, 4).toString(), 'PNG');
  await call('project_apply', {
    projectId: 'mcp-game',
    expectedRevision: 1,
    requestId: 'paint-one',
    operations: [
      {
        type: 'asset.edit',
        id: 'original',
        edit: { mode: 'paint', targets: [{ x: 0, y: 3, z: 0 }], color: 0 },
      },
    ],
  });
  let inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'original', limit: 2000 });
  assert.equal(inspected.voxels.find((v: any) => v.x === 0 && v.y === 3 && v.z === 0).color, 0);
  await call('project_undo', { projectId: 'mcp-game', expectedRevision: 2, requestId: 'undo-one' });
  inspected = await call('asset_inspect', { projectId: 'mcp-game', assetId: 'original', limit: 2000 });
  assert.equal(inspected.voxels.find((v: any) => v.x === 0 && v.y === 3 && v.z === 0).color, 0x55aaff);
  const saved = await call('project_save', { projectId: 'mcp-game' });
  const exported = JSON.parse(await fs.readFile(saved.path, 'utf8'));
  assert.equal(exported.revision, 3);
  assert.equal(exported.assets.length, 1);
  const reopened = await call('project_inspect', { projectId: 'mcp-game', full: true });
  assert.deepEqual(reopened, exported);
  const wait = async (job: any) => {
    for (let i = 0; i < 100; i++) {
      const state = await call('job_status', { jobId: job.id });
      if (state.status === 'completed') return state.result;
      if (state.status === 'failed') throw new Error(state.error);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Job did not finish.');
  };
  for (const kind of ['exploration', 'arena'] as const) {
    const example = await call('example_create', { kind, id: `mcp-${kind}` });
    assert.equal(example.id, `mcp-${kind}`);
    const report = await wait(await call('playtest_run', { projectId: example.id, ...exampleTests[kind] }));
    assert.equal(report.passed, true, JSON.stringify(report));
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
  assert.equal(stderr, '');
});
