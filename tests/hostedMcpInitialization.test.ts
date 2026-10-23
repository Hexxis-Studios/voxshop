import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import {
  HOSTED_MCP_PROTOCOL_VERSION,
  HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  hostedMcpInitializeResult,
} from '../hosting/sites/mcpInitialization';
import { assetInspectionView, newProject, projectSummary } from '../services/projectDocument';
import { MCP_TOOL_DESCRIPTIONS } from '../services/mcpToolDescriptions';
import { createModelDocument } from '../services/modelDocument';
import type { Bindings } from '../hosting/sites/store';

test('hosted MCP initialization explains adapter tools, visual limits, and artifact workflow', () => {
  const initialized = hostedMcpInitializeResult();

  assert.equal(initialized.protocolVersion, '2025-11-25');
  assert.deepEqual(initialized.capabilities, { tools: {} });
  assert.match(initialized.instructions, /asset_preview returns SVG .*preview_capture returns PNG/);
  assert.ok(initialized.instructions.length < 750);
  assert.match(initialized.instructions, /project_playtest maps to playtest_run/);
  assert.match(initialized.instructions, /scene_build maps to game_build/);
  assert.match(initialized.instructions, /project_commands .*project_apply\.inputSchema/);
  assert.match(initialized.instructions, /Objectives use variable\/inventory conditions/);
  assert.match(initialized.instructions, /playtests assert stable IDs/);
  assert.match(initialized.instructions, /Playtests prove simulation, not visuals or FPS/);
  assert.match(initialized.instructions, /no viewport PNG tools/);
  assert.match(initialized.instructions, /Use project_save for a project artifact/);
  assert.match(initialized.instructions, /scene_build then job_status for standalone HTML/);
});

