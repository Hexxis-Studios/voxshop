import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectDocument } from '../services/projectDocument';
import { exportProject, renderGameHtml } from '../runtime/gameExport';
export { exportProject } from '../runtime/gameExport';
import { createHash, randomUUID } from 'node:crypto';
export async function buildGame(
  project: ProjectDocument,
  sceneId: string,
  options: { root: string; directory: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const game = exportProject(project, sceneId);
  const runtime = await fs.readFile(path.join(options.root, 'dist', 'runtime.js'), 'utf8').catch(() => {
    throw new Error('Runtime bundle is missing. Run npm run build before exporting games.');
  });
  const notices = await fs.readFile(path.join(options.root, 'node_modules', 'three', 'LICENSE'), 'utf8');
  const artifact = renderGameHtml(project, sceneId, runtime, notices);
  signal?.throwIfAborted();
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const filename = `${game.id}-${sceneId}-r${game.revision}.html`;
  const output = path.join(options.directory, filename);
  const temporary = output + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, artifact, { mode: 0o600 });
  await fs.rename(temporary, output);
  return {
    projectId: game.id,
    revision: game.revision,
    sceneId,
    filename,
    path: output,
    bytes: Buffer.byteLength(artifact),
    sha256: createHash('sha256').update(artifact).digest('hex'),
    assets: game.assets.length,
    voxels: game.assets.reduce((n, a) => n + a.model.voxels.length, 0),
    requirements:
      'A desktop browser with WebGL2. Open the HTML directly or host it as a static file. No services, credentials, AI or network dependencies.',
  };
}
