import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuTimerQueries } from '../runtime/gpuTimerQueries';

type FakeQuery = { available: boolean; result: number };

function fakeGl() {
  const queries: FakeQuery[] = [];
  const calls = { begins: 0, ends: 0, deletes: 0, availabilityChecks: 0, resultReads: 0 };
  let disjoint = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    createQuery() {
      const query = { available: false, result: 0 };
      queries.push(query);
      return query as FakeQuery as WebGLQuery;
    },
    deleteQuery() {
      calls.deletes++;
    },
    beginQuery() {
      calls.begins++;
    },
    endQuery() {
      calls.ends++;
    },
    getQueryParameter(query: WebGLQuery, parameter: number) {
      const value = query as unknown as FakeQuery;
      if (parameter === 1) {
        calls.availabilityChecks++;
        return value.available;
      }
      calls.resultReads++;
      assert.equal(value.available, true, 'GPU results are read only after asynchronous availability.');
      return value.result;
    },
    getParameter() {
      return disjoint;
    },
    getExtension(name: string) {
      assert.equal(name, 'EXT_disjoint_timer_query_webgl2');
      return { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 };
    },
    setDisjoint(value: boolean) {
      disjoint = value;
    },
  };
  return { gl, calls, queries };
}

test('GPU timing polls asynchronously, reports elapsed milliseconds and discards disjoint samples', () => {
  const { gl, calls, queries } = fakeGl();
  const timer = new GpuTimerQueries(gl);
  assert.equal(timer.begin(), false, 'GPU queries stay inactive outside a requested measurement.');
  assert.equal(timer.startCapture(), true);
  assert.equal(timer.begin(), true);
  timer.end();
  assert.equal(timer.stats().pending, true);

  assert.equal(timer.begin(), false, 'an unavailable query skips sampling without blocking or reusing it');
  assert.equal(calls.resultReads, 0);
  queries[0].available = true;
  queries[0].result = 5_500_000;
  assert.equal(timer.begin(), true, 'a completed query is consumed before a new interval starts');
  assert.deepEqual(timer.stats(), {
    supported: true,
    sampleCount: 1,
    lastMs: 5.5,
    p50Ms: 5.5,
    p95Ms: 5.5,
    maxMs: 5.5,
    pending: false,
    capturing: true,
    disjointSamples: 0,
  });
  timer.end();

  queries[0].available = false;
  gl.setDisjoint(true);
  assert.equal(timer.begin(), false, 'disjoint GPU timing is discarded');
  assert.equal(timer.stats().sampleCount, 0);
  assert.equal(timer.stats().disjointSamples, 1);
  gl.setDisjoint(false);

  assert.deepEqual([calls.begins, calls.ends, calls.availabilityChecks, calls.resultReads], [2, 2, 2, 1]);
  timer.dispose();
  assert.equal(calls.deletes, 1);
  assert.equal(timer.stats().supported, false);
});

test('GPU timer avoids render-loop polling outside capture and drops late results from an older capture', () => {
  const { gl, calls, queries } = fakeGl();
  const timer = new GpuTimerQueries(gl);
  timer.startCapture();
  assert.equal(timer.begin(), true);
  timer.end();
  timer.stopCapture();
  const availabilityChecks = calls.availabilityChecks;
  assert.equal(timer.begin(), false);
  assert.equal(calls.availabilityChecks, availabilityChecks);

  queries[0].available = true;
  queries[0].result = 99_000_000;
  timer.startCapture();
  assert.equal(timer.begin(), true, 'the prior result is discarded before the new interval begins');
  assert.equal(timer.stats().sampleCount, 0);
  assert.equal(calls.resultReads, 1);
  timer.end();
  timer.dispose();
});

test('GPU timer support is optional and query failures disable instrumentation safely', () => {
  const unsupportedGl = {
    ...fakeGl().gl,
    getExtension: () => null,
  };
  const unsupported = new GpuTimerQueries(unsupportedGl);
  assert.equal(unsupported.begin(), false);
  assert.equal(unsupported.stats().supported, false);
  unsupported.dispose();

  const brokenGl = {
    ...fakeGl().gl,
    getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
    createQuery: () => {
      throw new Error('context lost');
    },
  };
  const broken = new GpuTimerQueries(brokenGl);
  broken.startCapture();
  assert.equal(broken.begin(), false);
  assert.equal(broken.stats().supported, false);
  broken.dispose();
});
