import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourcesRoot = path.join(projectRoot, '.voxshop', 'desktop-runtime', 'resources');
const noticesRoot = path.join(resourcesRoot, 'THIRD_PARTY_LICENSES');
const cargoRoot = path.join(projectRoot, 'src-tauri');
const packageLicensePattern = /^(?:licen[cs]es?|copying|notice)(?:[._ -].*)?$/i;
const records = [];

await mkdir(noticesRoot, { recursive: true });

async function includeText(name, version, license, filename, text) {
  const digest = createHash('sha256').update(text).digest('hex');
  const output = path.join(noticesRoot, `${digest}.txt`);
  try {
    await access(output);
  } catch {
    await writeFile(output, text);
  }
  records.push({
    name,
    version,
    license: license ?? 'unspecified',
    source: filename,
    file: `THIRD_PARTY_LICENSES/${digest}.txt`,
  });
}

async function collectNpmPackage(directory) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && packageLicensePattern.test(entry.name)) {
      await includeText(
        manifest.name ?? path.basename(directory),
        manifest.version ?? 'unknown',
        typeof manifest.license === 'string' ? manifest.license : manifest.license?.type,
        entry.name,
        await readFile(path.join(directory, entry.name), 'utf8'),
      );
    }
  }
  const nested = path.join(directory, 'node_modules');
  try {
    await access(nested);
    await collectNpmDependencies(nested);
  } catch {}
}

async function collectNpmDependencies(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scopedPackage of await readdir(entryPath, { withFileTypes: true })) {
        if (scopedPackage.isDirectory()) await collectNpmPackage(path.join(entryPath, scopedPackage.name));
      }
    } else {
      await collectNpmPackage(entryPath);
    }
  }
}

await collectNpmDependencies(path.join(resourcesRoot, 'node_modules'));

const adjacentNodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
let nodeLicense;
try {
  nodeLicense = await readFile(adjacentNodeLicense, 'utf8');
} catch {
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
  );
  if (!response.ok)
    throw new Error(`Could not retrieve the license for bundled Node.js ${process.versions.node}.`);
  nodeLicense = await response.text();
}
if (!nodeLicense.includes('Node.js is licensed'))
  throw new Error('The bundled Node.js license file was not recognized.');
await includeText(
  'Node.js',
  process.versions.node,
  'MIT and third-party licenses',
  `https://github.com/nodejs/node/blob/v${process.versions.node}/LICENSE`,
  nodeLicense,
);

const cargo =
  process.env.CARGO ??
  (process.platform === 'win32' ? path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe') : 'cargo');
const rustArch = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[process.arch];
const rustTarget =
  process.platform === 'win32' ? `${rustArch}-pc-windows-msvc` : `${rustArch}-unknown-linux-gnu`;
const metadataResult = spawnSync(
  cargo,
  ['metadata', '--locked', '--format-version', '1', '--filter-platform', rustTarget],
  {
    cwd: cargoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  },
);
if (metadataResult.error) throw metadataResult.error;
if (metadataResult.status !== 0)
  throw new Error(`Could not read Rust dependency metadata: ${metadataResult.stderr}`);
const metadata = JSON.parse(metadataResult.stdout);
for (const pkg of metadata.packages) {
  if (!pkg.source) continue;
  const directory = path.dirname(pkg.manifest_path);
  const names = new Set();
  if (pkg.license_file) names.add(path.resolve(directory, pkg.license_file));
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && packageLicensePattern.test(entry.name))
        names.add(path.join(directory, entry.name));
    }
  } catch {}
  let included = false;
  for (const filename of names) {
    try {
      await includeText(
        pkg.name,
        pkg.version,
        pkg.license,
        path.basename(filename),
        await readFile(filename, 'utf8'),
      );
      included = true;
    } catch {}
  }
  if (!included)
    records.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'unspecified' });
}

records.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const licenseTextById = new Map();
for (const record of records) {
  if (!record.file) continue;
  const expression = record.license.trim();
  const sourceName = path
    .basename(record.source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const namedLicense = sourceName.endsWith('-mit')
    ? 'MIT'
    : sourceName.endsWith('-apache')
      ? 'Apache-2.0'
      : sourceName.endsWith('-mpl-2-0')
        ? 'MPL-2.0'
        : sourceName.endsWith('-bsd-3-clause')
          ? 'BSD-3-Clause'
          : undefined;
  if (namedLicense) licenseTextById.set(namedLicense, record.file);
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(expression)) licenseTextById.set(expression, record.file);
}
for (const record of records) {
  if (record.file) continue;
  const licenseIds = record.license.split(/\s+(?:OR|AND)\s+/);
  const sharedLicenseFiles = licenseIds.map((id) => licenseTextById.get(id));
  if (sharedLicenseFiles.every(Boolean)) record.licenseFiles = sharedLicenseFiles;
}
const rows = records.map((record) => {
  const source = record.source
    ? ` — [${record.source}](${record.file})`
    : record.licenseFiles
      ? ` — ${record.licenseFiles
          .map((file, index) => `[${record.license.split(/\s+(?:OR|AND)\s+/)[index]}](${file})`)
          .join('; ')}`
      : ' — license text is not supplied in the crate source';
  return `- ${record.name} ${record.version} — ${record.license}${source}`;
});
await writeFile(
  path.join(resourcesRoot, 'THIRD_PARTY_NOTICES.md'),
  `# Third-party notices\n\nVoxShop has separate source-available terms in \`LICENSE\`, including royalty-free commercial Game Output Permission. Previously Apache-licensed code retains its original rights. The notices below cover bundled Node.js and runtime dependencies; they are dependency notices, not collaborator credits.\n\n${rows.join('\n')}\n`,
);
console.log(`Collected ${records.length} JavaScript, Rust, and Node.js license notices.`);
