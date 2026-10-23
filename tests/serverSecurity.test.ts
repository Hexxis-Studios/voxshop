import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';

test('local broker binds session bootstrap to loopback host/origin and protects project routes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxshop-broker-security-'));
  const service = await createApp({
    root: process.cwd(),
    dataDir,
    port: 4269,
    clientPort: 3000,
    token: 'a'.repeat(64),
  });
  const server = service.app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;

    const localBootstrap = await fetch(`${base}/api/session`);
    assert.equal(localBootstrap.status, 200);
    assert.equal((await localBootstrap.json()).token, 'a'.repeat(64));

    const samePortOrigin = await fetch(`${base}/api/session`, {
      headers: { Origin: base },
    });
    assert.equal(samePortOrigin.status, 200);
    assert.equal(samePortOrigin.headers.get('access-control-allow-origin'), base);

    const unconfiguredLoopbackPort = await fetch(`${base}/api/session`, {
      headers: { Origin: `http://127.0.0.1:${address.port + 1}` },
    });
    assert.equal(unconfiguredLoopbackPort.status, 403);

    const allowedOrigin = await fetch(`${base}/api/session`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(allowedOrigin.status, 200);
    assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://localhost:3000');

    const preferencePreflight = await fetch(`${base}/api/preferences/frame-pacing`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,x-voxshop-token',
      },
    });
    assert.equal(preferencePreflight.status, 204);
    assert.match(preferencePreflight.headers.get('access-control-allow-methods') ?? '', /\bPUT\b/);

    const hostileOrigin = await fetch(`${base}/api/session`, {
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(hostileOrigin.status, 403);

    const crossSiteBootstrap = await fetch(`${base}/api/session`, {
      headers: {
        Origin: 'http://localhost:3000',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(crossSiteBootstrap.status, 403);

    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(base, {
        path: '/api/session',
        headers: { Host: `attacker.example:${address.port}` },
      });
      request.on('response', (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(hostileHostStatus, 403);

    const missingToken = await fetch(`${base}/api/projects`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(missingToken.status, 401);

    const authorized = await fetch(`${base}/api/projects`, {
      headers: {
        Origin: 'http://localhost:3000',
        'X-VoxShop-Token': 'a'.repeat(64),
      },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('viewport event streams record only configured or same-port loopback client origins', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxshop-viewport-origin-'));
  const token = 'b'.repeat(64);
  const service = await createApp({ root: process.cwd(), dataDir, port: 0, token });
  const server = service.app.listen(0, '127.0.0.1');
  const streams: Response[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const openStream = async (clientId: string, clientOrigin: string, origin?: string) => {
      const headers = new Headers({ 'X-VoxShop-Token': token });
      if (origin) headers.set('Origin', origin);
      const response = await fetch(
        `${base}/api/events?clientId=${clientId}&clientOrigin=${encodeURIComponent(clientOrigin)}`,
        { headers },
      );
      streams.push(response);
      return response;
    };

    const accepted = await openStream('same-port-editor', base);
    assert.equal(accepted.status, 200);
    const invalidMetadata = await openStream('foreign-query-editor', 'https://attacker.example');
    assert.equal(invalidMetadata.status, 200);
    const rejectedHeader = await fetch(
      `${base}/api/events?clientId=foreign-header-editor&clientOrigin=${encodeURIComponent(base)}`,
      {
        headers: {
          Origin: 'https://attacker.example',
          'X-VoxShop-Token': token,
        },
      },
    );
    assert.equal(rejectedHeader.status, 403);

    const clientsResponse = await fetch(`${base}/api/viewport/`, {
      headers: { 'X-VoxShop-Token': token },
    });
    assert.equal(clientsResponse.status, 200);
    assert.deepEqual((await clientsResponse.json()).clients, [
      { id: 'same-port-editor', origin: base },
      { id: 'foreign-query-editor' },
    ]);
  } finally {
    await Promise.all(streams.map((response) => response.body?.cancel()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dataDir, { recursive: true, force: true });
  }
});
