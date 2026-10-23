import { z } from 'zod';
import { context, route, failure } from './api';
import { HttpError } from './store';
import type { Bindings } from './store';
import {
  assetInspectionView,
  idSchema,
  projectAuthoringView,
  transactionSchema,
} from '../../services/projectDocument';
import { recipeSchema } from '../../services/recipeGenerator';
import { playtestSchema } from '../../runtime/playtest';
import {
  HOSTED_MCP_PROTOCOL_VERSION,
  HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  hostedMcpDiscoverResult,
  hostedMcpInitializeResult,
  hostedMcpServerInfo,
} from './mcpInitialization';
import { exampleKinds } from '../../services/examples';
import { MCP_TOOL_DESCRIPTIONS } from '../../services/mcpToolDescriptions';

const fields = { projectId: idSchema };
const revision = { expectedRevision: z.number().int().nonnegative(), requestId: idSchema };
const projectApplySchema = transactionSchema.safeExtend(fields);
const definitions = [
  ['project_list', 'List saved projects and the active project.', z.object({}), true],
  [
    'project_create',
    'Create and activate a saved project with a stable new ID.',
    z.object({ name: z.string().min(1).max(120), id: idSchema }),
    false,
  ],
  [
    'project_inspect',
    MCP_TOOL_DESCRIPTIONS.projectInspect,
    z.object({
      ...fields,
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
    }),
    true,
  ],
  [
    'project_activate',
    'Open a saved project in the editor without changing its revision.',
    z.object(fields),
    false,
  ],
  ['project_apply', MCP_TOOL_DESCRIPTIONS.projectApply, projectApplySchema, false],
  [
    'project_undo',
    'Undo one complete transaction. Revision increases.',
    z.object({ ...fields, ...revision }),
    false,
  ],
  [
    'project_redo',
    'Redo one complete transaction. Revision increases.',
    z.object({ ...fields, ...revision }),
    false,
  ],
  [
    'project_save',
    'Save a portable snapshot and return its private download route. Edits are already saved.',
    z.object(fields),
    false,
  ],
  [
    'asset_generate',
    MCP_TOOL_DESCRIPTIONS.assetGenerate,
    z.object({
      ...fields,
      ...revision,
      id: idSchema,
      name: z.string().min(1).max(120),
      recipe: recipeSchema,
      voxelSize: z
        .number()
        .positive()
        .max(100)
        .default(0.1)
        .describe('Meters per asset voxel, independent of terrain-cell size and scene-node scale.'),
    }),
    false,
  ],
  [
    'asset_preview',
    'Read an asset as an isometric SVG document.',
    z.object({ ...fields, assetId: idSchema }),
    true,
  ],
  [
    'asset_inspect',
    MCP_TOOL_DESCRIPTIONS.assetInspect,
    z.object({
      ...fields,
      assetId: idSchema,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(0).max(2000).default(0),
    }),
    true,
  ],
  [
    'example_create',
    'Create an editable exploration, arena, survival crafting game or voxel construction sandbox, including its original assets and rules. These starters demonstrate current systems, not genre limits.',
    z.object({ kind: z.enum(exampleKinds), id: idSchema }),
    false,
  ],
  [
    'project_playtest',
    'Run bounded simulation steps and assertions against a scene, including objective completion by stable ID; return a durable job. This does not prove rendered quality or FPS.',
    z.object({ ...fields, spec: playtestSchema }),
    false,
  ],
  [
    'scene_build',
    'Build a playable standalone HTML game with no runtime network dependencies.',
    z.object({ ...fields, sceneId: idSchema }),
    false,
  ],
  [
    'job_status',
    'Inspect a stored generation, playtest or game-build result.',
    z.object({ jobId: idSchema }),
    true,
  ],
  [
    'job_cancel',
    'Cancel when supported; already completed jobs remain completed.',
    z.object({ jobId: idSchema }),
    false,
  ],
  [
    'project_import',
    'Import a portable project using a new stable ID.',
    z.object({ id: idSchema, project: z.record(z.string(), z.unknown()) }),
    false,
  ],
  [
    'project_commands',
    'Read the complete validated transaction schema before composing operations.',
    z.object({}),
    true,
  ],
] as const;

