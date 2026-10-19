import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exampleTests } from '../services/examples';

// A real built broker and built MCP process, isolated from the creator's active workspace.
const root = process.cwd(),
  directory = path.join(root, '.voxshop', 'release-verification');
const port = 4329,
  url = `http://127.0.0.1:${port}`;
await fs.mkdir(directory, { recursive: true });
const broker = spawn(process.execPath, ['dist-server/server/main.js'], {
  cwd: root,
  env: { ...process.env, VOXSHOP_PORT: String(port), VOXSHOP_ROOT: root, VOXSHOP_DATA_DIR: directory },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let brokerError = '';
broker.stderr.on('data', (chunk) => (brokerError += chunk.toString()));
const client = new Client({ name: 'voxshop-built-release-check', version: '1.0.0' });
const output: { createdAt: string; source: string; checks: any[]; artifacts: any[] } = {
  createdAt: new Date().toISOString(),
  source: 'Built production broker + built stdio MCP client, Windows Node ' + process.version,
  checks: [],
  artifacts: [],
};
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (broker.exitCode !== null) throw new Error(brokerError || `Broker exited ${broker.exitCode}.`);
    try {
      const r = await fetch(url + '/api/session');
      if (r.ok) break;
    } catch {}
    if (attempt === 99) throw new Error('Built broker did not start.');
    await new Promise((r) => setTimeout(r, 100));
  }
  const html = await (await fetch(url)).text();
  if (!html.includes('id="root"') || !html.includes('/assets/'))
    throw new Error('Production editor HTML was not served.');
  output.checks.push({ check: 'Production editor HTML', passed: true });
  const access = JSON.parse(await fs.readFile(path.join(directory, 'access.json'), 'utf8'));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['dist-server/mcp/server.js'],
      cwd: root,
      env: { ...(process.env as Record<string, string>), VOXSHOP_DATA_DIR: directory },
      stderr: 'pipe',
    }),
  );
  const call = async (name: string, args: any = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(JSON.stringify(r));
    return r.structuredContent as any;
  };
  const wait = async (job: any) => {
    for (let n = 0; n < 100; n++) {
      const state = await call('job_status', { jobId: job.id });
      if (state.status === 'completed') return state.result;
      if (state.status === 'failed' || state.status === 'cancelled')
        throw new Error(state.error ?? state.status);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Job did not complete.');
  };
  const tools = await client.listTools();
  output.checks.push({ check: 'Built MCP discovery', passed: true, toolCount: tools.tools.length });
  const list = await call('project_list');
  for (const kind of ['exploration', 'arena'] as const) {
    const id = `release-${kind}`;
    if (!list.projects.some((p: any) => p.id === id)) await call('example_create', { kind, id });
    const report = await wait(await call('playtest_run', { projectId: id, ...exampleTests[kind] }));
    if (!report.passed) throw new Error(JSON.stringify(report));
    await fs.writeFile(path.join(directory, `${kind}-playtest.json`), JSON.stringify(report, null, 2));
    output.checks.push({
      check: `${kind} complete scenario`,
      passed: report.passed,
      assertions: report.assertions,
      frame: report.state.frame,
      status: report.state.status,
    });
    const built = await wait(await call('game_build', { projectId: id, sceneId: 'main' }));
    const bytes = await fs.readFile(built.path);
    if (createHash('sha256').update(bytes).digest('hex') !== built.sha256)
      throw new Error('Built artifact hash mismatch.');
    const download = await fetch(`${url}/api/games/${built.filename}`, {
      headers: { 'X-VoxShop-Token': access.token },
    });
    if (!download.ok) throw new Error(`Game download returned HTTP ${download.status}.`);
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    if (createHash('sha256').update(downloadedBytes).digest('hex') !== built.sha256)
      throw new Error('Downloaded game differs from the built artifact.');
    output.checks.push({ check: `${kind} authenticated game download`, passed: true });
    const saved = await call('project_save', { projectId: id });
    const full = await call('project_inspect', { projectId: id, full: true });
    if (JSON.stringify(JSON.parse(await fs.readFile(saved.path, 'utf8'))) !== JSON.stringify(full))
      throw new Error('Portable project did not match its saved revision.');
    output.artifacts.push(built);
    output.checks.push({
      check: `${kind} independent HTML + project export`,
      passed: true,
      revision: saved.revision,
    });
  }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: true,
        report: path.join(directory, 'report.json'),
        artifacts: output.artifacts.map((a) => ({ path: a.path, bytes: a.bytes, sha256: a.sha256 })),
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => {});
  broker.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (broker.exitCode !== null) return resolve();
    broker.once('exit', () => resolve());
    setTimeout(() => resolve(), 3000).unref();
  });
}
