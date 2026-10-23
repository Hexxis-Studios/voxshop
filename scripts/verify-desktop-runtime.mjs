import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(projectRoot, '.voxshop', 'desktop-runtime');
const packagedRoot = process.env.VOXSHOP_DESKTOP_RUNTIME_ROOT
  ? path.resolve(process.env.VOXSHOP_DESKTOP_RUNTIME_ROOT)
  : null;
const resourcesRoot = packagedRoot ?? path.join(desktopRoot, 'resources');
const arch = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[process.arch];
if (!arch) throw new Error(`Unsupported desktop runtime architecture: ${process.arch}`);
const triple =
  process.platform === 'win32'
    ? `${arch}-pc-windows-msvc`
    : process.platform === 'linux'
      ? `${arch}-unknown-linux-gnu`
      : null;
if (!triple) throw new Error(`Unsupported desktop runtime platform: ${process.platform}`);
const executable = packagedRoot
  ? path.join(packagedRoot, `voxshop-node${process.platform === 'win32' ? '.exe' : ''}`)
  : path.join(
      projectRoot,
      'src-tauri',
      'binaries',
      `voxshop-node-${triple}${process.platform === 'win32' ? '.exe' : ''}`,
    );
const dataDir = await mkdtemp(path.join(desktopRoot, 'runtime-check-'));
const env = {
  ...process.env,
  VOXSHOP_ROOT: resourcesRoot,
  VOXSHOP_DATA_DIR: dataDir,
  VOXSHOP_PORT: '0',
};

function launchSidecar() {
  const child = spawn(executable, ['dist-server/server/main.js'], {
    cwd: resourcesRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`VoxShop sidecar did not start. ${stderr}`)), 20000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      const line = chunk.split(/\r?\n/).find((value) => value.startsWith('VoxShop: '));
      if (!line) return;
      clearTimeout(timer);
      resolve(line.slice('VoxShop: '.length).split(' ')[0]);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`VoxShop sidecar exited during startup (${code}). ${stderr}`));
    });
  });
  return { child, exited, ready };
}

async function stopSidecar(sidecar) {
  sidecar.child.kill();
  let timer;
  const stopped = await Promise.race([
    sidecar.exited.then(() => true),
    new Promise((resolve) => (timer = setTimeout(() => resolve(false), 3000))),
  ]);
  clearTimeout(timer);
  if (!stopped) throw new Error('VoxShop sidecar did not stop after the smoke test.');
}

let sidecar = launchSidecar();
const mcpClient = new Client({ name: 'voxshop-desktop-smoke', version: '1.0.0' });

try {
  const url = await sidecar.ready;

  const origin = new URL(url).origin;
  const sessionResponse = await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(5000) });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.publisher, 'Hexxis Studios');
  assert.equal(session.appVersion, '2.0.0-alpha.1');
  assert.equal(session.mcp.command, executable);
  assert.equal(session.mcp.args[0], path.join(resourcesRoot, 'dist-server', 'mcp', 'server.js'));
  assert.equal(session.mcp.env.VOXSHOP_ROOT, resourcesRoot);
  assert.equal(session.mcp.env.VOXSHOP_DATA_DIR, dataDir);

  const headers = { 'X-VoxShop-Token': session.token, 'Content-Type': 'application/json' };
  const projectResponse = await fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Desktop runtime smoke test' }),
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();
  const savedProjects = await readdir(path.join(dataDir, 'projects'));
  assert(savedProjects.includes(`${project.id}.json`));
  assert((await stat(path.join(dataDir, 'workspace.json'))).isFile());

  await mcpClient.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      cwd: resourcesRoot,
      env: { ...env, ...session.mcp.env },
      stderr: 'pipe',
    }),
  );
  const resources = await mcpClient.listResources(),
    workflowResource = resources.resources.find((resource) => resource.uri === 'voxshop://agent/workflow'),
    skillResource = resources.resources.find((resource) => resource.uri === 'voxshop://engine/skill');
  assert(workflowResource, 'The packaged MCP server must expose the shared workflow.');
  assert(skillResource, 'The packaged MCP server must expose the shared engine skill.');
  const workflow = await mcpClient.readResource({ uri: workflowResource.uri }),
    skill = await mcpClient.readResource({ uri: skillResource.uri });
  assert.match(workflow.contents[0]?.text ?? '', /tools\/list/);
  assert.match(skill.contents[0]?.text ?? '', /tools\/list/);

  const editorResponse = await fetch(origin, { signal: AbortSignal.timeout(5000) });
  assert.equal(editorResponse.status, 200);
  assert.match(await editorResponse.text(), /Hexxis Studios|VoxShop/i);
  await mcpClient.close();
  await stopSidecar(sidecar);
  sidecar = launchSidecar();

  const restartedUrl = new URL(await sidecar.ready),
    restartedSessionResponse = await fetch(`${restartedUrl.origin}/api/session`, {
      signal: AbortSignal.timeout(5000),
    });
  assert.equal(restartedSessionResponse.status, 200);
  const restartedSession = await restartedSessionResponse.json(),
    persistedResponse = await fetch(`${restartedUrl.origin}/api/projects`, {
      headers: { 'X-VoxShop-Token': restartedSession.token },
      signal: AbortSignal.timeout(5000),
    });
  assert.equal(persistedResponse.status, 200);
  const persisted = await persistedResponse.json();
  assert.equal(restartedSession.publisher, 'Hexxis Studios');
  assert.equal(restartedSession.appVersion, '2.0.0-alpha.1');
  assert.ok(persisted.projects.some((entry) => entry.id === project.id && entry.name === project.name));
  assert.equal(persisted.activeProjectId, project.id);
  assert((await stat(path.join(dataDir, 'workspace.json'))).isFile());
  console.log(
    'Desktop sidecar smoke passed: local editor, packaged MCP, and project/workspace persistence across sidecar restart.',
  );
} finally {
  await mcpClient.close().catch(() => {});
  if (sidecar) await stopSidecar(sidecar).catch(() => sidecar.child.kill());
  const relative = path.relative(desktopRoot, dataDir);
  if (!relative.startsWith('runtime-check-'))
    throw new Error('Refusing to remove desktop data outside the smoke-test directory.');
  await rm(dataDir, { recursive: true, force: true });
}
