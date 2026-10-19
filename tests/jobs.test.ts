import test from 'node:test';
import assert from 'node:assert/strict';
import { Jobs } from '../server/jobs';
test('cancelling a queued job prevents its operation and late running results cannot resurrect a cancelled job', async () => {
  const jobs = new Jobs();
  let calls = 0;
  const queued = jobs.start('queued', async () => {
    calls++;
    return 'unexpected';
  });
  jobs.cancel(queued.id);
  let finish: (value: string) => void = () => {};
  const running = jobs.start('running', async () => {
    calls++;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  jobs.cancel(running.id);
  finish('late');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.read(queued.id).status, 'cancelled');
  assert.equal(jobs.read(running.id).status, 'cancelled');
  assert.equal(jobs.read(running.id).result, undefined);
});
