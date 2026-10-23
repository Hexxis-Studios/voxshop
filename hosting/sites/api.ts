import { z } from 'zod';
import { HostedStore, HttpError, type Bindings } from './store';
import { idSchema, projectSummary, transactionSchema } from '../../services/projectDocument';
import { createModelDocument } from '../../services/modelDocument';
import { createExample, exampleKinds, exampleTests } from '../../services/examples';
import { assetPreview } from '../../services/assetPreview';
import { renderGameHtml, exportProject, sceneHasRigidBodies } from '../../runtime/gameExport';
import { playtestSchema, runPlaytest } from '../../runtime/playtest';
import runtime from '../../../hosted/runtime.js?raw';
import runtimeLite from '../../../hosted/runtime-lite.js?raw';
import license from '../../../hosted/three-license.txt?raw';
import skill from '../../../hosted/VOXEL_SKILL.md?raw';
import presets from '../../../hosted/presets.json';

export const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
export function context(request: Request, bindings: Partial<Bindings>) {
  const owner = request.headers.get('oai-authenticated-user-id');
  if (!owner) throw new HttpError(401, 'Sign in to your private VoxShop site to continue.');
  if (!bindings.DB || !bindings.BUCKET) throw new HttpError(503, 'VoxShop cloud storage is not ready.');
  return { owner, store: new HostedStore(bindings as Bindings, owner), env: bindings as Bindings };
}
export function failure(error: unknown) {
  const status =
    error instanceof HttpError
      ? error.status
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? 400
        : 500;
  const message =
    error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : error instanceof Error
        ? error.message
        : 'Request failed.';
  return reply({ error: message }, status);
}
export async function route(
  request: Request,
  bindings: Partial<Bindings>,
  trustedAgent = false,
): Promise<Response> {
  try {
    const { owner, store, env } = context(request, bindings);
    const url = new URL(request.url),
      path = url.pathname
        .replace(/^\/api\/?/, '')
        .split('/')
        .filter(Boolean);
    const method = request.method;
    if (!trustedAgent) {
      const origin = request.headers.get('origin');
      if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
        throw new HttpError(403, 'Cross-site access is not allowed.');
      if (path[0] !== 'session' && request.headers.get('x-voxshop-token') !== (await store.token()))
        throw new HttpError(401, 'VoxShop session changed. Refresh this page.');
    }
    const objectKey = (group: string, id: string) => `${owner}/${group}/${idSchema.parse(id)}`;
    const saveObject = async (key: string, value: unknown) =>
      env.BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
    const body = async () => {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 25 * 1024 * 1024)
        throw new HttpError(413, 'Request exceeds 25 MB.');
      return text ? JSON.parse(text) : {};
    };
    const job = async (kind: string, run: () => Promise<unknown>) => {
      const value: {
        id: string;
        kind: string;
        status: string;
        progress: number;
        createdAt: number;
        result?: unknown;
        error?: string;
      } = {
        id: crypto.randomUUID(),
        kind,
        status: 'running',
        progress: 0,
        createdAt: Date.now(),
      };
      try {
        value.result = await run();
        value.status = 'completed';
        value.progress = 1;
      } catch (error) {
        value.status = 'failed';
        value.error = error instanceof Error ? error.message : 'Operation failed.';
      }
      await saveObject(objectKey('jobs', value.id), value);
      return reply(value, 202);
    };
    if (path[0] === 'session' && method === 'GET')
      return reply({
        token: await store.token(),
        version: 1,
        hosted: true,
        capabilities: ['projects', 'recipes', 'scenes', 'rigs', 'equipment', 'mcp', 'playtest', 'game-build'],
        mcp: {
          url: url.origin + '/mcp',
          transport: 'streamable-http',
          instructions:
            'Install or connect this private VoxShop Site under Plugins → Personal → Created by you.',
        },
        limits: { assetVoxels: 250000, projectVoxels: 1000000, documentBytes: 16 * 1024 * 1024 },
      });
    if (path[0] === 'projects' && path.length === 1) {
      if (method === 'GET') return reply(await store.list());
      if (method === 'POST') {
        const b = z.object({ name: z.string(), id: idSchema.optional() }).parse(await body());
        return reply(await store.create(b.name, b.id), 201);
      }
    }
    if (path[0] === 'projects' && path[1] === 'import' && method === 'POST') {
      const b = await body();
      return reply(await store.import(b.project, b.id), 201);
    }
    if (path[0] === 'examples') {
      if (method === 'POST' && path.length === 1) {
        const b = z.object({ kind: z.enum(exampleKinds), id: idSchema.optional() }).parse(await body());
        const p = createExample(b.kind, b.id ?? crypto.randomUUID());
        return reply(await store.import(p, p.id), 201);
      }
      if (method === 'GET' && path[2] === 'playtest')
        return reply(exampleTests[z.enum(exampleKinds).parse(path[1])]);
    }
    if (path[0] === 'projects' && path[1]) {
      const id = idSchema.parse(path[1]);
      if (method === 'GET' && path.length === 2) return reply(await store.read(id));
      if (method === 'GET' && path[2] === 'summary') return reply(projectSummary(await store.read(id)));
      if (method === 'POST' && path[2] === 'activate') return reply(await store.activate(id));
      if (method === 'POST' && path[2] === 'transactions') return reply(await store.commit(id, await body()));
      if (method === 'POST' && (path[2] === 'undo' || path[2] === 'redo')) {
        const b = z
          .object({ expectedRevision: z.number().int().nonnegative(), requestId: idSchema })
          .parse(await body());
        return reply(await store.history(id, path[2], b));
      }
      if (method === 'POST' && path[2] === 'recover') return reply(await store.recover(id));
      if (method === 'POST' && path[2] === 'generate') {
        const b = transactionSchema.parse(await body());
        if (b.operations.some((o) => o.type !== 'asset.generate'))
          throw new HttpError(400, 'Generation accepts asset.generate operations only.');
        return job('asset-generation', async () => {
          const result = await store.commit(id, b);
          return {
            ...projectSummary(result.project),
            appliedRevision: result.appliedRevision,
            replayed: result.replayed,
          };
        });
      }
      if (method === 'POST' && path[2] === 'playtest') {
        const spec = playtestSchema.parse(await body()),
          p = await store.read(id);
        return job('playtest', async () => runPlaytest(p, spec));
      }
      if (method === 'POST' && path[2] === 'save') {
        const p = await store.read(id),
          text = JSON.stringify(p, null, 2);
        await env.BUCKET.put(objectKey('exports', id), text, {
          httpMetadata: { contentType: 'application/json' },
        });
        return reply({
          projectId: id,
          revision: p.revision,
          path: `/api/projects/${id}/export`,
          bytes: new TextEncoder().encode(text).byteLength,
        });
      }
      if (method === 'GET' && path[2] === 'export') {
        const p = await store.read(id);
        return new Response(JSON.stringify(p, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${id}.voxshop.json"`,
            'Cache-Control': 'no-store',
          },
        });
      }
      if (method === 'POST' && path[2] === 'build') {
        const sceneId = idSchema.parse((await body()).sceneId),
          p = await store.read(id);
        return job('game-build', async () => {
          const game = exportProject(p, sceneId),
            bundle = sceneHasRigidBodies(game.scenes[0]) ? runtime : runtimeLite,
            html = renderGameHtml(p, sceneId, bundle, license);
          const filename = `${id}-${sceneId}-r${p.revision}.html`;
          await env.BUCKET.put(`${owner}/games/${filename}`, html, {
            httpMetadata: { contentType: 'text/html' },
          });
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
          return {
            projectId: id,
            revision: p.revision,
            sceneId,
            filename,
            path: '/api/games/' + filename,
            bytes: new TextEncoder().encode(html).byteLength,
            sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''),
            assets: game.assets.length,
            voxels: game.assets.reduce((n, a) => n + a.model.voxels.length, 0),
            requirements:
              'Desktop browser with WebGL2. This HTML works independently without VoxShop or a network connection.',
          };
        });
      }
      if (method === 'GET' && path[2] === 'assets' && path[4] === 'preview') {
        const p = await store.read(id),
          asset = p.assets.find((a) => a.id === path[3]);
        if (!asset) throw new HttpError(404, 'Asset not found.');
        return new Response(assetPreview(asset), {
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          },
        });
      }
    }
    if (path[0] === 'games' && method === 'GET') {
      const filename = z
        .string()
        .regex(/^[a-zA-Z0-9_-]+-r\d+\.html$/)
        .parse(path[1]);
      const file = await env.BUCKET.get(`${owner}/games/${filename}`);
      if (!file) throw new HttpError(404, 'Game build not found.');
      return new Response(await file.text(), {
        headers: {
          'Content-Type': 'text/html',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    if (path[0] === 'jobs' && path[1]) {
      const key = objectKey('jobs', path[1]),
        file = await env.BUCKET.get(key);
      if (!file) throw new HttpError(404, 'Job not found.');
      return reply(await file.json());
    }
    if (path[0] === 'events' && method === 'GET') {
      const list = await store.list(),
        p = list.projects.find((p) => p.id === list.activeProjectId);
      const data =
        'event: connected\ndata: {}\n\n' +
        (p
          ? `event: change\ndata: ${JSON.stringify({ projectId: p.id, revision: p.revision, activated: true })}\n\n`
          : '');
      return new Response(data, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
      });
    }
    if (path[0] === 'skill') return reply({ content: skill });
    if (path[0] === 'presets') {
      if (method === 'GET') {
        const records = await env.DB.prepare(
          'SELECT object_key FROM presets WHERE owner = ? ORDER BY created_at DESC LIMIT 100',
        )
          .bind(owner)
          .all<{ object_key: string }>();
        const custom = await Promise.all(
          records.results.map(async (r) => (await env.BUCKET.get(r.object_key))?.json()),
        );
        return reply([...presets, ...custom.filter(Boolean)]);
      }
      if (method === 'POST') {
        const b = z
          .object({
            name: z.string().trim().min(1).max(120),
            data: z.array(z.unknown()).max(250000),
            skeleton: z.unknown().optional(),
          })
          .parse(await body());
        const model = createModelDocument(b.data, b.skeleton),
          id = crypto.randomUUID(),
          key = objectKey('presets', id);
        await saveObject(key, { name: b.name, data: model.voxels, skeleton: model.skeleton });
        await env.DB.prepare('INSERT INTO presets(owner,id,object_key,created_at) VALUES(?,?,?,?)')
          .bind(owner, id, key, Date.now())
          .run();
        return reply({ ok: true, file: id + '.json' });
      }
    }
    if (path[0] === 'diagnostics') return reply(path[1] === 'logs' ? { logs: [] } : { ok: true });
    if (path[0] === 'generate')
      throw new HttpError(
        501,
        'The local CLI adapter requires the desktop service. In this hosted studio, use recipes, the VoxShop agent tools, or the AI provider in Sculpt settings.',
      );
    if (path[0] === 'proxy' && method === 'POST') {
      const { endpoint, apiKey, ...payload } = z
        .object({ endpoint: z.string().url(), apiKey: z.string().max(1000).optional() })
        .passthrough()
        .parse(await body());
      const upstream = new URL(endpoint);
      if (
        !['https://api.openai.com', 'https://generativelanguage.googleapis.com'].includes(upstream.origin) ||
        upstream.username ||
        upstream.password ||
        upstream.hash
      )
        throw new HttpError(
          403,
          'Hosted AI requests support the OpenAI and Google HTTPS APIs. Local models require the desktop service.',
        );
      const result = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
      });
      const text = await result.text();
      if (new TextEncoder().encode(text).byteLength > 20 * 1024 * 1024)
        throw new HttpError(502, 'AI response exceeds 20 MB.');
      return new Response(text, {
        status: result.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    throw new HttpError(404, 'API route not found.');
  } catch (error) {
    return failure(error);
  }
}
