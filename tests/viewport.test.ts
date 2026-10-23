import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewportBridge } from '../server/viewport';
import { viewportCommandSchema } from '../services/viewportProtocol';
import type { ViewportRequest } from '../services/viewportProtocol';

// Protocol fixture only. This PNG is not evidence of rendered visual acceptance.
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const request = { projectId: 'game', expectedRevision: 4, command: { type: 'capture' as const } };
test('visual requests match one editor and exact project revision, reject competing requests and stale responses', async () => {
  const bridge = new ViewportBridge(1000);
  let delivered!: ViewportRequest;
  const disconnect = bridge.connect('editor', (value) => {
    delivered = value;
  });
  assert.throws(() => bridge.connect('editor', () => {}), /already registered/);
  const result = bridge.request(request);
  assert.equal(delivered.projectId, 'game');
  assert.throws(() => bridge.request(request), /current viewport command/);
  assert.throws(() => bridge.respond({ ...delivered, revision: 3, image }), /does not match/);
  assert.throws(
    () => bridge.respond({ ...delivered, revision: 4, clientId: 'other', image }),
    /does not match/,
  );
  assert.throws(() => bridge.respond({ ...delivered, revision: 4 }), /rendered PNG/);
  assert.throws(
    () => bridge.respond({ ...delivered, revision: 4, image: 'data:image/png;base64,bm90LWFuLWltYWdl' }),
    /Expected PNG image data/,
  );
  bridge.respond({ ...delivered, revision: 4, image, observation: { render: { calls: 1 } } });
  assert.equal(((await result) as any).image, image);
  assert.throws(() => bridge.respond({ ...delivered, revision: 4, image }), /no longer active/);
  disconnect();
  assert.equal(bridge.list().length, 0);
  assert.throws(() => bridge.request(request), /Open the local/);
});
test('visual inspection releases disconnected, failed and timed out commands; malformed walkthrough inputs are rejected', async () => {
  const bridge = new ViewportBridge(10);
  let delivered!: ViewportRequest;
  const disconnect = bridge.connect('editor', (value) => {
    delivered = value;
  });
  const dropped = bridge.request(request);
  disconnect();
  await assert.rejects(dropped, /disconnected/);
  const remove = bridge.connect('second', (value) => {
    delivered = value;
  });
  const failed = bridge.request(request);
  bridge.respond({ ...delivered, revision: 4, error: 'Manual sculpt is unsaved.' });
  await assert.rejects(failed, /Manual sculpt/);
  assert.throws(() => bridge.request({ ...request, command: { type: 'step', frames: 601, input: {} } }));
  assert.throws(() => bridge.request({ ...request, command: { type: 'benchmark', frames: 301 } }));
  assert.throws(() => bridge.request({ ...request, command: { type: 'benchmark', frames: 0 } }));
  assert.deepEqual(
    viewportCommandSchema.parse({
      type: 'benchmark',
      frames: 30,
      occlusionCullingEnabled: false,
    }),
    { type: 'benchmark', frames: 30, occlusionCullingEnabled: false },
  );
  assert.throws(() =>
    viewportCommandSchema.parse({ type: 'benchmark', frames: 30, occlusionCullingEnabled: 'off' }),
  );
  assert.throws(() =>
    bridge.request({
      ...request,
      command: {
        type: 'sequence',
        steps: [
          { frames: 600, input: {} },
          { frames: 1, input: {} },
        ],
      },
    }),
  );
  assert.throws(() =>
    bridge.request({ ...request, command: { type: 'camera', position: [NaN, 0, 0], target: [0, 0, 0] } }),
  );
  await assert.rejects(bridge.request(request), /did not complete/);
  remove();
});
test('broker rejects stale rendered identity even when the editor echoes the requested envelope', async () => {
  const bridge = new ViewportBridge(1000);
  let delivered!: ViewportRequest;
  const disconnect = bridge.connect('editor', (value) => {
    delivered = value;
  });
  for (const observation of [
    { projectId: 'game', revision: 3 },
    { projectId: 'other-game', revision: 4 },
  ]) {
    const result = bridge.request(request);
    bridge.respond({ ...delivered, revision: 4, image, observation });
    await assert.rejects(result, /rendered viewport does not match/);
  }
  const result = bridge.request(request);
  bridge.respond({ ...delivered, revision: 4, image, observation: { projectId: 'game', revision: 4 } });
  assert.equal(((await result) as any).observation.revision, 4);
  disconnect();
});
test('walkthrough Play steps accept one terrain action and reject conflicting place/remove inputs', () => {
  assert.deepEqual(viewportCommandSchema.parse({ type: 'step', frames: 1, input: { placeCell: true } }), {
    type: 'step',
    frames: 1,
    input: { placeCell: true },
  });
  assert.throws(() =>
    viewportCommandSchema.parse({ type: 'step', frames: 1, input: { placeCell: true, removeCell: true } }),
  );
  assert.throws(() =>
    viewportCommandSchema.parse({
      type: 'sequence',
      steps: [{ frames: 1, input: { placeCell: true, removeCell: true } }],
    }),
  );
  assert.throws(() =>
    viewportCommandSchema.parse({ type: 'step', frames: 601, input: { removeCell: true } }),
  );
});

