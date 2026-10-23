import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGame } from '../server/gameBuild';
import { ProjectStore } from '../server/projectStore';
import { applyProjectOperations, newProject } from '../services/projectDocument';
import { migrateLegacyProject } from '../services/legacyProjectMigration';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

test('legacy browser-library migration creates one project transaction and keeps the old data intact', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  const project = newProject('legacy-project', 'Imported library');
  const originalBuilds = JSON.stringify([
    { name: 'Generated prop', data: [{ x: 0, y: 0, z: 0, color: 0xff0000 }] },
  ]);
  const originalRebuilds = '{ malformed legacy JSON';
  const originalObjects = JSON.stringify([
    { name: 'Placed prop', data: [{ x: 1, y: 0, z: 0, color: 0x00ff00 }], offsetX: 2, offsetZ: -1 },
    { name: 'Centered prop', data: [{ x: 0, y: 1, z: 0, color: 0x0000ff }] },
  ]);
  storage.setItem('voxelBuilderCustomBuilds', originalBuilds);
  storage.setItem('voxelBuilderCustomRebuilds', originalRebuilds);
  storage.setItem('voxelBuilderSceneObjects', originalObjects);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' } },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  let transaction: any;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/session') return Response.json({ token: 'test-session' });
    if (url === `/api/projects/${project.id}/transactions`) {
      transaction = JSON.parse(String(init?.body));
      return Response.json({ project: applyProjectOperations(project, transaction.operations) });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await migrateLegacyProject(project);
    assert.ok(result);
    assert.ok(result.project);
    assert.equal(result.importedCount, 3);
    assert.equal(result.skipped, 1);
    assert.equal(transaction.expectedRevision, project.revision);
    assert.equal(transaction.operations.filter((operation: any) => operation.type === 'asset.put').length, 3);
    assert.deepEqual(
      result.project.scenes[0].nodes.map((node) => node.transform.position),
      [
        [0.2, 0, -0.1],
        [0, 0, 0],
      ],
    );
    assert.equal(storage.getItem('voxshop-project-migration-v1'), project.id);
    assert.equal(storage.getItem('voxelBuilderCustomBuilds'), originalBuilds);
    assert.equal(storage.getItem('voxelBuilderCustomRebuilds'), originalRebuilds);
    assert.equal(storage.getItem('voxelBuilderSceneObjects'), originalObjects);
    assert.equal(await migrateLegacyProject(result.project), null);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-legacy-roundtrip-'));
    try {
      const store = new ProjectStore(path.join(directory, 'projects'));
      await store.import(result.project, result.project.id);
      const saved = await store.read(result.project.id);
      assert.deepEqual(
        saved.assets.map((asset) => asset.name),
        ['Generated prop', 'Placed prop', 'Centered prop'],
      );
      assert.deepEqual(
        saved.scenes[0].nodes.map((node) => node.transform.position),
        [
          [0.2, 0, -0.1],
          [0, 0, 0],
        ],
      );

      const outputDirectory = path.join(directory, 'exports');
      const build = await buildGame(saved, 'main', {
        root: process.cwd(),
        directory: outputDirectory,
      });
      const html = await fs.readFile(build.path, 'utf8');
      const embeddedProject = html.match(
        /<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script><script id="voxshop-workers"/,
      );
      assert.ok(embeddedProject, 'The standalone game embeds the migrated scene document.');
      const exported = JSON.parse(embeddedProject[1]);
      assert.deepEqual(
        exported.scenes[0].nodes.map((node: any) => node.transform.position),
        [
          [0.2, 0, -0.1],
          [0, 0, 0],
        ],
      );
      assert.equal(exported.assets.length, 2, 'The game includes both placed legacy assets.');
      assert.ok(exported.assets.every((asset: any) => asset.model.voxels.length === 1));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as any).window;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as any).localStorage;
  }
});

test('malformed legacy storage remains intact and retryable when no records can be imported', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  const project = newProject('legacy-retry', 'Retry legacy import');
  const malformed = '{ malformed legacy JSON';
  storage.setItem('voxelBuilderCustomBuilds', malformed);
  storage.setItem('voxelBuilderCustomRebuilds', '[]');
  storage.setItem('voxelBuilderSceneObjects', '[]');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  try {
    const result = await migrateLegacyProject(project);
    assert.ok(result);
    assert.equal(result.project, null);
    assert.equal(result.importedCount, 0);
    assert.equal(result.skipped, 1);
    assert.equal(storage.getItem('voxshop-project-migration-v1'), null);
    assert.equal(storage.getItem('voxelBuilderCustomBuilds'), malformed);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as any).localStorage;
  }
});
