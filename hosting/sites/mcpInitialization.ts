import { APP_VERSION } from '../../services/appMetadata';

export const HOSTED_MCP_PROTOCOL_VERSION = '2026-07-28';
export const HOSTED_MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  HOSTED_MCP_PROTOCOL_VERSION,
  HOSTED_MCP_LEGACY_PROTOCOL_VERSION,
] as const;

export const HOSTED_MCP_INSTRUCTIONS =
  'Inspect before editing. Hosted tool names differ from local stdio: asset_preview returns SVG (local preview_capture returns PNG), project_playtest maps to playtest_run, and scene_build maps to game_build. Call project_commands for the transaction schema; local stdio exposes it in project_apply.inputSchema. Objectives use variable/inventory conditions; playtests assert stable IDs. Playtests prove simulation, not visuals or FPS. Hosted has no viewport PNG tools, so use local stdio for real editor visual review. Mutations require expectedRevision and a unique requestId; retry only identical arguments. Writes are saved and undoable. Use project_save for a project artifact, or scene_build then job_status for standalone HTML.';

export function hostedMcpServerInfo() {
  return { name: 'voxshop', version: APP_VERSION };
}

/** Discovery is a modern, stateless request; the HTTP adapter adds wire metadata and safe cache hints. */
export function hostedMcpDiscoverResult() {
  return {
    supportedVersions: [...HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: { tools: {} },
    instructions: HOSTED_MCP_INSTRUCTIONS,
  };
}

/** Legacy clients must receive the latest handshake-era version, never the modern stateless version. */
export function hostedMcpInitializeResult() {
  return {
    protocolVersion: HOSTED_MCP_LEGACY_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: hostedMcpServerInfo(),
    instructions: HOSTED_MCP_INSTRUCTIONS,
  };
}
