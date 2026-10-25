import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exampleKinds, exampleTests } from '../services/examples';
import { APP_PUBLISHER, APP_VERSION } from '../services/appMetadata';

// A real built broker and built MCP process, isolated from the creator's active workspace.
const root = process.cwd(),
  verificationRoot = path.join(root, '.voxshop', 'release-verification');
await fs.mkdir(verificationRoot, { recursive: true });
const directory = path.resolve(
  process.env.VOXSHOP_VERIFY_DIR ?? (await fs.mkdtemp(path.join(verificationRoot, 'run-'))),
);
const port = Number(process.env.VOXSHOP_VERIFY_PORT ?? 4329),
  url = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('VOXSHOP_VERIFY_PORT must be an integer from 1 to 65535.');
await fs.mkdir(directory, { recursive: true });
const client = new Client({ name: 'voxshop-built-release-check', version: '1.0.0' });
const output: { createdAt: string; source: string; checks: any[]; artifacts: any[] } = {
  createdAt: new Date().toISOString(),
  source: 'Built production broker + built stdio MCP client, Windows Node ' + process.version,
  checks: [],
  artifacts: [],
};
const [fullRuntime, liteRuntime] = await Promise.all([
  fs.readFile(path.join(root, 'dist', 'runtime.js'), 'utf8'),
  fs.readFile(path.join(root, 'dist', 'runtime-lite.js'), 'utf8'),
]);
if (fullRuntime.length - liteRuntime.length <= 1_000_000)
  throw new Error('The no-physics runtime must leave out the bundled Rapier WebAssembly payload.');
if (/@dimforge/i.test(liteRuntime))
  throw new Error('The no-physics runtime contains Rapier package code or license text.');
if (APP_VERSION !== '2.0.0-alpha.1' || APP_PUBLISHER !== 'Hexxis Studios')
  throw new Error(`Release identity changed unexpectedly: ${APP_PUBLISHER} ${APP_VERSION}.`);
const sourceLogo = path.join(root, 'assets', 'voxshop_logo.png'),
  builtAssets = await fs.readdir(path.join(root, 'dist', 'assets'));
if (
  (await fs.stat(sourceLogo)).size === 0 ||
  !builtAssets.some((name) => /^voxshop_logo-.+\.png$/i.test(name))
)
  throw new Error('The original VoxShop logo is missing from the source or production build.');
const builtScripts = await Promise.all(
  builtAssets
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFile(path.join(root, 'dist', 'assets', name), 'utf8')),
);
const builtIdentity = builtScripts.join('\n');
if (!builtIdentity.includes(APP_PUBLISHER) || !builtIdentity.includes(APP_VERSION))
  throw new Error('Publisher or release version is missing from the production editor bundle.');
output.checks.push({ check: 'Release branding, version and original logo', passed: true });
output.checks.push({
  check: 'Standalone runtime variants',
  passed: true,
  fullBytes: Buffer.byteLength(fullRuntime),
  liteBytes: Buffer.byteLength(liteRuntime),
});
// Finish file checks before starting a child; every started broker is covered by finally.
const broker = spawn(process.execPath, ['dist-server/server/main.js'], {
  cwd: root,
  env: {
    ...process.env,
    VOXSHOP_PORT: String(port),
    VOXSHOP_MULTIPLAYER_PORT: '0',
    VOXSHOP_ROOT: root,
    VOXSHOP_DATA_DIR: directory,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let brokerError = '',
  brokerOutput = '';
broker.stderr.on('data', (chunk) => (brokerError += chunk.toString()));
broker.stdout.on('data', (chunk) => (brokerOutput += chunk.toString()));
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (broker.exitCode !== null) throw new Error(brokerError || `Broker exited ${broker.exitCode}.`);
    // An existing server on this port must never be mistaken for our isolated broker.
    if (brokerOutput.includes(`VoxShop: http://127.0.0.1:${port} (local access only)`)) {
      try {
        const r = await fetch(url + '/api/session', { signal: AbortSignal.timeout(1000) });
        if (r.ok) break;
      } catch {}
    }
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
  const resources = await client.listResources(),
    workflowResource = resources.resources.find((resource) => resource.uri === 'voxshop://agent/workflow'),
    skillResource = resources.resources.find((resource) => resource.uri === 'voxshop://engine/skill'),
    findingsResource = resources.resources.find((resource) => resource.uri === 'voxshop://engine/findings');
  if (!workflowResource || !skillResource || !findingsResource)
    throw new Error('Built MCP server did not expose all shared VoxShop guidance resources.');
  const readText = (contents: Array<{ text: string } | { blob: string }>) =>
      contents.map((content) => ('text' in content ? content.text : '')).join('\n'),
    workflow = await client.readResource({ uri: workflowResource.uri }),
    skill = await client.readResource({ uri: skillResource.uri }),
    findings = await client.readResource({ uri: findingsResource.uri });
  if (
    !/tools\/list/.test(readText(workflow.contents)) ||
    !/tools\/list/.test(readText(skill.contents)) ||
    !/current capabilities and limits/i.test(readText(findings.contents))
  )
    throw new Error('Built MCP guidance resources did not return their expected shared content.');
  output.checks.push({ check: 'Built MCP shared agent guidance resources', passed: true });
  const room = await call('multiplayer_room_create', { maxPlayers: 2 });
  const rooms = await call('multiplayer_room_list');
  if (
    room.maxPlayers !== 2 ||
    !/^wss?:\/\//.test(room.websocketUrl) ||
    !/^[A-Za-z0-9_-]{43}$/.test(room.credential) ||
    rooms.rooms?.length !== 1 ||
    rooms.rooms[0]?.gameId !== room.gameId ||
    JSON.stringify(rooms).includes(room.credential)
  )
    throw new Error('Built MCP multiplayer room management returned invalid or leaked room data.');
  await call('multiplayer_room_delete', { gameId: room.gameId });
  output.checks.push({ check: 'Built MCP multiplayer room lifecycle', passed: true });
  const runId = Date.now().toString(36);
  for (const kind of exampleKinds) {
    const id = `release-${kind}-${runId}`;
    await call('example_create', { kind, id });
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
    if (/Dimforge EURL|Apache License/i.test(bytes.toString('utf8')))
      throw new Error(`${kind} has no rigid bodies but its export contains Rapier code or license text.`);
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
