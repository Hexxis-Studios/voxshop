import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  assetInspectionView,
  idSchema,
  projectAuthoringView,
  projectSummary,
  transactionSchema,
} from '../services/projectDocument';
import { recipeSchema } from '../services/recipeGenerator';
import { playtestSchema } from '../runtime/playtest';
import { APP_VERSION } from '../services/appMetadata';
import { viewportCommandSchema } from '../services/viewportProtocol';
import { exampleKinds } from '../services/examples';
import { MCP_TOOL_DESCRIPTIONS } from '../services/mcpToolDescriptions';
import { multiplayerProjectBindingSchema } from '../services/multiplayerProtocol';

const root = path.resolve(
  process.env.VOXSHOP_DATA_DIR ?? path.join(process.env.VOXSHOP_ROOT ?? process.cwd(), '.voxshop'),
);
const resourceRoot = path.resolve(process.env.VOXSHOP_ROOT ?? process.cwd());
async function connection() {
  const access = z
    .object({ url: z.string().url(), token: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(JSON.parse(await fs.readFile(path.join(root, 'access.json'), 'utf8')));
  const url = new URL(access.url);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('MCP requires the local VoxShop broker.');
  return access;
}
async function api(route: string, body?: unknown, method?: 'GET' | 'POST' | 'DELETE') {
  const access = await connection();
  let response: Response;
  try {
    response = await fetch(access.url + route, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'X-VoxShop-Token': access.token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error(
      `Could not reach the local VoxShop broker at ${new URL(access.url).origin}. Check that the local editor service is running.`,
      { cause: error },
    );
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `VoxShop returned ${response.status}.`);
  return data;
}
const server = new McpServer(
  { name: 'voxshop', version: APP_VERSION },
  {
    instructions:
      'Create editable voxel games with VoxShop. If resources are available, read voxshop://agent/workflow and voxshop://engine/skill before authoring. Discover tools and inspect the current schemas before use; local project_apply.inputSchema exposes the transaction contract. Mutations require the current revision and a unique requestId; retry only identical arguments. Changes are saved and undoable. Use job_status for asynchronous work. Asset previews are static; for visual review, inspect real PNGs from viewport_clients and viewport_observe during bounded gameplay. Simulation checks do not prove rendered quality or FPS. Keep manual edits and recoverable drafts intact.',
  },
);
for (const [name, uri, filePath] of [
  ['agent-workflow', 'voxshop://agent/workflow', path.join(resourceRoot, 'skills', 'VOXSHOP_AGENT.md')],
  ['engine-skill', 'voxshop://engine/skill', path.join(resourceRoot, 'skills', 'ENGINE_GUIDE.md')],
  ['verified-findings', 'voxshop://engine/findings', path.join(resourceRoot, 'skills', 'ENGINE_LIMITS.md')],
] as const)
  server.registerResource(
    name,
    uri,
    {
      title: name === 'agent-workflow' ? 'VoxShop agent workflow' : `VoxShop ${name}`,
      description: 'Shared VoxShop guidance for agents connected with the owner’s own model subscription.',
      mimeType: 'text/markdown',
    },
    async (resourceUri) => ({
      contents: [
        {
          uri: resourceUri.href,
          mimeType: 'text/markdown',
          text: await fs.readFile(filePath, 'utf8'),
        },
      ],
    }),
  );
const projectId = idSchema.describe('Stable project ID returned by project_list or project_create.');
const revisionFields = {
  expectedRevision: z.number().int().nonnegative(),
  requestId: idSchema.describe('Unique idempotency key. Reuse only to retry identical arguments.'),
};
const result = (value: any) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value,
});
function register(
  name: string,
  description: string,
  inputSchema: any,
  handler: (args: any) => Promise<any>,
  readOnly = false,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        return await handler(args);
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    },
  );
}
register(
  'multiplayer_room_list',
  MCP_TOOL_DESCRIPTIONS.multiplayerRoomList,
  {},
  async () => result(await api('/api/multiplayer/rooms')),
  true,
);
register(
  'multiplayer_room_create',
  MCP_TOOL_DESCRIPTIONS.multiplayerRoomCreate,
  {
    maxPlayers: z.number().int().min(1).max(128).default(16),
    projectBinding: multiplayerProjectBindingSchema.optional(),
  },
  async (args) => result(await api('/api/multiplayer/rooms', args)),
);
register(
  'multiplayer_room_delete',
  MCP_TOOL_DESCRIPTIONS.multiplayerRoomDelete,
  { gameId: idSchema.describe('Room ID returned by multiplayer_room_create or multiplayer_room_list.') },
  async ({ gameId }) => result(await api(`/api/multiplayer/rooms/${gameId}`, undefined, 'DELETE')),
);
register(
  'project_list',
  'List local projects, IDs, revisions and active selection.',
  {},
  async () => result(await api('/api/projects')),
  true,
);
register(
  'project_create',
  'Create and activate a durable project. Passing a stable new ID prevents accidental duplicates.',
  { name: z.string().min(1).max(120), id: idSchema },
  async (args) => result(projectSummary(await api('/api/projects', args))),
);
register(
  'project_inspect',
  MCP_TOOL_DESCRIPTIONS.projectInspect,
  {
    projectId,
    full: z
      .boolean()
      .default(false)
      .describe('Return the complete portable document; takes precedence over compact.'),
    compact: z
      .boolean()
      .default(false)
      .describe(
        'Return scene nodes, components and world settings without voxel arrays; asset_inspect pages voxels.',
      ),
  },
  async (args) => {
    const project = await api(
      `/api/projects/${args.projectId}${args.full || args.compact ? '' : '/summary'}`,
    );
    return result(args.compact && !args.full ? projectAuthoringView(project) : project);
  },
  true,
);
register(
  'project_activate',
  'Open a project in the editor. Does not alter its revision.',
  { projectId },
  async (args) => result(projectSummary(await api(`/api/projects/${args.projectId}/activate`, {}))),
);
register(
  'project_apply',
  MCP_TOOL_DESCRIPTIONS.projectApply,
  { projectId, ...transactionSchema.shape },
  async ({ projectId: id, ...body }) => {
    const r = await api(`/api/projects/${id}/transactions`, body);
    return result({ ...projectSummary(r.project), appliedRevision: r.appliedRevision, replayed: r.replayed });
  },
);
for (const direction of ['undo', 'redo'])
  register(
    `project_${direction}`,
    `${direction} one complete project transaction. Revision increases; saved history survives restart.`,
    { projectId, ...revisionFields },
    async ({ projectId: id, ...body }) => {
      const r = await api(`/api/projects/${id}/${direction}`, body);
      return result({
        ...projectSummary(r.project),
        appliedRevision: r.appliedRevision,
        replayed: r.replayed,
      });
    },
  );
