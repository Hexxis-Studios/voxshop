import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { idSchema } from '../services/projectDocument';
import {
  viewportRequestSchema,
  viewportResponseSchema,
  type ViewportRequest,
} from '../services/viewportProtocol';
import { ServiceError, type ProjectStore } from './projectStore';

/** Commands target one connected editor; no canonical project data is changed. */
export class ViewportBridge {
  private clients = new Map<string, (request: ViewportRequest) => void>();
  private origins = new Map<string, string | undefined>();
  private pending = new Map<
    string,
    {
      request: ViewportRequest;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private timeoutMs = 15000) {}
  list() {
    return [...this.clients.keys()].map((id) => ({ id, origin: this.origins.get(id) }));
  }
  connect(id: string, send: (request: ViewportRequest) => void, origin?: string) {
    idSchema.parse(id);
    if (this.clients.has(id)) throw new ServiceError(409, 'This editor connection is already registered.');
    this.clients.set(id, send);
    this.origins.set(id, origin);
    return () => {
      this.clients.delete(id);
      this.origins.delete(id);
      for (const [key, p] of this.pending)
        if (p.request.clientId === id) {
          clearTimeout(p.timer);
          this.pending.delete(key);
          p.reject(new ServiceError(503, 'Editor disconnected during visual inspection.'));
        }
    };
  }
  request(input: unknown) {
    const value = viewportRequestSchema.parse(input),
      clientId = value.clientId ?? [...this.clients.keys()].at(-1);
    if (!clientId || !this.clients.has(clientId))
      throw new ServiceError(503, 'Open the local VoxShop editor to inspect its real rendered viewport.');
    if ([...this.pending.values()].some((p) => p.request.clientId === clientId))
      throw new ServiceError(409, 'Wait for the current viewport command to finish.');
    const request = { ...value, id: randomUUID(), clientId };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new ServiceError(504, 'The editor did not complete visual inspection. Check the open editor.'),
        );
      }, this.timeoutMs);
      this.pending.set(request.id, { request, resolve, reject, timer });
      try {
        this.clients.get(clientId)!(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(error);
      }
    });
  }
  respond(input: unknown) {
    const value = viewportResponseSchema.parse(input),
      pending = this.pending.get(value.id);
    if (!pending) throw new ServiceError(404, 'Viewport request is no longer active.');
    if (
      value.clientId !== pending.request.clientId ||
      value.projectId !== pending.request.projectId ||
      value.revision !== pending.request.expectedRevision
    )
      throw new ServiceError(
        409,
        'Viewport response does not match the requested editor, project and revision.',
      );
    if (!value.error && !value.image)
      throw new ServiceError(400, 'A successful visual response must include an actual rendered PNG.');
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.error) pending.reject(new ServiceError(409, value.error));
    else if (
      (value.observation?.projectId !== undefined && value.observation.projectId !== value.projectId) ||
      (value.observation?.revision !== undefined && value.observation.revision !== value.revision)
    )
      pending.reject(
        new ServiceError(
          409,
          'The rendered viewport does not match the requested project revision. Retry the capture.',
        ),
      );
    else pending.resolve(value);
  }
}
export function viewportRoutes(bridge: ViewportBridge, store: ProjectStore) {
  const router = Router();
  router.get('/', (_req, res) => res.json({ clients: bridge.list() }));
  router.post('/request', async (req, res) => {
    const value = viewportRequestSchema.parse(req.body),
      project = await store.read(value.projectId);
    if (project.revision !== value.expectedRevision)
      throw new ServiceError(409, 'Project changed; inspect its current revision before visual inspection.');
    res.json(await bridge.request(value));
  });
  router.post('/result', (req, res) => {
    bridge.respond(req.body);
    res.json({ ok: true });
  });
  return router;
}
