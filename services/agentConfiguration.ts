export type AgentClient = 'other' | 'claudeCode' | 'claudeDesktop' | 'gemini' | 'codex' | 'muse' | 'opencode';
/** Formats an existing local MCP launch description; never reads or changes client credentials. */
export function formatAgentConfiguration(configuration: string, client: AgentClient): string {
  if (client === 'other' || client === 'claudeCode' || client === 'claudeDesktop' || client === 'gemini')
    return configuration;
  const server = JSON.parse(configuration).mcpServers.voxshop as {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  if (client === 'opencode')
    return JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          servers: {
            voxshop: {
              type: 'local',
              command: [server.command, ...server.args],
              environment: server.env ?? {},
            },
          },
        },
      },
      null,
      2,
    );
  if (client === 'muse')
    return JSON.stringify(
      {
        schema_version: 1,
        mcpServers: {
          voxshop: { type: 'stdio', command: server.command, args: server.args, env: server.env ?? {} },
        },
      },
      null,
      2,
    );
  return [
    '[mcp_servers.voxshop]',
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    ...(Object.keys(server.env ?? {}).length
      ? [
          '',
          '[mcp_servers.voxshop.env]',
          ...Object.entries(server.env!).map(
            ([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`,
          ),
        ]
      : []),
  ].join('\n');
}
