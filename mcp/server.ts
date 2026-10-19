import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { idSchema, projectSummary, transactionSchema } from '../services/projectDocument';
import { recipeSchema } from '../services/recipeGenerator';
import { playtestSchema } from '../runtime/playtest';

const root = path.resolve(
  process.env.VOXSHOP_DATA_DIR ?? path.join(process.env.VOXSHOP_ROOT ?? process.cwd(), '.voxshop'),
);
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
async function api(route: string, body?: unknown) {
  const access = await connection();
  const response = await fetch(access.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-VoxShop-Token': access.token, 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `VoxShop returned ${response.status}.`);
  return data;
}
const server = new McpServer(
  { name: 'voxshop', version: '0.1.0' },
  {
    instructions:
      'Create editable voxel games with VoxShop. Inspect first. Every mutation requires an expectedRevision and unique requestId; retry the identical requestId only with identical arguments. Transactions are atomic and saved immediately. Generate recipes instead of enumerating cubes. Rule components use a bounded API, never eval. Project units are meters, Y up; rotations radians. Use job_status for asynchronous work. Preview images are static isometric asset renders. Playtest and game-build tools are exposed when available.',
  },
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
  'Inspect project summary or full portable document, with assets, scenes and authoring state.',
  { projectId, full: z.boolean().default(false) },
  async (args) => result(await api(`/api/projects/${args.projectId}${args.full ? '' : '/summary'}`)),
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
  'Apply a validated atomic batch of asset, scene, hierarchy, component or authoring operations. References are checked across the complete batch. All changes are undoable and saved.',
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
  'Create an original editable asset from bounded composable box, ellipsoid, cylinder and terrain shapes. Returns a cancellable job. Does not replace existing IDs or edits.',
  {
    projectId,
    ...revisionFields,
    id: idSchema,
    name: z.string().min(1).max(120),
    recipe: recipeSchema,
    voxelSize: z.number().positive().max(100).default(0.1),
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
  'Inspect bounds, rig, provenance and recipe. Voxel data is optional and paged to avoid huge tool results.',
  {
    projectId,
    assetId: idSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(0).max(2000).default(0),
  },
  async (args) => {
    const p = await api(`/api/projects/${args.projectId}`),
      a = p.assets.find((a: any) => a.id === args.assetId);
    if (!a) throw new Error('Asset not found.');
    const { model, ...metadata } = a;
    const bounds = model.voxels.reduce(
      (b: any, v: any) => ({
        min: b.min.map((n: number, i: number) => Math.min(n, v[['x', 'y', 'z'][i]])),
        max: b.max.map((n: number, i: number) => Math.max(n, v[['x', 'y', 'z'][i]])),
      }),
      { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    );
    return result({
      ...metadata,
      revision: p.revision,
      count: model.voxels.length,
      bounds: model.voxels.length ? bounds : null,
      skeleton: model.skeleton,
      voxels: model.voxels.slice(args.offset, args.offset + args.limit),
      nextOffset:
        args.limit && args.offset + args.limit < model.voxels.length ? args.offset + args.limit : null,
    });
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
  'Create an editable original starter project. Exploration is a crystal-collection trail; arena is a top-down combat game. Both share engine systems.',
  { kind: z.enum(['exploration', 'arena']), id: idSchema },
  async (args) => result(projectSummary(await api('/api/examples', args))),
);
register(
  'playtest_run',
  'Run a bounded deterministic scenario against an isolated copy of the saved scene. Returns a job with assertions, runtime state and events. This verifies simulation, not visual rendering.',
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
await server.connect(new StdioServerTransport());
