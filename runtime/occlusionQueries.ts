export type OcclusionToken = object;
export const OCCLUSION_QUERY_FRAME_BUDGET = 8;

type QueryApi = {
  ANY_SAMPLES_PASSED_CONSERVATIVE: number;
  QUERY_RESULT_AVAILABLE: number;
  QUERY_RESULT: number;
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery): void;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, parameter: number): unknown;
};

type Record = {
  query: WebGLQuery | null;
  pending: boolean;
  invalid: boolean;
  occluded: boolean;
};

/** Polls and issues a fixed number of native WebGL2 queries per rendered frame. */
export class OcclusionQueries {
  private records = new Map<OcclusionToken, Record>();
  private order: OcclusionToken[] = [];
  private scheduled = new Set<OcclusionToken>();
  private cursor = 0;
  private active: OcclusionToken | null = null;
  private disabled = false;
  private visibleResults = 0;
  private occludedResults = 0;
  private discardedResults = 0;

  constructor(
    private readonly gl: QueryApi,
    private readonly maxRecords = 128,
    private readonly frameBudget = OCCLUSION_QUERY_FRAME_BUDGET,
  ) {}

  get enabled() {
    return !this.disabled;
  }

  willRun(token: OcclusionToken) {
    return !this.disabled && this.scheduled.has(token);
  }

  register(token: OcclusionToken) {
    if (this.disabled || this.records.size >= this.maxRecords || this.records.has(token)) return false;
    this.records.set(token, { query: null, pending: false, invalid: false, occluded: false });
    this.order.push(token);
    return true;
  }

  remove(token: OcclusionToken) {
    const record = this.records.get(token);
    if (!record) return;
    this.delete(record.query);
    this.records.delete(token);
    this.scheduled.delete(token);
    const index = this.order.indexOf(token);
    if (index >= 0) {
      this.order.splice(index, 1);
      if (index < this.cursor) this.cursor--;
      if (this.cursor >= this.order.length) this.cursor = 0;
    }
    if (this.active === token) this.active = null;
  }

  prepare(isVisible?: (token: OcclusionToken) => boolean) {
    this.scheduled.clear();
    if (this.disabled || !this.order.length) return;
    let polled = 0;
    let issued = 0;
    const length = this.order.length;
    // Records are capped; scanning the full ring prevents off-frustum batches from starving visible ones.
    for (let scan = 0; scan < length && (polled < this.frameBudget || issued < this.frameBudget); scan++) {
      const token = this.order[(this.cursor + scan) % length];
      const record = this.records.get(token)!;
      try {
        if (record.pending && polled < this.frameBudget) {
          polled++;
          if (Boolean(this.gl.getQueryParameter(record.query!, this.gl.QUERY_RESULT_AVAILABLE))) {
            const visible = Number(this.gl.getQueryParameter(record.query!, this.gl.QUERY_RESULT)) !== 0;
            record.pending = false;
            if (!record.invalid) {
              record.occluded = !visible;
              if (visible) this.visibleResults++;
              else this.occludedResults++;
            } else this.discardedResults++;
            record.invalid = false;
          }
        } else if (!record.pending && issued < this.frameBudget && (!isVisible || isVisible(token))) {
          record.query ??= this.gl.createQuery();
          if (!record.query) {
            this.disable();
            return;
          }
          this.scheduled.add(token);
          issued++;
        }
      } catch {
        this.disable();
        return;
      }
    }
    this.cursor = (this.cursor + 1) % this.order.length;
  }

  begin(token: OcclusionToken) {
    const record = this.records.get(token);
    if (this.disabled || !record?.query || !this.scheduled.has(token) || this.active) return false;
    try {
      this.gl.beginQuery(this.gl.ANY_SAMPLES_PASSED_CONSERVATIVE, record.query);
      this.active = token;
      this.scheduled.delete(token);
      record.invalid = false;
      return true;
    } catch {
      this.disable();
      return false;
    }
  }

  end(token: OcclusionToken) {
    if (this.active !== token || this.disabled) return;
    try {
      this.gl.endQuery(this.gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      const record = this.records.get(token);
      if (record) record.pending = true;
      this.active = null;
    } catch {
      this.disable();
    }
  }

  isOccluded(token: OcclusionToken) {
    const record = this.records.get(token);
    return !this.disabled && !!record?.occluded && !record.invalid;
  }

  stats() {
    return {
      available: !this.disabled,
      registeredBatches: this.records.size,
      pendingQueries: [...this.records.values()].filter((record) => record.pending).length,
      scheduledQueries: this.scheduled.size,
      occludedBatches: [...this.records.values()].filter((record) => record.occluded && !record.invalid)
        .length,
      visibleResults: this.visibleResults,
      occludedResults: this.occludedResults,
      discardedResults: this.discardedResults,
    };
  }

  invalidate(token?: OcclusionToken) {
    const records = token ? [this.records.get(token)] : this.records.values();
    for (const record of records) {
      if (!record) continue;
      record.occluded = false;
      record.invalid = record.pending;
    }
  }

  contextLost() {
    for (const record of this.records.values()) {
      record.query = null;
      record.pending = false;
      record.invalid = false;
      record.occluded = false;
    }
    this.active = null;
    this.scheduled.clear();
    this.disabled = true;
  }

  contextRestored() {
    this.disabled = false;
    this.invalidate();
  }

  dispose() {
    for (const record of this.records.values()) this.delete(record.query);
    this.records.clear();
    this.order = [];
    this.scheduled.clear();
    this.active = null;
    this.disabled = true;
  }

  private delete(query: WebGLQuery | null) {
    if (!query || this.disabled) return;
    try {
      this.gl.deleteQuery(query);
    } catch {
      this.disabled = true;
    }
  }

  private disable() {
    for (const record of this.records.values()) {
      if (record.query) {
        try {
          this.gl.deleteQuery(record.query);
        } catch {
          // A lost WebGL context invalidates its query handles.
        }
      }
      record.query = null;
      record.pending = false;
      record.invalid = false;
      record.occluded = false;
    }
    this.scheduled.clear();
    this.active = null;
    this.disabled = true;
  }
}
