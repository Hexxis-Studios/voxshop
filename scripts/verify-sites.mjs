import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5183');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname))
  throw Error('This integration fixture runs only against a loopback Worker preview.');
const owner = 'verification-' + randomUUID(),
  other = 'verification-' + randomUUID();
const headers = { 'oai-authenticated-user-id': owner, 'Content-Type': 'application/json' };
const checks = [];
async function api(path, body, expected = 200, custom = {}) {
  const response = await fetch(new URL('/api' + path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...custom },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
  return value;
}
assert.equal((await fetch(new URL('/api/session', base))).status, 401);
checks.push('anonymous API rejected');
const session = await api('/session');
headers['X-VoxShop-Token'] = session.token;
await api('/projects', { name: 'Blocked' }, 403, { Origin: 'https://untrusted.invalid' });
checks.push('cross-origin write rejected');
const id = 'sites-' + randomUUID();
const created = await api('/projects', { id, name: 'Hosted fixture' }, 201);
assert.equal(created.revision, 0);
await api('/projects', { id, name: 'Duplicate' }, 409);
const tx = {
  expectedRevision: 0,
  requestId: 'rename-' + randomUUID(),
  operations: [{ type: 'project.rename', name: 'Renamed fixture' }],
};
const committed = await api(`/projects/${id}/transactions`, tx);
assert.equal(committed.project.revision, 1);
assert.equal((await api(`/projects/${id}/transactions`, tx)).replayed, true);
await api(
  `/projects/${id}/transactions`,
  { ...tx, operations: [{ type: 'project.rename', name: 'Different' }] },
  409,
);
await api(`/projects/${id}/transactions`, { ...tx, requestId: 'stale-' + randomUUID() }, 409);
checks.push('saved edits, duplicate receipt and revision conflicts');
const race = await Promise.all(
  ['A', 'B'].map(async (name) => {
    const r = await fetch(new URL(`/api/projects/${id}/transactions`, base), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        requestId: randomUUID(),
        operations: [{ type: 'project.rename', name }],
      }),
    });
    return r.status;
  }),
);
assert.deepEqual(race.sort(), [200, 409]);
checks.push('concurrent writers have one winner');
const undo = await api(`/projects/${id}/undo`, { expectedRevision: 2, requestId: randomUUID() });
assert.equal(undo.project.name, 'Renamed fixture');
const redo = await api(`/projects/${id}/redo`, { expectedRevision: 3, requestId: randomUUID() });
assert.equal(redo.project.revision, 4);
checks.push('undo and redo preserve monotonic revisions');
const generation = await api(
  `/projects/${id}/generate`,
  {
    expectedRevision: 4,
    requestId: randomUUID(),
    operations: [
      {
        type: 'asset.generate',
        id: 'cube',
        name: 'Cube',
        voxelSize: 0.1,
        recipe: {
          version: 1,
          seed: 1,
          shapes: [{ kind: 'box', center: [0, 0, 0], size: [3, 3, 3], color: 16711680 }],
        },
      },
    ],
  },
  202,
);
assert.equal((await api(`/jobs/${generation.id}`)).status, 'completed');
const document = await api(`/projects/${id}`);
assert.equal(document.assets[0].model.voxels.length, 27);
checks.push('recipe generation and durable job result');
const saved = await api(`/projects/${id}/save`, {});
assert.equal(saved.revision, 5);
const exported = await api(`/projects/${id}/export`);
assert.deepEqual(exported, document);
checks.push('portable export matches saved document');
const imported = await api('/projects/import', { id: 'import-' + randomUUID(), project: exported }, 201);
assert.equal(imported.assets[0].model.voxels.length, 27);
checks.push('portable project import');
const otherSession = await api('/session', undefined, 200, { 'oai-authenticated-user-id': other });
const otherHeaders = { 'oai-authenticated-user-id': other, 'X-VoxShop-Token': otherSession.token };
await api(`/projects/${id}`, undefined, 404, otherHeaders);
checks.push('project data isolated by signed-in owner');
const games = [];
for (const kind of ['exploration', 'arena', 'survival']) {
  const example = await api('/examples', { kind, id: kind + '-' + randomUUID() }, 201);
  const spec = await api(`/examples/${kind}/playtest`);
  const play = await api(`/projects/${example.id}/playtest`, spec, 202);
  assert.equal(play.status, 'completed');
  assert.equal(play.result.passed, true);
  const build = await api(`/projects/${example.id}/build`, { sceneId: example.activeSceneId }, 202);
  assert.equal(build.status, 'completed');
  const response = await fetch(new URL('/api/games/' + build.result.filename, base), { headers });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(createHash('sha256').update(html).digest('hex'), build.result.sha256);
  assert.equal(Buffer.byteLength(html), build.result.bytes);
  assert.ok(html.includes('voxshop-project'));
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(!html.includes('<script src='));
  assert.equal(
    (await fetch(new URL('/api/games/' + build.result.filename, base), { headers: otherHeaders })).status,
    404,
  );
  games.push({ kind, bytes: build.result.bytes, sha256: build.result.sha256 });
}
checks.push('all three game objectives, independent HTML builds, hashes and private downloads');
async function mcp(method, params = {}) {
  const protocolVersion = '2026-07-28';
  const r = await fetch(new URL('/mcp', base), {
    method: 'POST',
    headers: {
      ...headers,
      'MCP-Protocol-Version': protocolVersion,
      'Mcp-Method': method,
      ...(method === 'tools/call' && typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocolVersion,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  assert.equal(r.status, 200);
  return (await r.json()).result;
}
assert.deepEqual((await mcp('server/discover')).supportedVersions, ['2026-07-28', '2025-11-25']);
const tools = (await mcp('tools/list')).tools;
assert.equal(tools.length, 17);
assert.deepEqual(tools.find((tool) => tool.name === 'example_create').inputSchema.properties.kind.enum, [
  'exploration',
  'arena',
  'survival',
]);
const applySchema = tools.find((tool) => tool.name === 'project_apply').inputSchema;
assert.equal(applySchema.properties.operations.maxItems, 256);
const operationTypes = applySchema.properties.operations.items.oneOf.map(
  (operation) => operation.properties.type.const,
);
assert.ok(operationTypes.includes('world.create'));
assert.ok(operationTypes.includes('scene.put'));
assert.ok(operationTypes.includes('node.put'));
const inspect = await mcp('tools/call', { name: 'project_inspect', arguments: { projectId: id } });
assert.equal(inspect.isError, undefined, JSON.stringify(inspect));
const schema = await mcp('tools/call', { name: 'project_commands', arguments: {} });
assert.equal(schema.isError, undefined, JSON.stringify(schema));
checks.push('17 real MCP tools with typed project operations and matching transaction limits');
const report = {
  passed: true,
  checks,
  games,
  transport:
    process.env.VOXSHOP_API_FIXTURE === '1'
      ? 'standard Request/Response with real Miniflare D1/R2 bindings'
      : 'HTTP Worker preview',
  browserInteractionVerified: false,
  verifiedAt: new Date().toISOString(),
};
fs.mkdirSync('.voxshop/sites', { recursive: true });
fs.writeFileSync('.voxshop/sites/verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
