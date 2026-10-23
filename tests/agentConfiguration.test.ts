import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentConfiguration } from '../services/agentConfiguration';

test('agent configurations preserve exact executable paths, arguments and environment without invoking a shell', () => {
  const server = {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\A B\\voxshop\\dist-server\\mcp\\server.js'],
    env: { VOXSHOP_ROOT: 'C:\\Users\\A B\\voxshop', VOXSHOP_DATA_DIR: 'D:\\my games' },
  };
  const json = JSON.stringify({ mcpServers: { voxshop: server } }, null, 2);
  for (const client of ['claudeCode', 'claudeDesktop', 'gemini', 'other'] as const)
    assert.equal(formatAgentConfiguration(json, client), json);
  const opencode = JSON.parse(formatAgentConfiguration(json, 'opencode')).mcp.servers.voxshop;
  assert.deepEqual(opencode.command, [server.command, ...server.args]);
  assert.deepEqual(opencode.environment, server.env);
  assert.equal(opencode.type, 'local');
  assert.equal('enabled' in opencode, false);
  const muse = JSON.parse(formatAgentConfiguration(json, 'muse'));
  assert.equal(muse.schema_version, 1);
  assert.deepEqual(muse.mcpServers.voxshop, { type: 'stdio', ...server });
  const toml = formatAgentConfiguration(json, 'codex');
  assert.ok(toml.includes('command = ' + JSON.stringify(server.command)));
  assert.ok(toml.includes('args = ' + JSON.stringify(server.args)));
  assert.ok(toml.includes('[mcp_servers.voxshop.env]'));
});
