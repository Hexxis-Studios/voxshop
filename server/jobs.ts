import { randomUUID } from 'node:crypto';
export type Job = {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  result?: unknown;
  error?: string;
  createdAt: number;
};
export class Jobs {
  private jobs = new Map<string, { job: Job; controller: AbortController }>();
  private prune() {
    const old = [...this.jobs.values()]
      .filter((v) => ['completed', 'failed', 'cancelled'].includes(v.job.status))
      .sort((a, b) => a.job.createdAt - b.job.createdAt);
    for (const entry of old.slice(0, Math.max(0, old.length - 64))) this.jobs.delete(entry.job.id);
  }
  start(kind: string, run: (signal: AbortSignal, progress: (n: number) => void) => Promise<unknown>): Job {
    if (
      [...this.jobs.values()].filter((v) => v.job.status === 'running' || v.job.status === 'queued').length >=
      8
    )
      throw new Error('Eight jobs are already active.');
    const job: Job = { id: randomUUID(), kind, status: 'queued', progress: 0, createdAt: Date.now() };
    const controller = new AbortController();
    this.jobs.set(job.id, { job, controller });
    setImmediate(async () => {
      if (controller.signal.aborted) return;
      job.status = 'running';
      try {
        const result = await run(controller.signal, (n) => {
          job.progress = Math.max(0, Math.min(1, n));
        });
        if (!controller.signal.aborted) {
          job.result = result;
          job.progress = 1;
          job.status = 'completed';
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          job.status = 'failed';
          job.error = (e as Error).message;
        }
      }
      this.prune();
    });
    return structuredClone(job);
  }
  read(id: string) {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error('Job not found.');
    return structuredClone(entry.job);
  }
  cancel(id: string) {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error('Job not found.');
    if (['queued', 'running'].includes(entry.job.status)) {
      entry.controller.abort();
      entry.job.status = 'cancelled';
    }
    const result = this.read(id);
    this.prune();
    return result;
  }
}
