import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { ProjectStore, ServiceError } from './projectStore';
import { Jobs } from './jobs';
import { assetPreview } from '../services/assetPreview';
import { createModelDocument } from '../services/modelDocument';
import { idSchema, projectSummary } from '../services/projectDocument';
import { Resvg } from '@resvg/resvg-js';
import { createExample, exampleTests } from '../services/examples';
import { playtestSchema, runPlaytest } from '../runtime/playtest';
import { buildGame } from './gameBuild';

export async function createApp(options: { root: string; dataDir?: string; port?: number; token?: string }) {
  const root = path.resolve(options.root),
    dataDir = path.resolve(options.dataDir ?? path.join(root, '.voxshop'));
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const port = options.port ?? 4269,
    token = options.token ?? randomBytes(32).toString('hex');
  const store = new ProjectStore(path.join(dataDir, 'projects')),
    jobs = new Jobs(),
    events = new EventEmitter();
  const app = express();
  app.disable('x-powered-by');
  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  const safeEqual = (a: string, b: string) => {
    const left = Buffer.from(a),
      right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    const boundPort = req.socket.localPort;
    if (
      !new Set([`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`]).has(
        req.get('host') ?? '',
      )
    )
      return res.status(403).json({ error: 'Only the configured loopback host is allowed.' });
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin))
      return res.status(403).json({ error: 'Origin is not allowed.' });
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-VoxShop-Token');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.path.startsWith('/api/')) {
      res.set('Cache-Control', 'no-store');
      if (req.path !== '/api/session' && !safeEqual(req.get('x-voxshop-token') ?? '', token))
        return res.status(401).json({ error: 'VoxShop session token required.' });
      if (req.path === '/api/session' && req.get('sec-fetch-site') === 'cross-site')
        return res.status(403).json({ error: 'Cross-site session access denied.' });
    }
    next();
  });
  app.use(express.json({ limit: '25mb', strict: true }));
  const diagnostics: { timestamp: number; level: string; event: string; data?: unknown }[] = [];
  const log = (event: string, data?: unknown) => {
    diagnostics.push({ timestamp: Date.now(), level: 'info', event, data });
    if (diagnostics.length > 200) diagnostics.shift();
  };
  const changed = (id: string, revision: number) => {
    events.emit('change', { projectId: id, revision });
    log('project.saved', { projectId: id, revision });
  };
  const workspaceFile = path.join(dataDir, 'workspace.json');
  const active = async () => {
    try {
      return JSON.parse(await fs.readFile(workspaceFile, 'utf8')).activeProjectId as string;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  const activate = async (id: string) => {
    const project = await store.read(id);
    const temporary = workspaceFile + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ activeProjectId: id }), { mode: 0o600 });
    await fs.rename(temporary, workspaceFile);
    events.emit('change', { projectId: id, revision: project.revision, activated: true });
    return project;
  };
  app.get('/api/session', (_req, res) =>
    res.json({
      token,
      version: 1,
      capabilities: ['projects', 'recipes', 'scenes', 'rigs', 'equipment', 'mcp', 'playtest', 'game-build'],
      mcp: {
        command: process.execPath,
        args: [path.join(root, 'dist-server', 'mcp', 'server.js')],
        env: {
          VOXSHOP_ROOT: root,
          ...(dataDir !== path.join(root, '.voxshop') ? { VOXSHOP_DATA_DIR: dataDir } : {}),
        },
      },
      limits: { assetVoxels: 250000, projectVoxels: 1000000 },
    }),
  );
  app.get('/api/projects', async (_req, res) =>
    res.json({ ...(await store.list()), activeProjectId: await active() }),
  );
  app.post('/api/projects', async (req, res) => {
    const b = z.object({ name: z.string(), id: idSchema.optional() }).parse(req.body);
    const p = await store.create(b.name, b.id);
    await activate(p.id);
    res.status(201).json(p);
  });
  app.post('/api/projects/import', async (req, res) => {
    const p = await store.import(req.body.project, req.body.id);
    await activate(p.id);
    res.status(201).json(p);
  });
  app.post('/api/examples', async (req, res) => {
    const b = z.object({ kind: z.enum(['exploration', 'arena']), id: idSchema.optional() }).parse(req.body);
    const example = createExample(b.kind, b.id ?? randomUUID());
    const p = await store.import(example, example.id);
    await activate(p.id);
    res.status(201).json(p);
  });
  app.get('/api/examples/:kind/playtest', (req, res) => {
    const kind = z.enum(['exploration', 'arena']).parse(req.params.kind);
    res.json(exampleTests[kind]);
  });
  app.get('/api/projects/:id', async (req, res) => res.json(await store.read(req.params.id)));
  app.get('/api/projects/:id/summary', async (req, res) =>
    res.json(projectSummary(await store.read(req.params.id))),
  );
  app.post('/api/projects/:id/save', async (req, res) => {
    const p = await store.read(req.params.id),
      directory = path.join(dataDir, 'exports');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${p.id}.voxshop.json`),
      temporary = filename + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(p, null, 2), { mode: 0o600 });
    await fs.rename(temporary, filename);
    res.json({
      projectId: p.id,
      revision: p.revision,
      path: filename,
      bytes: Buffer.byteLength(JSON.stringify(p, null, 2)),
    });
  });
  app.post('/api/projects/:id/playtest', async (req, res) => {
    const spec = playtestSchema.parse(req.body),
      project = await store.read(req.params.id);
    res.status(202).json(
      jobs.start('playtest', async (signal, progress) => {
        progress(0.1);
        return runPlaytest(project, spec, signal);
      }),
    );
  });
  app.post('/api/projects/:id/build', async (req, res) => {
    const sceneId = idSchema.parse(req.body.sceneId),
      project = await store.read(req.params.id);
    res.status(202).json(
      jobs.start('game-build', async (signal, progress) => {
        progress(0.1);
        return buildGame(project, sceneId, { root, directory: path.join(dataDir, 'games') }, signal);
      }),
    );
  });
  app.get('/api/games/:filename', async (req, res) => {
    const filename = z
      .string()
      .regex(/^[a-zA-Z0-9_-]+-r\d+\.html$/)
      .parse(req.params.filename);
    res.download(path.join(dataDir, 'games', filename), filename, { dotfiles: 'allow' });
  });
  app.post('/api/projects/:id/activate', async (req, res) => res.json(await activate(req.params.id)));
  app.post('/api/projects/:id/transactions', async (req, res) => {
    const result = await store.commit(req.params.id, req.body);
    if (!result.replayed) changed(result.project.id, result.project.revision);
    res.json(result);
  });
  app.post('/api/projects/:id/generate', async (req, res) => {
    const id = idSchema.parse(req.params.id),
      body = req.body;
    // Validation and the final revision check still occur in the same transaction service.
    const job = jobs.start('asset-generation', async (signal, progress) => {
      progress(0.1);
      await new Promise((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
      if (!Array.isArray(body.operations) || body.operations.some((o: any) => o.type !== 'asset.generate'))
        throw new ServiceError(400, 'Generation jobs accept asset.generate operations only.');
      const result = await store.commit(id, body, signal);
      if (!result.replayed) changed(result.project.id, result.project.revision);
      return {
        ...projectSummary(result.project),
        appliedRevision: result.appliedRevision,
        replayed: result.replayed,
      };
    });
    res.status(202).json(job);
  });
  for (const direction of ['undo', 'redo'] as const)
    app.post(`/api/projects/:id/${direction}`, async (req, res) => {
      const body = z
        .object({ expectedRevision: z.number().int().nonnegative(), requestId: idSchema })
        .parse(req.body);
      const result = await store.history(req.params.id, direction, body);
      if (!result.replayed) changed(result.project.id, result.project.revision);
      res.json(result);
    });
  app.post('/api/projects/:id/recover', async (req, res) => {
    const p = await store.recover(req.params.id);
    changed(p.id, p.revision);
    res.json(p);
  });
  app.get('/api/projects/:id/assets/:assetId/preview', async (req, res) => {
    const p = await store.read(req.params.id),
      a = p.assets.find((a) => a.id === req.params.assetId);
    if (!a) throw new ServiceError(404, 'Asset not found.');
    const svg = assetPreview(a);
    if (req.query.format === 'png') res.type('image/png').send(new Resvg(svg).render().asPng());
    else res.type('image/svg+xml').send(svg);
  });
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n');
    const listener = (value: unknown) => res.write(`event: change\ndata: ${JSON.stringify(value)}\n\n`);
    events.on('change', listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      events.off('change', listener);
      clearInterval(heartbeat);
    });
  });
  app.get('/api/jobs/:id', (req, res) => res.json(jobs.read(req.params.id)));
  app.post('/api/jobs/:id/cancel', (req, res) => res.json(jobs.cancel(req.params.id)));
  app.get('/api/diagnostics/logs', (_req, res) => res.json({ logs: diagnostics }));
  app.post('/api/diagnostics/clear', (_req, res) => {
    diagnostics.length = 0;
    res.json({ ok: true });
  });
  app.get('/api/skill', async (_req, res) =>
    res.json({ content: await fs.readFile(path.join(root, 'skills', 'VOXEL_SKILL.md'), 'utf8') }),
  );

  // The optional compatibility worker uses isolated request directories and matched response IDs.
  // MCP operates directly on project commands and never requires this adapter.
  app.post('/api/generate', async (req, res) => {
    const b = z
      .object({
        prompt: z.string().min(1).max(200000),
        currentGrid: z
          .union([z.string(), z.array(z.unknown())])
          .nullable()
          .optional(),
      })
      .parse(req.body);
    const job = jobs.start('legacy-generation', async (signal, progress) => {
      const id = randomUUID(),
        directory = path.join(dataDir, 'bridge', id);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({ requestId: id, ...b }), {
        mode: 0o600,
      });
      const start = Date.now();
      try {
        while (!signal.aborted) {
          try {
            const response = JSON.parse(
              (await fs.readFile(path.join(directory, 'response.json'), 'utf8')).replace(/^\uFEFF/, ''),
            );
            if (response.requestId !== id)
              throw new Error('Generation response ID does not match this request.');
            return createModelDocument(response.voxels).voxels;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
          }
          if (Date.now() - start > 600000)
            throw new Error(
              'Worker did not respond within ten minutes. Connect an MCP agent or start the compatibility worker.',
            );
          progress((Date.now() - start) / 600000);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, 500);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener('abort', done);
              resolve();
            }
            signal.addEventListener('abort', done, { once: true });
          });
        }
        throw new Error('Generation cancelled.');
      } finally {
        await fs.writeFile(
          path.join(directory, 'status.json'),
          JSON.stringify({ finished: true, cancelled: signal.aborted }),
          { mode: 0o600 },
        );
      }
    });
    res.set('X-VoxShop-Job', job.id);
    const disconnect = () => jobs.cancel(job.id);
    res.on('close', disconnect);
    try {
      for (;;) {
        const state = jobs.read(job.id);
        if (state.status === 'completed') return res.json(state.result);
        if (state.status === 'failed' || state.status === 'cancelled')
          throw new ServiceError(502, state.error ?? 'Generation cancelled.');
        if (res.destroyed) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      res.off('close', disconnect);
    }
  });
  const aiOrigins = new Set(
    (
      process.env.VOXSHOP_AI_ORIGINS ??
      'https://api.openai.com,https://generativelanguage.googleapis.com,http://127.0.0.1:11434,http://localhost:11434,http://127.0.0.1:1234,http://localhost:1234'
    )
      .split(',')
      .map((s) => s.trim()),
  );
  app.post('/api/proxy', async (req, res) => {
    const { endpoint, apiKey, ...payload } = z
      .object({ endpoint: z.string().url(), apiKey: z.string().max(1000).optional() })
      .passthrough()
      .parse(req.body);
    const url = new URL(endpoint);
    if (
      !aiOrigins.has(url.origin) ||
      url.username ||
      url.password ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol)
    )
      throw new ServiceError(
        403,
        'AI endpoint is not enabled. Add its exact origin to VOXSHOP_AI_ORIGINS when starting VoxShop.',
      );
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 120000);
    const disconnect = () => controller.abort();
    res.on('close', disconnect);
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const reader = upstream.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.length;
          if (total > 20 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('AI response exceeded 20 MB.');
          }
          chunks.push(part.value);
        }
      log('proxy.response', { host: url.host, status: upstream.status });
      res.status(upstream.status).type('application/json').send(Buffer.concat(chunks));
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
    }
  });
  const userPresets = path.join(dataDir, 'presets');
  await fs.mkdir(userPresets, { recursive: true, mode: 0o700 });
  app.get('/api/presets', async (_req, res) => {
    const presets: unknown[] = [];
    for (const directory of [path.join(root, 'presets'), userPresets]) {
      for (const filename of await fs.readdir(directory).catch(() => []))
        if (filename.endsWith('.json')) {
          try {
            const raw = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
            const model = createModelDocument(raw.data, raw.skeleton);
            presets.push({ name: raw.name, data: model.voxels, skeleton: model.skeleton });
          } catch {
            log('preset.invalid', { filename });
          }
        }
    }
    res.json(presets);
  });
  app.post('/api/presets', async (req, res) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(120),
        data: z.array(z.unknown()).max(250000),
        skeleton: z.unknown().optional(),
      })
      .parse(req.body);
    const model = createModelDocument(b.data, b.skeleton),
      filename = randomUUID() + '.json';
    await fs.writeFile(
      path.join(userPresets, filename),
      JSON.stringify({ name: b.name, data: model.voxels, skeleton: model.skeleton }),
      { flag: 'wx', mode: 0o600 },
    );
    res.json({ ok: true, file: filename });
  });
  app.use(express.static(path.join(root, 'dist'), { index: 'index.html', dotfiles: 'deny' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      error instanceof ServiceError
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
    log('request.failed', { status });
    if (!res.headersSent) res.status(status).json({ error: message });
  });
  return { app, store, jobs, token, dataDir, port, events };
}
