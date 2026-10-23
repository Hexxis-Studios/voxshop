import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentConnection, { setupInstructions } from '../components/AgentConnection';

test('local agent setup tells users to reload and verify the MCP server', () => {
  const html = renderToStaticMarkup(
    React.createElement(AgentConnection, {
      hosted: false,
      configuration: JSON.stringify({ mcpServers: { voxshop: { command: 'node', args: [] } } }),
      onNotice: () => {},
      onError: () => {},
      onClose: () => {},
    }),
  );

  assert.match(html, /reload\/restart the client/i);
  assert.match(html, /confirm VoxShop tools appear in its MCP list/i);
  assert.match(setupInstructions.muse, /after Muse Code saves its own settings/i);
  assert.match(setupInstructions.muse, /\$XDG_CONFIG_HOME\/muse\/settings\.json/);
  assert.match(setupInstructions.muse, /verify that the VoxShop entry is still present/i);
  assert.match(setupInstructions.claudeCode, /project-root \.mcp\.json/);
  assert.match(setupInstructions.claudeCode, /claude mcp list/);
  assert.match(setupInstructions.claudeDesktop, /Settings > Extensions/);
  assert.match(setupInstructions.claudeDesktop, /Developer > Edit Config/);
  assert.match(setupInstructions.codex, /%USERPROFILE%\\\.codex\\config\.toml/);
  assert.match(setupInstructions.codex, /codex mcp list/);
  assert.match(setupInstructions.opencode, /opencode mcp list/);
});
