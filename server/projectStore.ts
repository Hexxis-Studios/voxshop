import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  applyProjectOperations,
  idSchema,
  newProject,
  projectSummary,
  transactionSchema,
  validateProject,
  type ProjectDocument,
} from '../services/projectDocument';

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Receipt = { id: string; digest: string; revision: number };
type State = {
  project: ProjectDocument;
  undo: ProjectDocument[];
  redo: ProjectDocument[];
  receipts: Receipt[];
};
export type CommitResult = { project: ProjectDocument; appliedRevision: number; replayed: boolean };
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** All writers, including MCP clients, go through this single local broker. */
export class ProjectStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  private filename(id: string) {
    return path.join(this.directory, `${idSchema.parse(id)}.json`);
  }
  private async atomic(filename: string, value: unknown) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temp, filename);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  private async load(id: string): Promise<State> {
    const file = this.filename(id);
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as State;
      state.project = validateProject(state.project);
      if (state.project.id !== id) throw new Error('Project identity does not match its file.');
      if (!Array.isArray(state.undo) || !Array.isArray(state.redo) || !Array.isArray(state.receipts))
        throw new Error('Invalid history.');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ServiceError(404, `Project ${id} does not exist.`);
      // Never silently roll back a corrupt file. Keep the backup available for explicit recovery.
      throw new ServiceError(
        500,
        `Project ${id} cannot be read. Its previous save is available through project recovery.`,
      );
    }
  }
  private async save(state: State) {
    const filename = this.filename(state.project.id);
    // Both files are written atomically. A failed replacement leaves the last committed project intact.
    try {
      const previous = JSON.parse(await fs.readFile(filename, 'utf8'));
      await this.atomic(`${filename}.bak`, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.atomic(filename, state);
  }
  async list() {
    return this.serial(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const files = (await fs.readdir(this.directory)).filter((f) =>
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(f),
      );
      const projects: ReturnType<typeof projectSummary>[] = [];
      const errors: { id: string; error: string }[] = [];
      for (const file of files) {
        const id = file.slice(0, -5);
        try {
          projects.push(projectSummary((await this.load(id)).project));
        } catch (e) {
          errors.push({ id, error: (e as Error).message });
        }
      }
      return { projects, errors };
    });
  }
  async read(id: string) {
    return this.serial(async () => structuredClone((await this.load(id)).project));
  }
  async create(name: string, id: string = randomUUID()) {
    return this.serial(async () => {
      const project = newProject(id, name);
      try {
        await fs.access(this.filename(id));
        throw new ServiceError(409, 'Project ID already exists.');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await this.save({ project, undo: [], redo: [], receipts: [] });
      return project;
    });
  }
  async import(value: unknown, id: string = randomUUID()) {
    const project = validateProject({ ...(value as object), id: idSchema.parse(id), revision: 0 });
    return this.serial(async () => {
      try {
        await fs.access(this.filename(id));
        throw new ServiceError(409, 'Import requires a new project ID.');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await this.save({ project, undo: [], redo: [], receipts: [] });
      return project;
    });
  }
  async commit(id: string, input: unknown, signal?: AbortSignal): Promise<CommitResult> {
    const transaction = transactionSchema.parse(input);
    return this.mutate(
      id,
      transaction,
      (state) => {
        const project = applyProjectOperations(state.project, transaction.operations);
        state.undo.push(state.project);
        state.redo = [];
        state.project = project;
      },
      signal,
    );
  }
  async history(
    id: string,
    direction: 'undo' | 'redo',
    input: { expectedRevision: number; requestId: string },
  ) {
    idSchema.parse(input.requestId);
    const request = { ...input, direction };
    return this.mutate(id, request, (state) => {
      const source = state[direction],
        target = state[direction === 'undo' ? 'redo' : 'undo'];
      const restored = source.pop();
      if (!restored) throw new ServiceError(409, `Nothing to ${direction}.`);
      target.push(state.project);
      state.project = validateProject({ ...restored, revision: state.project.revision + 1 });
    });
  }
  private async mutate(
    id: string,
    request: { expectedRevision: number; requestId: string },
    change: (state: State) => void,
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    return this.serial(async () => {
      const state = await this.load(id);
      signal?.throwIfAborted();
      const digest = hash(request);
      const receipt = state.receipts.find((r) => r.id === request.requestId);
      if (receipt) {
        if (receipt.digest !== digest)
          throw new ServiceError(409, 'Request ID already used with different arguments.');
        return { project: structuredClone(state.project), appliedRevision: receipt.revision, replayed: true };
      }
      if (request.expectedRevision !== state.project.revision)
        throw new ServiceError(
          409,
          `Revision conflict: expected ${request.expectedRevision}, current ${state.project.revision}. Refresh before retrying.`,
        );
      change(state);
      signal?.throwIfAborted();
      state.receipts.push({ id: request.requestId, digest, revision: state.project.revision });
      state.receipts = state.receipts.slice(-128);
      // Bounded history by count and serialized size, keeping the current document independent.
      state.undo = state.undo.slice(-20);
      state.redo = state.redo.slice(-20);
      while (
        Buffer.byteLength(JSON.stringify([state.undo, state.redo])) > 32 * 1024 * 1024 &&
        state.undo.length + state.redo.length
      ) {
        if (state.undo.length >= state.redo.length) state.undo.shift();
        else state.redo.shift();
      }
      await this.save(state);
      return {
        project: structuredClone(state.project),
        appliedRevision: state.project.revision,
        replayed: false,
      };
    });
  }
  async recover(id: string) {
    return this.serial(async () => {
      const filename = this.filename(id);
      const backup = JSON.parse(await fs.readFile(`${filename}.bak`, 'utf8')) as State;
      backup.project = validateProject(backup.project);
      if (backup.project.id !== id)
        throw new ServiceError(400, 'Recovery backup belongs to a different project.');
      // Recovery is a new commit, never a return to an old revision visible to stale clients.
      backup.project.revision = Math.max(Date.now(), backup.project.revision + 1);
      backup.undo = [];
      backup.redo = [];
      backup.receipts = [];
      // Preserve the damaged/latest file before the explicit recovery operation.
      try {
        await fs.copyFile(filename, `${filename}.replaced-${Date.now()}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await this.atomic(filename, backup);
      return backup.project;
    });
  }
}
