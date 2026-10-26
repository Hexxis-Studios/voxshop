import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputRoot = path.join(projectRoot, '.voxshop', 'game-player');

function slug(value, limit = 32) {
  return (
    String(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, limit)
      .replace(/-+$/g, '') || 'game'
  );
}

export function inspectStandaloneGame(html) {
  const projectMatch = html.match(
    /<script id="voxshop-project" type="application\/json">([\s\S]*?)<\/script>/,
  );
  const workerMatch = html.match(
    /<script id="voxshop-workers" type="application\/json">([\s\S]*?)<\/script>/,
  );
  const inlineRuntime = html.match(/<script>([\s\S]+?)<\/script>/);
  if (!projectMatch || !workerMatch || !inlineRuntime?.[1])
    throw new Error('Input must be a standalone VoxShop game export with embedded data and runtime.');
  if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*\bhref\s*=/i.test(html))
    throw new Error('Standalone game exports must not depend on external scripts or stylesheets.');

  const project = JSON.parse(projectMatch[1]);
  JSON.parse(workerMatch[1]);
  if (
    typeof project.id !== 'string' ||
    typeof project.name !== 'string' ||
    !Number.isSafeInteger(project.revision) ||
    typeof project.activeSceneId !== 'string' ||
    !project.scenes?.some((scene) => scene.id === project.activeSceneId)
  )
    throw new Error('Standalone game export has invalid project identity or no starting scene.');

  const identityHash = createHash('sha256')
    .update(`${project.id}\0${project.activeSceneId}`)
    .digest('hex')
    .slice(0, 10);
  const nameSlug = slug(project.name, 32);
  const sceneSlug = slug(project.activeSceneId, 24);
  const productName = `VoxShop-Game-${nameSlug}-${sceneSlug}-r${project.revision}-${identityHash}`;
  const title = project.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'VoxShop game';

  return {
    projectId: project.id,
    projectName: project.name,
    revision: project.revision,
    sceneId: project.activeSceneId,
    productName,
    identityHash,
    identifier: `com.hexxisstudios.voxshop.game.${identityHash}`,
    windowTitle: title,
  };
}

export async function stageDesktopGame(
  sourceHtmlPath,
  { outputRoot = defaultOutputRoot, playerRoot = path.join(projectRoot, 'desktop', 'game-player') } = {},
) {
  const source = await fs.readFile(path.resolve(sourceHtmlPath), 'utf8');
  const identity = inspectStandaloneGame(source);
  const appDirectory = path.join(path.resolve(outputRoot), identity.productName);
  const frontendDirectory = path.join(appDirectory, 'frontend');
  const frontendFile = path.join(frontendDirectory, 'index.html');
  const configFile = path.join(appDirectory, 'tauri.conf.json');
  await fs.mkdir(frontendDirectory, { recursive: true });
  const temporaryFile = `${frontendFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, source, { mode: 0o600 });
    await fs.rename(temporaryFile, frontendFile);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }

  const window = {
    title: identity.windowTitle,
    url: 'index.html',
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
  };
  const config = {
    productName: identity.productName,
    identifier: identity.identifier,
    app: { windows: [window] },
    // An absolute Windows directory string can deserialize as a URL in Tauri's
    // untagged FrontendDist enum. Embed the single self-contained export instead.
    build: { frontendDist: [frontendFile] },
  };
  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { ...identity, appDirectory, frontendFile, configFile, playerRoot: path.resolve(playerRoot) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sourceHtmlPath = process.argv[2];
  if (!sourceHtmlPath || process.argv.length > 3) {
    console.error('Usage: npm run desktop:game:stage -- <standalone-game.html>');
    process.exitCode = 2;
  } else {
    try {
      const staged = await stageDesktopGame(sourceHtmlPath);
      console.log(`Staged ${staged.productName}: ${staged.frontendFile}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
