import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createExample } from '../services/examples';
import { buildGame, exportProject } from '../server/gameBuild';
import { applyProjectOperations } from '../services/projectDocument';
test('standalone exports contain only selected scene assets, embedded runtime, safe data and license notices', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxshop-test-export-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'voxshop-test-export-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const kind of ['exploration', 'arena'] as const) {
    let p = createExample(kind, `export-${kind}`);
    p = applyProjectOperations(p, [
      { type: 'asset.variant', sourceId: 'hero', id: 'unused-variant', name: 'Unused' },
      { type: 'project.rename', name: 'Safe </script><img src=x> title' },
    ]);
    const game = exportProject(p, 'main');
    assert.ok(!game.assets.some((a) => a.id === 'unused-variant'));
    assert.ok(game.assets.every((a) => !a.recipe && !a.variantOf && !a.equipment));
    assert.equal(game.editorDraft, null);
    const result = await buildGame(p, 'main', { root: process.cwd(), directory });
    const html = await fs.readFile(result.path, 'utf8');
    assert.equal(result.sha256, createHash('sha256').update(html).digest('hex'));
    assert.equal(result.bytes, Buffer.byteLength(html));
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.match(html, /THE SOFTWARE IS PROVIDED/);
    assert.match(html, /third-party-notices/);
    assert.doesNotMatch(html, /<img src=x>/);
    const embedded = JSON.parse(
      html.match(/<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/)![1],
    );
    assert.deepEqual(embedded, game);
  }
});
