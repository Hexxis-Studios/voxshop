import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(projectRoot, 'desktop', 'game-player', 'src-tauri', 'Cargo.toml');
const outputPath = path.join(
  projectRoot,
  '.voxshop',
  'desktop-runtime',
  'resources',
  'game-player',
  'LICENSE_NOTICES.txt',
);
const arch = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[process.arch];
if (process.platform !== 'win32' || !arch)
  throw new Error('The standalone Windows player notices must be collected on Windows.');
const target = `${arch}-pc-windows-msvc`;
const cargo =
  process.env.CARGO ??
  (process.platform === 'win32' ? path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe') : 'cargo');
const result = spawnSync(
  cargo,
  [
    'metadata',
    '--locked',
    '--format-version',
    '1',
    '--manifest-path',
    manifestPath,
    '--filter-platform',
    target,
  ],
  { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Could not read game-player dependency metadata: ${result.stderr}`);

const metadata = JSON.parse(result.stdout);
const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const root = metadata.packages.find((pkg) => pkg.name === 'voxshop-game-player');
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
if (!root || !nodes.has(root.id)) throw new Error('Game-player Cargo metadata has no resolved root package.');

const reachable = new Set();
const pending = [root.id];
while (pending.length) {
  const id = pending.pop();
  if (reachable.has(id)) continue;
  reachable.add(id);
  for (const dependency of nodes.get(id)?.deps ?? []) pending.push(dependency.pkg);
}

const packageLicensePattern = /^(?:licen[cs]es?|copying|notice)(?:[._ -].*)?$/i;
const records = [];
for (const id of reachable) {
  const pkg = packageById.get(id);
  if (!pkg?.source) continue;
  const directory = path.dirname(pkg.manifest_path);
  const filenames = new Set();
  if (pkg.license_file) filenames.add(path.resolve(directory, pkg.license_file));
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isFile() && packageLicensePattern.test(entry.name))
        filenames.add(path.join(directory, entry.name));
  } catch {}

  const texts = [];
  for (const filename of filenames) {
    try {
      texts.push({ filename: path.basename(filename), text: await fs.readFile(filename, 'utf8') });
    } catch {}
  }
  records.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? 'unspecified',
    texts,
  });
}

records.sort(
  (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
);
const sections = [
  'VoxShop Game Player — third-party dependency license notices',
  '',
  'These notices apply to the native player runtime bundled with this exported game. VoxShop engine terms and game-runtime notices are included separately in the game export.',
  '',
];
for (const record of records) {
  sections.push(`## ${record.name} ${record.version}`, `License: ${record.license}`);
  if (!record.texts.length) {
    sections.push('The crate source does not supply a license text.');
  } else {
    for (const file of record.texts) sections.push('', `--- ${file.filename} ---`, file.text.trimEnd());
  }
  sections.push('');
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${sections.join('\n')}\n`);
console.log(`Collected ${records.length} Windows game-player dependency license notices.`);
