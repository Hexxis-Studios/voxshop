import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_NATIVE_GAME_BYTES = 128 * 1024 * 1024;
const TRAILER_MAGIC = Buffer.from('VOXGAME1', 'ascii');
const TRAILER_VERSION = 1;
const TRAILER_BYTES = 56;
const PROJECT_MARKER = '<script id="voxshop-project" type="application/json">';
const WORKER_MARKER = '<script id="voxshop-workers" type="application/json">';
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  'worker-src blob:',
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data:',
  'connect-src wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*',
  "font-src 'none'",
];

type StandaloneIdentity = {
  projectId: string;
  projectName: string;
  revision: number;
  sceneId: string;
};

function embeddedJson(html: string, marker: string) {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('Input is not a self-contained VoxShop game export.');
  const contentStart = start + marker.length;
  const end = html.indexOf('</script>', contentStart);
  if (end < 0) throw new Error('The standalone game export has invalid embedded data.');
  return html.slice(contentStart, end);
}

function inspectStandaloneGame(html: string): StandaloneIdentity {
  if (!html.startsWith('<!doctype html') && !html.startsWith('<!DOCTYPE html'))
    throw new Error('Input must be a standalone VoxShop game export.');
  const inlineRuntime = html.match(/<script>([\s\S]+?)<\/script>/);
  if (!inlineRuntime?.[1] || /<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*\bhref\s*=/i.test(html))
    throw new Error('Standalone games must include their runtime and avoid external scripts or stylesheets.');
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?\s*>/i)?.[1];
  const cspDirectives =
    csp
      ?.split(';')
      .map((directive) => directive.trim())
      .filter(Boolean) ?? [];
  if (
    cspDirectives.length !== REQUIRED_CSP_DIRECTIVES.length ||
    new Set(cspDirectives).size !== REQUIRED_CSP_DIRECTIVES.length ||
    REQUIRED_CSP_DIRECTIVES.some((directive) => !cspDirectives.includes(directive))
  )
    throw new Error('Standalone games must keep the restrictive VoxShop Content Security Policy.');

  const parsedProject: unknown = JSON.parse(embeddedJson(html, PROJECT_MARKER));
  if (!parsedProject || typeof parsedProject !== 'object' || Array.isArray(parsedProject))
    throw new Error('Standalone game export has invalid embedded project data.');
  const project = parsedProject as {
    id?: unknown;
    name?: unknown;
    revision?: unknown;
    activeSceneId?: unknown;
    scenes?: Array<{ id?: unknown }>;
  };
  JSON.parse(embeddedJson(html, WORKER_MARKER));
  if (
    typeof project.id !== 'string' ||
    !ID_PATTERN.test(project.id) ||
    typeof project.name !== 'string' ||
    !Number.isSafeInteger(project.revision) ||
    typeof project.activeSceneId !== 'string' ||
    !ID_PATTERN.test(project.activeSceneId) ||
    !Array.isArray(project.scenes) ||
    !project.scenes.some(
      (scene) => !!scene && typeof scene === 'object' && scene.id === project.activeSceneId,
    ) ||
    !html.includes('id="voxshop-runtime-notice"') ||
    !html.includes('id="third-party-notices"')
  )
    throw new Error('Standalone game export has invalid identity or required license notices.');

  return {
    projectId: project.id,
    projectName: project.name,
    revision: project.revision as number,
    sceneId: project.activeSceneId,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function filenameSlug(value: string, limit: number) {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, limit)
      .replace(/-+$/g, '') || 'game'
  );
}

function addPlayerNotices(html: string, notices: string) {
  const marker = '</details></div><div id="touch-controls"';
  if (!html.includes(marker))
    throw new Error('The standalone game page has no player menu for legal notices.');
  const noticePanel = `<details id="voxshop-player-licenses"><summary>VoxShop player and third-party license notices</summary><pre style="white-space:pre-wrap;overflow:auto;max-height:35vh">${escapeHtml(notices)}</pre></details>`;
  return html.replace(marker, `${noticePanel}</details></div><div id="touch-controls"`);
}