type McpMessage = { id?: unknown; method?: string; params?: Record<string, unknown> };

const protocolVersionKey = 'io.modelcontextprotocol/protocolVersion';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';

function protocolError(id: unknown, code: number, message: string, data?: unknown) {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  );
}

function validateProtocolRequest(request: Request, message: McpMessage, id: unknown) {
  const metadata = message.params?._meta as Record<string, unknown> | undefined,
    bodyVersion = metadata?.[protocolVersionKey],
    headerVersion = request.headers.get('MCP-Protocol-Version'),
    methodHeader = request.headers.get('Mcp-Method'),
    modernRequest =
      message.method === 'server/discover' ||
      bodyVersion === HOSTED_MCP_PROTOCOL_VERSION ||
      headerVersion === HOSTED_MCP_PROTOCOL_VERSION;

  if (message.method === 'initialize' || message.method === 'notifications/initialized')
    return { modern: false as const, error: null };

  if (!modernRequest) {
    const requested = [headerVersion, bodyVersion].find(
      (version): version is string =>
        typeof version === 'string' &&
        !HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(
          version as (typeof HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS)[number],
        ),
    );
    return requested
      ? {
          modern: false as const,
          error: protocolError(id, -32022, 'Unsupported protocol version.', {
            supported: HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS,
            requested,
          }),
        }
      : { modern: false as const, error: null };
  }

  if (typeof bodyVersion !== 'string' || headerVersion !== bodyVersion || methodHeader !== message.method)
    return {
      modern: true as const,
      error: protocolError(
        id,
        -32020,
        'Header mismatch: MCP protocol version and method headers must match request metadata and body.',
      ),
    };

  if (
    !HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(
      bodyVersion as (typeof HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
  )
    return {
      modern: true as const,
      error: protocolError(id, -32022, 'Unsupported protocol version.', {
        supported: HOSTED_MCP_SUPPORTED_PROTOCOL_VERSIONS,
        requested: bodyVersion,
      }),
    };

  if (bodyVersion !== HOSTED_MCP_PROTOCOL_VERSION)
    return {
      modern: false as const,
      error: protocolError(id, -32601, 'Method not found for the requested protocol version.'),
    };

  const expectedName = message.method === 'tools/call' ? message.params?.name : undefined,
    nameHeader = request.headers.get('Mcp-Name');
  if (
    (expectedName !== undefined && nameHeader !== expectedName) ||
    (expectedName === undefined && nameHeader !== null)
  )
    return {
      modern: true as const,
      error: protocolError(id, -32020, 'Header mismatch: Mcp-Name does not match request parameters.'),
    };

  return { modern: true as const, error: null };
}

function modernResult(result: unknown, method: string) {
  const cacheable = method === 'server/discover' || method === 'tools/list';
  return {
    ...(result && typeof result === 'object' ? result : {}),
    resultType: 'complete',
    _meta: { [serverInfoKey]: hostedMcpServerInfo() },
    ...(cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}),
  };
}

export async function mcp(request: Request, env: Partial<Bindings>) {
  let id: unknown = null;
  try {
    context(request, env);
    const origin = request.headers.get('origin');
    if (
      (origin && origin !== new URL(request.url).origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      throw new HttpError(403, 'Cross-site MCP requests are not allowed.');
    const message = (await request.json()) as McpMessage;
    id = message.id ?? null;
    const protocol = validateProtocolRequest(request, message, id);
    if (protocol.error) return protocol.error;
    let result: unknown;
    if (message.method === 'server/discover') result = hostedMcpDiscoverResult();
    else if (message.method === 'initialize') result = hostedMcpInitializeResult();
    else if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list')
      result = {
        tools: definitions.map(([name, description, schema, readOnly]) => ({
          name,
          description,
          inputSchema: z.toJSONSchema(schema, { io: 'input' }),
          annotations: {
            readOnlyHint: readOnly,
            destructiveHint: !readOnly,
            openWorldHint: false,
            idempotentHint: readOnly,
          },
        })),
      };
    else if (message.method === 'tools/call') {
      try {
        const name = message.params?.name,
          definition = definitions.find((d) => d[0] === name);
        if (!definition) throw Error('Unknown VoxShop tool.');
        const a = definition[2].parse(message.params?.arguments ?? {}) as any;
        const base = new URL(request.url).origin;
        const api = async (path: string, body?: unknown) => {
          const response = await route(
            new Request(base + '/api' + path, {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                'Content-Type': 'application/json',
                'oai-authenticated-user-id': request.headers.get('oai-authenticated-user-id')!,
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            env,
            true,
          );
          if (!response.ok) {
            const error = (await response.json()) as { error: string };
            throw Error(error.error);
          }
          return response;
        };
        let value: any;
        if (name === 'project_commands') value = z.toJSONSchema(transactionSchema, { io: 'input' });
        else if (name === 'asset_preview')
          value = {
            format: 'image/svg+xml',
            svg: await (await api(`/projects/${a.projectId}/assets/${a.assetId}/preview`)).text(),
          };
        else if (name === 'asset_inspect') {
          const project = (await (await api(`/projects/${a.projectId}`)).json()) as any;
          value = assetInspectionView(project, a.assetId, a.offset, a.limit);
        } else {
          let path = '',
            body: unknown = undefined;
          if (name === 'project_list') path = '/projects';
          else if (name === 'project_create') {
            path = '/projects';
            body = a;
          } else if (name === 'project_import') {
            path = '/projects/import';
            body = a;
          } else if (name === 'example_create') {
            path = '/examples';
            body = a;
          } else if (name === 'project_inspect')
            path = `/projects/${a.projectId}${a.full || a.compact ? '' : '/summary'}`;
          else if (name === 'job_status') path = `/jobs/${a.jobId}`;
          else if (name === 'job_cancel') {
            path = `/jobs/${a.jobId}/cancel`;
            body = {};
          } else if (name === 'asset_generate') {
            path = `/projects/${a.projectId}/generate`;
            body = {
              expectedRevision: a.expectedRevision,
              requestId: a.requestId,
              operations: [
                { type: 'asset.generate', id: a.id, name: a.name, recipe: a.recipe, voxelSize: a.voxelSize },
              ],
            };
          } else {
            const action: Record<string, string> = {
              project_apply: 'transactions',
              project_undo: 'undo',
              project_redo: 'redo',
              project_activate: 'activate',
              project_save: 'save',
              project_playtest: 'playtest',
              scene_build: 'build',
            };
            path = `/projects/${a.projectId}/${action[name!]}`;
            const { projectId, ...rest } = a;
            body = name === 'project_playtest' ? a.spec : rest;
          }
          value = await (await api(path, body)).json();
          if (name === 'project_inspect' && a.compact && !a.full) value = projectAuthoringView(value);
          if (value.project?.assets)
            value = {
              projectId: value.project.id,
              name: value.project.name,
              revision: value.project.revision,
              appliedRevision: value.appliedRevision,
              replayed: value.replayed,
            };
          else if (value.assets && value.scenes && !a.full && !a.compact)
            value = {
              projectId: value.id,
              name: value.name,
              revision: value.revision,
              assets: value.assets.length,
              scenes: value.scenes.length,
            };
        }
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        result = {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed.' }],
        };
      }
    } else
      return Response.json(
        { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } },
        { status: protocol.modern ? 404 : 200 },
      );
    return Response.json(
      { jsonrpc: '2.0', id, result: protocol.modern ? modernResult(result, message.method ?? '') : result },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return failure(error);
  }
}
