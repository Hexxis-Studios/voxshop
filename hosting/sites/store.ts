import {
  applyProjectOperations, idSchema, newProject, projectSummary,
  transactionSchema, validateProject, type ProjectDocument,
} from '../../services/projectDocument';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Receipt = { id: string; digest: string; revision: number };
type State = { project: ProjectDocument; undo: string[]; redo: string[]; receipts: Receipt[] };
type Row = { id: string; revision: number; state_key: string; previous_key: string | null; summary: string };
type Query = {
  bind(...values: unknown[]): Query;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{results: T[]}>;
  run(): Promise<{meta: {changes: number}}>;
};
export type Bindings = {
  DB: {prepare(sql: string): Query};
  BUCKET: {
    get(key: string): Promise<{json<T>(): Promise<T>; text(): Promise<string>} | null>;
    put(key: string, value: string, options?: {httpMetadata?: {contentType: string}}): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
};
export class HostedStore {
  constructor(readonly env: Bindings, readonly owner: string) {}
  private async row(id: string) {
    idSchema.parse(id);
    const row = await this.env.DB.prepare('SELECT * FROM projects WHERE owner = ? AND id = ?')
      .bind(this.owner, id).first<Row>();
    if (!row) throw new HttpError(404, 'Project not found.');
    return row;
  }
  private async state(key: string): Promise<State> {
    const object = await this.env.BUCKET.get(key);
    if (!object) throw new HttpError(500, 'Saved project is unavailable. Use project recovery.');
    const value = await object.json<State>();
    value.project = validateProject(value.project);
    return value;
  }
  private async put(state: State) {
    const text = JSON.stringify(state);
    if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024)
      throw new HttpError(413, 'Hosted project exceeds 16 MB. Export it and split it into smaller projects.');
    const key = `${this.owner}/projects/${state.project.id}/${crypto.randomUUID()}.json`;
    await this.env.BUCKET.put(key, text, { httpMetadata: { contentType: 'application/json' } });
    return key;
  }
  async list() {
    const rows = await this.env.DB.prepare('SELECT summary FROM projects WHERE owner = ? ORDER BY updated_at DESC')
      .bind(this.owner).all<{summary: string}>();
    return { projects: rows.results.map(row => JSON.parse(row.summary)), errors: [], activeProjectId: await this.active() };
  }
  async read(id: string) { return (await this.state((await this.row(id)).state_key)).project; }
  async create(name: string, id: string = crypto.randomUUID()) {
    return this.import(newProject(id, name), id);
  }
  async import(value: unknown, id: string = crypto.randomUUID()) {
    const project = validateProject({ ...(value as object), id: idSchema.parse(id), revision: 0 });
    const key = await this.put({ project, undo: [], redo: [], receipts: [] });
    const result = await this.env.DB.prepare('INSERT OR IGNORE INTO projects(owner,id,revision,state_key,previous_key,summary,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind(this.owner, id, 0, key, null, JSON.stringify(projectSummary(project)), Date.now()).run();
    if (result.meta.changes !== 1) {
      await this.env.BUCKET.delete(key);
      throw new HttpError(409, 'Project ID already exists.');
    }
    await this.activate(id);
    return project;
  }
  async active(): Promise<string | null> {
    return (await this.env.DB.prepare('SELECT active_project FROM workspaces WHERE owner = ?').bind(this.owner)
      .first<{active_project: string | null}>())?.active_project ?? null;
  }
  async token(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    await this.env.DB.prepare('INSERT OR IGNORE INTO workspaces(owner,token,active_project) VALUES(?,?,NULL)')
      .bind(this.owner, token).run();
    return (await this.env.DB.prepare('SELECT token FROM workspaces WHERE owner = ?').bind(this.owner)
      .first<{token: string}>())!.token;
  }
  async activate(id: string) {
    const project = await this.read(id);
    await this.token();
    await this.env.DB.prepare('UPDATE workspaces SET active_project = ? WHERE owner = ?').bind(id, this.owner).run();
    return project;
  }
  private async mutate(id: string, request: {expectedRevision: number; requestId: string},
    change: (state: State, row: Row) => Promise<void>) {
    idSchema.parse(request.requestId);
    const row = await this.row(id), state = await this.state(row.state_key);
    const priorKeys = new Set([...state.undo, ...state.redo, ...(row.previous_key ? [row.previous_key] : [])]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)));
    const digest = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
    const receipt = state.receipts.find(r => r.id === request.requestId);
    if (receipt) {
      if (receipt.digest !== digest) throw new HttpError(409, 'Request ID already used with different arguments.');
      return { project: state.project, appliedRevision: receipt.revision, replayed: true };
    }
    if (state.project.revision !== request.expectedRevision)
      throw new HttpError(409, `Revision conflict: expected ${request.expectedRevision}, current ${state.project.revision}. Refresh before retrying.`);
    await change(state, row);
    state.undo = state.undo.slice(-20); state.redo = state.redo.slice(-20);
    state.receipts.push({id: request.requestId, digest, revision: state.project.revision});
    state.receipts = state.receipts.slice(-128);
    const key = await this.put(state);
    const result = await this.env.DB.prepare('UPDATE projects SET revision=?,state_key=?,previous_key=?,summary=?,updated_at=? WHERE owner=? AND id=? AND state_key=? AND revision=?')
      .bind(state.project.revision,key,row.state_key,JSON.stringify(projectSummary(state.project)),Date.now(),this.owner,id,row.state_key,row.revision).run();
    if (result.meta.changes !== 1) {
      await this.env.BUCKET.delete(key);
      const latest = await this.state((await this.row(id)).state_key);
      const replay = latest.receipts.find(r => r.id === request.requestId && r.digest === digest);
      if (replay) return {project: latest.project, appliedRevision: replay.revision, replayed: true};
      throw new HttpError(409, 'Project changed during this edit. Refresh before retrying.');
    }
    const retained = new Set([key, row.state_key, ...state.undo, ...state.redo]);
    await Promise.allSettled([...priorKeys].filter(k => !retained.has(k)).map(k => this.env.BUCKET.delete(k)));
    return {project: state.project, appliedRevision: state.project.revision, replayed: false};
  }
  async commit(id: string, input: unknown) {
    const request = transactionSchema.parse(input);
    return this.mutate(id, request, async (state, row) => {
      state.project = applyProjectOperations(state.project, request.operations);
      state.undo.push(row.state_key); state.redo = [];
    });
  }
  async history(id: string, direction: 'undo' | 'redo', request: {expectedRevision: number; requestId: string}) {
    return this.mutate(id, Object.assign({}, request, {direction}), async (state, row) => {
      const key = state[direction].pop();
      if (!key) throw new HttpError(409, `Nothing to ${direction}.`);
      const restored = await this.state(key);
      state[direction === 'undo' ? 'redo' : 'undo'].push(row.state_key);
      state.project = validateProject({...restored.project, revision: state.project.revision + 1});
    });
  }
  async recover(id: string) {
    const row = await this.row(id);
    if (!row.previous_key) throw new HttpError(409, 'No previous save is available.');
    const state = await this.state(row.previous_key);
    state.project = validateProject({...state.project, revision: row.revision + 1});
    state.undo = []; state.redo = []; state.receipts = [];
    const key = await this.put(state);
    const saved = await this.env.DB.prepare('UPDATE projects SET revision=?,state_key=?,previous_key=?,summary=?,updated_at=? WHERE owner=? AND id=? AND state_key=?')
      .bind(state.project.revision,key,row.state_key,JSON.stringify(projectSummary(state.project)),Date.now(),this.owner,id,row.state_key).run();
    if (saved.meta.changes !== 1) { await this.env.BUCKET.delete(key); throw new HttpError(409, 'Project changed during recovery.'); }
    return state.project;
  }
}