test('hosted MCP exposes compact project details and pages voxels through its actual request handler', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-hosted-mcp-test-'));
  const hostedDirectory = path.join(directory, 'hosted');
  await fs.mkdir(hostedDirectory, { recursive: true });
  await Promise.all(
    [
      ['runtime.js', 'export default test runtime;'],
      ['runtime-lite.js', 'export default test lite runtime;'],
      ['three-license.txt', 'Test license notice.'],
      ['VOXEL_SKILL.md', '# Test skill'],
      ['presets.json', '[]'],
    ].map(([name, contents]) => fs.writeFile(path.join(hostedDirectory, name), contents)),
  );
  const vite = await createServer({
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'custom',
    plugins: [
      {
        name: 'hosted-mcp-test-assets',
        enforce: 'pre',
        resolveId(source) {
          if (!source.startsWith('../../../hosted/')) return null;
          const [assetPath, query] = source.split('?');
          const resolved = path.resolve(directory, assetPath.slice('../../../'.length));
          return query ? `${resolved}?${query}` : resolved;
        },
      },
    ],
  });
  t.after(async () => {
    await vite.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-hosted-mcp-test-')));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const hosted = (await vite.ssrLoadModule('/hosting/sites/mcp.ts')) as {
    mcp(request: Request, env: Partial<Bindings>): Promise<Response>;
  };
  const project = newProject('hosted-mcp-project', 'Hosted MCP project');
  project.revision = 3;
  project.assets.push({
    id: 'sample',
    name: 'Sample',
    model: createModelDocument([
      { x: -2, y: 3, z: 5, color: 0xe13a83 },
      { x: 4, y: -1, z: 2, color: 0x39a1f4 },
      { x: 0, y: 0, z: 0, color: 0x88aa44 },
    ]),
    voxelSize: 0.04,
    pivot: [0, 0, 0],
    rig: null,
    source: { kind: 'authored', description: '' },
  });
  const stateKey = 'owner/projects/hosted-mcp-project/state.json';
  const state = { project, undo: [], redo: [], receipts: [] };
  const row = {
    id: project.id,
    revision: project.revision,
    state_key: stateKey,
    previous_key: null,
    summary: JSON.stringify(projectSummary(project)),
  };
  const env = {
    DB: {
      prepare() {
        const statement: any = {
          bind() {
            return statement;
          },
          async first() {
            return row;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    },
    BUCKET: {
      async get(key: string) {
        return key === stateKey
          ? {
              async json() {
                return structuredClone(state);
              },
              async text() {
                return JSON.stringify(state);
              },
            }
          : null;
      },
      async put() {},
      async delete() {},
    },
  } as unknown as Bindings;

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await hosted.mcp(
      new Request('https://voxshop.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    const message = (await response.json()) as any;
    assert.equal(message.error, undefined, JSON.stringify(message));
    assert.notEqual(message.result.isError, true, JSON.stringify(message.result));
    return message.result.structuredContent;
  };

  const modernRequest = (
    method: string,
    params: Record<string, unknown> = {},
    version = HOSTED_MCP_PROTOCOL_VERSION,
    headerOverrides: Record<string, string | undefined> = {},
  ) => {
    const headers = new Headers({
      'content-type': 'application/json',
      'oai-authenticated-user-id': 'owner',
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
      ...(method === 'tools/call' && typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    });
    for (const [key, value] of Object.entries(headerOverrides)) {
      if (value === undefined) headers.delete(key);
      else headers.set(key, value);
    }
    return new Request('https://voxshop.example/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
  };

  const initializeResponse = await hosted.mcp(
    new Request('https://voxshop.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '1' },
        },
      }),
    }),
    env,
  );
  assert.equal(((await initializeResponse.json()) as any).result.protocolVersion, '2025-11-25');

  const discoveryResponse = await hosted.mcp(modernRequest('server/discover'), env);
  const discovery = ((await discoveryResponse.json()) as any).result;
  assert.deepEqual(discovery.supportedVersions, HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS);
  assert.equal(discovery.resultType, 'complete');
  assert.equal(discovery._meta['io.modelcontextprotocol/serverInfo'].name, 'voxshop');
  assert.equal(discovery.ttlMs, 0);
  assert.equal(discovery.cacheScope, 'private');

  const modernToolsResponse = await hosted.mcp(modernRequest('tools/list'), env);
  const modernTools = ((await modernToolsResponse.json()) as any).result;
  assert.ok(modernTools.tools.some((tool: any) => tool.name === 'asset_inspect'));
  const projectApplyTool = modernTools.tools.find((tool: any) => tool.name === 'project_apply');
  const projectInspectTool = modernTools.tools.find((tool: any) => tool.name === 'project_inspect');
  const assetGenerateTool = modernTools.tools.find((tool: any) => tool.name === 'asset_generate');
  const assetInspectTool = modernTools.tools.find((tool: any) => tool.name === 'asset_inspect');
  const projectPlaytestTool = modernTools.tools.find((tool: any) => tool.name === 'project_playtest');
  assert.ok(projectApplyTool);
  assert.ok(projectInspectTool);
  assert.ok(assetGenerateTool);
  assert.ok(assetInspectTool);
  assert.ok(projectPlaytestTool);
  assert.equal(projectApplyTool.description, MCP_TOOL_DESCRIPTIONS.projectApply);
  assert.equal(projectInspectTool.description, MCP_TOOL_DESCRIPTIONS.projectInspect);
  assert.equal(assetGenerateTool.description, MCP_TOOL_DESCRIPTIONS.assetGenerate);
  assert.equal(assetInspectTool.description, MCP_TOOL_DESCRIPTIONS.assetInspect);
  assert.ok(projectApplyTool.description.length < 180);
  assert.ok(projectInspectTool.description.length < 200);
  assert.ok(assetGenerateTool.description.length < 140);
  assert.ok(assetInspectTool.description.length < 120);
  assert.match(projectInspectTool.description, /tools\/list/);
  assert.match(projectApplyTool.description, /expectedRevision.*unique requestId/);
  assert.match(projectApplyTool.description, /returned appliedRevision.*re-inspect before iterating/);
  assert.match(projectPlaytestTool.description, /simulation steps/);
  assert.match(projectPlaytestTool.description, /does not prove rendered quality or FPS/);
  const hostedApplySchema = JSON.stringify(projectApplyTool.inputSchema);
  const hostedInspectSchema = JSON.stringify(projectInspectTool.inputSchema);
  assert.ok(hostedApplySchema.includes('lighting'));
  assert.match(hostedApplySchema, /Meters per terrain cell/);
  assert.match(hostedApplySchema, /Meters per asset voxel/);
  assert.match(hostedApplySchema, /unique new ID per stored prefab node/);
  assert.match(hostedApplySchema, /Current project revision/);
  assert.match(hostedInspectSchema, /takes precedence over compact/);
  assert.match(JSON.stringify(assetGenerateTool.inputSchema), /not valid for terrain/);
  assert.equal(modernTools.ttlMs, 0);
  assert.equal(modernTools.cacheScope, 'private');

  const modernCallResponse = await hosted.mcp(
    modernRequest('tools/call', {
      name: 'project_inspect',
      arguments: { projectId: project.id },
    }),
    env,
  );
  const modernCall = ((await modernCallResponse.json()) as any).result;
  assert.equal(modernCall.resultType, 'complete');
  assert.equal(modernCall._meta['io.modelcontextprotocol/serverInfo'].name, 'voxshop');
  assert.equal(modernCall.structuredContent.projectId, project.id);

  const missingHeaderResponse = await hosted.mcp(
    modernRequest('tools/list', {}, HOSTED_MCP_PROTOCOL_VERSION, { 'Mcp-Method': undefined }),
    env,
  );
  assert.equal(missingHeaderResponse.status, 400);
  assert.equal(((await missingHeaderResponse.json()) as any).error.code, -32020);

  const unsupportedResponse = await hosted.mcp(modernRequest('tools/list', {}, '2099-01-01'), env);
  assert.equal(unsupportedResponse.status, 400);
  assert.equal(((await unsupportedResponse.json()) as any).error.code, -32022);

  const badNameResponse = await hosted.mcp(
    modernRequest('tools/call', { name: 'project_list', arguments: {} }, HOSTED_MCP_PROTOCOL_VERSION, {
      'Mcp-Name': 'asset_inspect',
    }),
    env,
  );
  assert.equal(badNameResponse.status, 400);
  assert.equal(((await badNameResponse.json()) as any).error.code, -32020);

  const toolsResponse = await hosted.mcp(
    new Request('https://voxshop.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    }),
    env,
  );
  const toolsMessage = (await toolsResponse.json()) as any;
  const tools = toolsMessage.result?.tools;
  assert.ok(Array.isArray(tools), JSON.stringify(toolsMessage));
  assert.ok(tools.some((tool: any) => tool.name === 'asset_inspect'));

  const compact = await call('project_inspect', { projectId: project.id, compact: true });
  assert.equal(compact.assets[0].modelSummary.voxelCount, 3);
  assert.equal(compact.assets[0].model, undefined);
  const full = await call('project_inspect', { projectId: project.id, full: true, compact: true });
  assert.equal(full.assets[0].model.voxels.length, 3);

  const page = await call('asset_inspect', {
    projectId: project.id,
    assetId: 'sample',
    offset: 1,
    limit: 1,
  });
  assert.deepEqual(page, assetInspectionView(project, 'sample', 1, 1));
  assert.equal(page.voxels.length, 1);
  assert.equal(page.nextOffset, 2);
});