test('viewport Play input accepts a stable usable-item ID', () => {
  assert.deepEqual(viewportCommandSchema.parse({ type: 'step', frames: 1, input: { useItem: 'medkit' } }), {
    type: 'step',
    frames: 1,
    input: { useItem: 'medkit' },
  });
  assert.throws(() =>
    viewportCommandSchema.parse({ type: 'step', frames: 1, input: { useItem: 'not an item id' } }),
  );
  assert.deepEqual(viewportCommandSchema.parse({ type: 'step', frames: 3, input: { togglePause: true } }), {
    type: 'step',
    frames: 3,
    input: { togglePause: true },
  });
});

test('viewport Play input accepts held sprint for running animation and speed checks', () => {
  assert.deepEqual(viewportCommandSchema.parse({ type: 'step', frames: 3, input: { moveZ: -1, sprint: true } }), {
    type: 'step',
    frames: 3,
    input: { moveZ: -1, sprint: true },
  });
});

test('viewport Play input selects an authored HUD tab using stable group and page IDs', () => {
  assert.deepEqual(
    viewportCommandSchema.parse({
      type: 'step',
      frames: 1,
      input: { uiTab: { groupId: 'main-menu', tabId: 'settings' } },
    }),
    {
      type: 'step',
      frames: 1,
      input: { uiTab: { groupId: 'main-menu', tabId: 'settings' } },
    },
  );
  assert.throws(() =>
    viewportCommandSchema.parse({
      type: 'step',
      frames: 1,
      input: { uiTab: { groupId: 'main-menu', tabId: 'invalid tab' } },
    }),
  );
});

test('physics-query commands validate bounded ray, box, sphere and capsule probes', () => {
  const command = viewportCommandSchema.parse({
    type: 'physics-query',
    queries: [
      { shape: 'ray', origin: [0, 2, 0], direction: [1, 0, 0], maxDistance: 20 },
      {
        shape: 'shape-cast',
        castShape: { shape: 'sphere', radius: 0.25 },
        position: [0, 2, 0],
        direction: [1, 0, 0],
        maxDistance: 20,
      },
      {
        shape: 'shape-cast',
        castShape: { shape: 'box', size: [1, 1, 1] },
        position: [0, 2, 0],
        direction: [1, 0, 0],
        maxDistance: 20,
      },
      {
        shape: 'shape-cast',
        castShape: { shape: 'capsule', radius: 0.25, halfHeight: 0.5 },
        position: [0, 2, 0],
        direction: [1, 0, 0],
        maxDistance: 20,
      },
      { shape: 'box', position: [0, 2, 0], size: [2, 2, 2] },
      { shape: 'sphere', position: [0, 2, 0], radius: 1 },
      { shape: 'capsule', position: [0, 2, 0], radius: 0.5, halfHeight: 1 },
    ],
  });
  assert.equal(command.type, 'physics-query');
  if (command.type === 'physics-query') {
    assert.equal(command.queries.length, 7);
    assert.deepEqual(command.queries[0], {
      shape: 'ray',
      origin: [0, 2, 0],
      direction: [1, 0, 0],
      maxDistance: 20,
      includeSensors: false,
      excludeNodeIds: [],
    });
    assert.deepEqual(command.queries[4].shape === 'box' && command.queries[4].rotation, [0, 0, 0, 1]);
    assert.deepEqual(command.queries[1].shape === 'shape-cast' && command.queries[1].castShape, {
      shape: 'sphere',
      radius: 0.25,
    });
    assert.deepEqual(command.queries[2].shape === 'shape-cast' && command.queries[2].castShape, {
      shape: 'box',
      size: [1, 1, 1],
      rotation: [0, 0, 0, 1],
    });
    assert.deepEqual(command.queries[3].shape === 'shape-cast' && command.queries[3].castShape, {
      shape: 'capsule',
      radius: 0.25,
      halfHeight: 0.5,
      rotation: [0, 0, 0, 1],
    });
  }
  assert.throws(() =>
    viewportCommandSchema.parse({
      type: 'physics-query',
      queries: [{ shape: 'ray', origin: [0, 0, 0], direction: [0, 0, 0], maxDistance: 10 }],
    }),
  );
  assert.throws(() =>
    viewportCommandSchema.parse({
      type: 'physics-query',
      queries: [
        {
          shape: 'shape-cast',
          castShape: { shape: 'sphere', radius: 0.5 },
          position: [0, 0, 0],
          direction: [0, 0, 0],
          maxDistance: 10,
        },
      ],
    }),
  );
  assert.throws(() =>
    viewportCommandSchema.parse({
      type: 'physics-query',
      queries: [{ shape: 'box', position: [0, 0, 0], size: [1, 0, 1] }],
    }),
  );
  assert.throws(() =>
    viewportCommandSchema.parse({
      type: 'physics-query',
      queries: Array.from({ length: 17 }, () => ({
        shape: 'sphere',
        position: [0, 0, 0],
        radius: 1,
      })),
    }),
  );
});
