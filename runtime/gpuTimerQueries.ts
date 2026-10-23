import { summarizeDurations } from './worldRenderHelpers';

type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
type TimerGl = {
  QUERY_RESULT_AVAILABLE: number;
  QUERY_RESULT: number;
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery): void;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, parameter: number): unknown;
  getParameter(parameter: number): unknown;
  getExtension(name: 'EXT_disjoint_timer_query_webgl2'): TimerExtension | null;
};

const MAXIMUM_SAMPLES = 256;

/** Samples asynchronous WebGL2 GPU elapsed time without blocking on query results. */
export class GpuTimerQueries {
  private readonly extension: TimerExtension | null;
  private query: WebGLQuery | null = null;
  private pending = false;
  private active = false;
  private captureEnabled = false;
  private captureId = 0;
  private pendingCaptureId = 0;
  private disabled = false;
  private disposed = false;
  private samples: number[] = [];
  private disjointSamples = 0;

  constructor(private readonly gl: TimerGl) {
    let extension: TimerExtension | null = null;
    try {
      extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    } catch {
      this.disabled = true;
    }
    this.extension = extension;
  }

  startCapture() {
    if (!this.extension || this.disabled || this.disposed) return false;
    this.samples = [];
    this.disjointSamples = 0;
    this.captureId++;
    this.captureEnabled = true;
    return true;
  }

  stopCapture() {
    this.captureEnabled = false;
  }

  /** Starts a timer only after the previous result is available; otherwise the frame is skipped. */
  begin() {
    const extension = this.extension;
    if (!extension || this.disabled || this.disposed || this.active) return false;
    if (!this.captureEnabled) return false;
    try {
      if (this.pollPending(extension)) return false;
      if (this.pending) return false;
      if (Boolean(this.gl.getParameter(extension.GPU_DISJOINT_EXT))) {
        this.samples = [];
        this.disjointSamples++;
        return false;
      }
      this.query ??= this.gl.createQuery();
      if (!this.query) {
        this.disable();
        return false;
      }
      this.gl.beginQuery(extension.TIME_ELAPSED_EXT, this.query);
      this.active = true;
      this.pendingCaptureId = this.captureId;
      return true;
    } catch {
      this.disable();
      return false;
    }
  }

  end() {
    if (!this.active || !this.extension || this.disabled || this.disposed) return;
    try {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.active = false;
      this.pending = true;
    } catch {
      this.disable();
    }
  }

  stats() {
    const summary = summarizeDurations(this.samples);
    return {
      supported: Boolean(this.extension) && !this.disabled && !this.disposed,
      sampleCount: summary.count,
      lastMs: this.samples.at(-1) ?? null,
      p50Ms: summary.count ? summary.p50Ms : null,
      p95Ms: summary.count ? summary.p95Ms : null,
      maxMs: summary.count ? summary.maxMs : null,
      pending: this.pending,
      capturing: this.captureEnabled,
      disjointSamples: this.disjointSamples,
    };
  }

  dispose() {
    this.disposed = true;
    this.pending = false;
    this.active = false;
    this.deleteQuery();
    this.samples = [];
    this.captureEnabled = false;
  }

  private pollPending(extension: TimerExtension) {
    if (!this.pending || !this.query) return false;
    if (Boolean(this.gl.getParameter(extension.GPU_DISJOINT_EXT))) {
      this.pending = false;
      if (this.pendingCaptureId === this.captureId) {
        this.samples = [];
        this.disjointSamples++;
      }
      return true;
    }
    if (!Boolean(this.gl.getQueryParameter(this.query, this.gl.QUERY_RESULT_AVAILABLE))) return false;
    const nanoseconds = Number(this.gl.getQueryParameter(this.query, this.gl.QUERY_RESULT));
    this.pending = false;
    if (this.pendingCaptureId !== this.captureId || !Number.isFinite(nanoseconds) || nanoseconds < 0)
      return false;
    this.samples.push(nanoseconds / 1_000_000);
    if (this.samples.length > MAXIMUM_SAMPLES) this.samples.shift();
    return false;
  }

  private deleteQuery() {
    if (!this.query) return;
    try {
      this.gl.deleteQuery(this.query);
    } catch {
      // Context loss invalidates the query handle; disposal still completes.
    }
    this.query = null;
  }

  private disable() {
    this.disabled = true;
    this.active = false;
    this.pending = false;
    this.deleteQuery();
  }
}
