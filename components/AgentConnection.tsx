import React, { useState } from 'react';
import { formatAgentConfiguration, type AgentClient } from '../services/agentConfiguration';

export const setupInstructions: Record<AgentClient, string> = {
  other: 'Add this JSON to an MCP-compatible client that supports local stdio servers.',
  claudeCode:
    'Add this mcpServers entry to the project-root .mcp.json. Approve the server when prompted; check with claude mcp list or /mcp.',
  claudeDesktop:
    'Current Claude Desktop offers local MCP desktop extensions in Settings > Extensions. For manual stdio setup, open Settings > Developer > Edit Config and merge this mcpServers entry into claude_desktop_config.json, then restart and verify the server in Claude Desktop.',
  gemini:
    'Merge into ~/.gemini/settings.json or the project .gemini/settings.json; check with `gemini mcp list`.',
  codex:
    'Add to ~/.codex/config.toml (Windows: %USERPROFILE%\\.codex\\config.toml); trusted projects can use .codex/config.toml. Check with `codex mcp list` or `/mcp`.',
  muse: 'Add to Muse Code settings.json ($XDG_CONFIG_HOME/muse/settings.json, default ~/.config/muse/settings.json). After Muse Code saves its own settings, verify that the VoxShop entry is still present and check it with `/mcp`.',
  opencode: 'Add to your project’s opencode.json; check with `opencode mcp list`.',
};

export default function AgentConnection({
  hosted,
  configuration,
  onNotice,
  onError,
  onClose,
}: {
  hosted: boolean;
  configuration: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [client, setClient] = useState<AgentClient>('other');
  const formatted =
    hosted || !configuration ? configuration : formatAgentConfiguration(configuration, client);
  return (
    <section className="studio-agent">
      <div>
        <strong>Build with your own agent</strong>
        <p>
          {hosted
            ? 'Connect your account’s VoxShop plugin in ChatGPT or Codex.'
            : 'Build with npm run build, keep the broker running, then add this stdio config to an MCP-compatible agent.'}{' '}
          Use your agent subscription; direct model API billing is separate.
        </p>
        <p>Your agent shares projects with the editor for asset generation, gameplay checks and exports.</p>
        {!hosted && (
          <label>
            Client configuration{' '}
            <select
              aria-label="Agent client"
              value={client}
              onChange={(e) => setClient(e.target.value as AgentClient)}
            >
              <option value="claudeCode">Claude Code · JSON</option>
              <option value="claudeDesktop">Claude Desktop · JSON</option>
              <option value="gemini">Gemini CLI · JSON</option>
              <option value="codex">Codex · TOML</option>
              <option value="muse">Muse Code · JSON</option>
              <option value="opencode">OpenCode · JSON</option>
              <option value="other">Other local MCP client · JSON</option>
            </select>
          </label>
        )}
        {!hosted && (
          <p>
            {setupInstructions[client]} Preserve existing servers. Reload/restart the client, then confirm
            VoxShop tools appear in its MCP list.
          </p>
        )}
      </div>
      <textarea aria-label="VoxShop MCP configuration" readOnly value={formatted} />
      <button
        onClick={() =>
          void navigator.clipboard
            .writeText(formatted)
            .then(() => onNotice('MCP configuration copied.'))
            .catch(() => onError('Select and copy the configuration manually.'))
        }
      >
        {hosted ? 'Copy setup' : 'Copy config'}
      </button>
      <button onClick={onClose}>Close</button>
    </section>
  );
}