register(
  'project_save',
  'Write a portable .voxshop.json snapshot in the local exports directory and return its path and revision. Project edits are already saved automatically.',
  { projectId },
  async (args) => result(await api(`/api/projects/${args.projectId}/save`, {})),
);
register(
  'asset_generate',
  MCP_TOOL_DESCRIPTIONS.assetGenerate,
  {
    projectId,
    ...revisionFields,
    id: idSchema,
    name: z.string().min(1).max(120),
    recipe: recipeSchema,
    voxelSize: z
      .number()
      .positive()
      .min(0.001)
      .max(100)
      .default(0.1)
      .describe('Meters per asset voxel, independent of terrain-cell size and scene-node scale.'),
  },
  async ({ projectId: id, id: assetId, name, recipe, voxelSize, ...body }) =>
    result(
      await api(`/api/projects/${id}/generate`, {
        ...body,
        label: `Generate ${name}`,
        operations: [{ type: 'asset.generate', id: assetId, name, recipe, voxelSize }],
      }),
    ),
);
register(
  'asset_inspect',
  MCP_TOOL_DESCRIPTIONS.assetInspect,
  {
    projectId,
    assetId: idSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(0).max(2000).default(0),
  },
  async (args) => {
    const project = await api(`/api/projects/${args.projectId}`);
    return result(assetInspectionView(project, args.assetId, args.offset, args.limit));
  },
  true,
);
register(
  'preview_capture',
  'Render a static isometric PNG of an asset, returning an actual image. This is a geometry preview, not evidence of runtime gameplay or animation.',
  { projectId, assetId: idSchema },
  async (args) => {
    const access = await connection(),
      response = await fetch(
        `${access.url}/api/projects/${args.projectId}/assets/${args.assetId}/preview?format=png`,
        { headers: { 'X-VoxShop-Token': access.token }, signal: AbortSignal.timeout(30000) },
      );
    if (!response.ok) throw new Error((await response.json()).error);
    return {
      content: [
        {
          type: 'image' as const,
          mimeType: 'image/png',
          data: Buffer.from(await response.arrayBuffer()).toString('base64'),
        },
      ],
    };
  },
  true,
);
register(
  'job_status',
  'Inspect generation, test or build progress and result.',
  { jobId: idSchema },
  async (args) => result(await api(`/api/jobs/${args.jobId}`)),
  true,
);
register(
  'example_create',
  'Create an editable starter project: exploration is a crystal-collection trail, arena is a top-down combat game, survival is a short workbench-crafting loop, and construction is a voxel terrain building sandbox. These examples demonstrate current systems, not genre limits.',
  { kind: z.enum(exampleKinds), id: idSchema },
  async (args) => result(projectSummary(await api('/api/examples', args))),
);
register(
  'playtest_run',
  'Run a bounded deterministic scenario against an isolated copy of the saved scene. Assertions can check authored objective completion by stable objective ID. Returns a job with assertions, runtime state and events. This verifies simulation, not visual rendering.',
  { projectId, ...playtestSchema.shape },
  async ({ projectId: id, ...spec }) => result(await api(`/api/projects/${id}/playtest`, spec)),
);
register(
  'game_build',
  'Build one scene into a self-contained HTML game with only its referenced assets. No editor, MCP, AI, keys or network required to play. Returns a job and artifact path.',
  { projectId, sceneId: idSchema },
  async ({ projectId: id, ...body }) => result(await api(`/api/projects/${id}/build`, body)),
);
register(
  'job_cancel',
  'Cancel a queued/running job. Committed transactions remain committed; use undo to reverse them.',
  { jobId: idSchema },
  async (args) => result(await api(`/api/jobs/${args.jobId}/cancel`, {})),
);
register(
  'diagnostics_read',
  'Read bounded local service diagnostics. Secrets and raw AI payloads are not recorded.',
  {},
  async () => result(await api('/api/diagnostics/logs')),
  true,
);
register(
  'viewport_clients',
  'List connected local editors available for real rendered visual inspection.',
  {},
  async () => result(await api('/api/viewport')),
  true,
);
register(
  'viewport_observe',
  'Capture the actual open editor viewport as PNG with draw calls, triangles, camera and runtime state. Use benchmark for bounded callback cadence, renderer CPU call time, asynchronous GPU timing when supported, and culling/world stats. Set `occlusionCullingEnabled` to compare the same scene with culling on/off; the prior setting is restored. Use physics-query during Play for bounded read-only raycasts, box/sphere/capsule shape casts, and box/sphere/capsule overlap queries against active colliders; it does not advance simulation or edit the project. These are not monitor-presented FPS. Use play, camera and bounded step commands for a visual walkthrough. Step moveX/moveZ are world-plane axes; hold optional `sprint` to test the configured run speed and run clip. Physical keyboard/gamepad movement follows the live camera. Agent-driven Play pauses between steps; stop returns to manual authoring. Requires the matching open project/revision.',
  {
    projectId,
    expectedRevision: revisionFields.expectedRevision,
    clientId: idSchema.optional(),
    command: viewportCommandSchema,
  },
  async (args) => {
    const observed = await api('/api/viewport/request', args);
    const { image, ...metadata } = observed;
    return {
      content: [
        { type: 'image' as const, mimeType: 'image/png', data: image.slice('data:image/png;base64,'.length) },
        { type: 'text' as const, text: JSON.stringify(metadata) },
      ],
      structuredContent: metadata,
    };
  },
);
await server.connect(new StdioServerTransport());
