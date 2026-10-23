import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const output = path.resolve(root, '.voxshop', 'release', 'source-manifest.json');
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'buffer',
  maxBuffer: 32 * 1024 * 1024,
});
if (listed.error) throw listed.error;
if (listed.status !== 0) throw new Error(`Could not enumerate source files: ${listed.stderr?.toString()}`);

const excludedDirectories = new Set([
  '.git',
  '.voxshop',
  '.openai',
  '.codex',
  '.claude',
  '.agents',
  '.github',
  'tests',
  'node_modules',
  'dist',
  'dist-server',
  'target',
]);
const sensitiveFile = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa(?:\.pub)?|credentials(?:\..*)?)$/i;
const files = [];
for (const entry of listed.stdout.toString('utf8').split('\0').filter(Boolean).sort()) {
  const parts = entry.split(/[\\/]/);
  if (parts[0] === 'evidence') continue;
  if (['server.js', 'wait_for_request.ps1'].includes(entry) || parts[0] === '_bridge') continue;
  if (/^(?:desktop\/game-player\/)?src-tauri\/gen\//.test(entry)) continue;
  if (['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(entry)) continue;
  if (/^scripts\/(?:verify-|benchmark-|prepare-standalone-throughput)/.test(entry)) continue;
  if (
    /^docs\/(?:agent-completion-checklist|delivery-checkpoint|engine-roadmap|implementation-status|reliable-model-editing)\.md$/.test(
      entry,
    )
  )
    continue;
  if (parts.some((part) => excludedDirectories.has(part))) continue;
  if (parts[0] === 'src-tauri' && parts[1] === 'binaries') continue;
  const basename = parts.at(-1) ?? '';
  if (sensitiveFile.test(basename)) throw new Error(`Potential secret is in the source tree: ${entry}`);
  if (/\.log$/i.test(basename)) continue;
  const filename = path.resolve(root, entry);
  if (!filename.startsWith(root + path.sep)) throw new Error(`Source path escapes the repository: ${entry}`);
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (!info.isFile()) throw new Error(`Source manifest only accepts regular files: ${entry}`);
  const bytes = await readFile(filename);
  files.push({
    path: entry.replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

const byPath = new Map(files.map((file) => [file.path, file]));
for (const required of [
  'package.json',
  'package-lock.json',
  'LICENSE',
  'README.md',
  'assets/voxshop_logo.png',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
])
  if (!byPath.has(required)) throw new Error(`Required source release file is missing: ${required}`);

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.version !== '2.0.0-alpha.1' || packageJson.author !== 'Hexxis Studios')
  throw new Error('Source release identity must be Hexxis Studios 2.0.0-alpha.1.');

const noticeRoot = path.join(root, '.voxshop', 'desktop-runtime', 'resources');
const noticePath = path.join(noticeRoot, 'THIRD_PARTY_NOTICES.md');
const noticeText = await readFile(noticePath, 'utf8');
if (!noticeText.includes('dependency notices, not collaborator credits'))
  throw new Error('Bundled dependency notices must remain separate from collaborator credits.');
const noticeFiles = [...noticeText.matchAll(/\]\((THIRD_PARTY_LICENSES\/([a-f0-9]{64})\.txt)\)/g)];
if (!noticeFiles.length) throw new Error('Bundled dependency notices contain no referenced license texts.');
for (const [, relative, digest] of noticeFiles) {
  const bytes = await readFile(path.join(noticeRoot, relative));
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error(`Bundled third-party license failed its content hash: ${relative}`);
}

const manifest = {
  format: 'voxshop-source-manifest',
  schemaVersion: 1,
  publisher: packageJson.author,
  version: packageJson.version,
  license: packageJson.license,
  generatedAt: new Date().toISOString(),
  fileCount: files.length,
  files,
  dependencyNotices: {
    source: 'Generated from the locked Windows desktop runtime and Rust dependencies.',
    path: 'THIRD_PARTY_NOTICES.md',
    sha256: createHash('sha256').update(noticeText).digest('hex'),
    licenseTextCount: noticeFiles.length,
  },
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Source manifest verified ${files.length} files; bundled license texts: ${noticeFiles.length}.`);
console.log(output);