function assertUnsignedPe(executable: Buffer) {
  if (executable.length < 0x40 || executable.toString('ascii', 0, 2) !== 'MZ')
    throw new Error('The packaged game player is not a valid Windows executable.');
  const peOffset = executable.readUInt32LE(0x3c);
  if (
    peOffset < 0x40 ||
    peOffset + 24 > executable.length ||
    executable.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0'
  )
    throw new Error('The packaged game player has an invalid PE header.');

  const optionalHeader = peOffset + 24;
  const optionalHeaderSize = executable.readUInt16LE(peOffset + 20);
  if (optionalHeader + optionalHeaderSize > executable.length || optionalHeaderSize < 112)
    throw new Error('The packaged game player has an invalid PE optional header.');
  const magic = executable.readUInt16LE(optionalHeader);
  const dataDirectoriesOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  const numberOfDirectoriesOffset = magic === 0x20b ? 108 : magic === 0x10b ? 92 : 0;
  if (!dataDirectoriesOffset || optionalHeaderSize < dataDirectoriesOffset + 5 * 8)
    throw new Error('The packaged game player has an unsupported PE format.');
  const directoryCount = executable.readUInt32LE(optionalHeader + numberOfDirectoriesOffset);
  if (directoryCount > 4) {
    const certificate = optionalHeader + dataDirectoriesOffset + 4 * 8;
    if (executable.readUInt32LE(certificate) !== 0 || executable.readUInt32LE(certificate + 4) !== 0)
      throw new Error('Refusing to append a game to a signed Windows executable.');
  }
}

function makeTrailer(payload: Buffer) {
  const trailer = Buffer.alloc(TRAILER_BYTES);
  TRAILER_MAGIC.copy(trailer, 0);
  trailer.writeUInt32LE(TRAILER_VERSION, 8);
  trailer.writeUInt32LE(0, 12);
  trailer.writeBigUInt64LE(BigInt(payload.byteLength), 16);
  createHash('sha256').update(payload).digest().copy(trailer, 24);
  return trailer;
}

export async function nativeGamePlayerAvailable(
  playerPath: string,
  noticesPath = path.join(path.dirname(playerPath), 'LICENSE_NOTICES.txt'),
) {
  try {
    const [player, notices] = await Promise.all([fs.stat(playerPath), fs.stat(noticesPath)]);
    return player.isFile() && player.size > 1024 && notices.isFile() && notices.size > 0;
  } catch {
    return false;
  }
}

export async function buildNativeGame(
  sourceHtmlPath: string,
  options: { playerPath: string; directory: string; noticesPath?: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const sourceStat = await fs.stat(sourceHtmlPath);
  if (!sourceStat.isFile() || sourceStat.size === 0 || sourceStat.size > MAX_NATIVE_GAME_BYTES)
    throw new Error(`Standalone game HTML must be between 1 byte and ${MAX_NATIVE_GAME_BYTES} bytes.`);

  const noticesPath =
    options.noticesPath ?? path.join(path.dirname(options.playerPath), 'LICENSE_NOTICES.txt');
  const noticesStat = await fs.stat(noticesPath);
  if (!noticesStat.isFile() || noticesStat.size === 0 || noticesStat.size > 16 * 1024 * 1024)
    throw new Error('Required VoxShop game-player license notices are missing or oversized.');
  const [source, notices] = await Promise.all([
    fs.readFile(sourceHtmlPath, 'utf8'),
    fs.readFile(noticesPath, 'utf8'),
  ]);
  const identity = inspectStandaloneGame(source);
  if (!notices.trim()) throw new Error('Required VoxShop game-player license notices are missing.');
  const html = addPlayerNotices(source, notices);
  const payload = Buffer.from(html, 'utf8');
  if (payload.byteLength > MAX_NATIVE_GAME_BYTES)
    throw new Error(
      `Standalone game plus required notices exceeds the ${MAX_NATIVE_GAME_BYTES}-byte player limit.`,
    );
  signal?.throwIfAborted();

  const player = await fs.readFile(options.playerPath);
  assertUnsignedPe(player);
  const identityHash = createHash('sha256')
    .update(`${identity.projectId}\0${identity.sceneId}`)
    .digest('hex')
    .slice(0, 10);
  const filename = `${filenameSlug(identity.projectName, 32)}-${filenameSlug(
    identity.sceneId,
    24,
  )}-${identityHash}-r${identity.revision}.exe`;
  const directory = path.resolve(options.directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const outputPath = path.join(directory, filename);
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(options.playerPath, temporaryPath);
    const output = await fs.open(temporaryPath, 'a');
    try {
      await output.writeFile(payload);
      await output.writeFile(makeTrailer(payload));
      await output.sync();
    } finally {
      await output.close();
    }
    signal?.throwIfAborted();
    await fs.rename(temporaryPath, outputPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }

  const outputStat = await fs.stat(outputPath);
  const hash = createHash('sha256');
  const output = await fs.open(outputPath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < outputStat.size) {
      const { bytesRead } = await output.read(
        chunk,
        0,
        Math.min(chunk.length, outputStat.size - position),
        position,
      );
      if (bytesRead === 0) throw new Error('Native game output ended before its reported size.');
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await output.close();
  }

  return {
    ...identity,
    filename,
    path: outputPath,
    bytes: outputStat.size,
    sha256: hash.digest('hex'),
    requirements:
      'Windows 10 or newer with a compatible Microsoft Edge WebView2 Evergreen runtime. Saved progress is isolated for each exported file; use Export save and Import save to transfer it to another export.',
  };
}
