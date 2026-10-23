import test from 'node:test';
import assert from 'node:assert/strict';
import { localApi } from '../services/localApi';

test('session bootstrap tolerates a brief broker restart without retrying authoring mutations or leaking its token', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: { url: string; init?: RequestInit }[] = [];
  let sessions = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' } },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/session') {
      sessions++;
      return sessions < 3 ? new Response('', { status: 503 }) : Response.json({ token: 'test-session-only' });
    }
    return new Response('', { status: 500 });
  };
  try {
    const response = await localApi('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'One mutation' }),
    });
    assert.equal(response.status, 500);
    assert.equal(sessions, 3);
    assert.equal(calls.filter((c) => c.url === '/api/projects').length, 1);
    assert.equal(new Headers(calls.at(-1)!.init?.headers).get('X-VoxShop-Token'), 'test-session-only');
    await localApi('https://external.example/provider', { method: 'POST', body: '{}' });
    assert.equal(new Headers(calls.at(-1)!.init?.headers).get('X-VoxShop-Token'), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as any).window;
  }
});
