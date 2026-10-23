import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, '.openai', 'hosting.json'), 'utf8'));
const matches = ['voxshop', 'voxshop-original-account']
  .map((name) => path.join(root, '.voxshop', 'sites', name))
  .filter((directory) => {
    const manifest = path.join(directory, '.openai', 'hosting.json');
    return (
      fs.existsSync(manifest) &&
      JSON.parse(fs.readFileSync(manifest, 'utf8')).project_id === config.project_id
    );
  });
const site = process.argv[2] ? path.resolve(root, process.argv[2]) : matches.length === 1 ? matches[0] : null;
if (!site || !fs.existsSync(path.join(site, 'vite.config.ts')))
  throw Error('Pass the matching initialized Sites checkout path to synchronize.');
const existingConfig = JSON.parse(fs.readFileSync(path.join(site, '.openai', 'hosting.json'), 'utf8'));
if (existingConfig.project_id !== config.project_id)
  throw Error(
    'The selected checkout belongs to a different Site. Pass the matching checkout path explicitly.',
  );
const engine = path.join(site, 'engine');
fs.mkdirSync(engine, { recursive: true });
for (const name of [
  'App.tsx',
  'components',
  'services',
  'runtime',
  'utils',
  'assets',
  'types.ts',
  'vite-env.d.ts',
  'index.css',
  'hosting',
]) {
  const source = path.join(root, name);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(engine, name), { recursive: true });
}
fs.mkdirSync(path.join(site, 'hosted'), { recursive: true });
fs.copyFileSync(path.join(root, 'dist', 'runtime.js'), path.join(site, 'hosted', 'runtime.js'));
fs.copyFileSync(path.join(root, 'dist', 'runtime-lite.js'), path.join(site, 'hosted', 'runtime-lite.js'));
fs.copyFileSync(
  path.join(root, 'node_modules', 'three', 'LICENSE'),
  path.join(site, 'hosted', 'three-license.txt'),
);
fs.copyFileSync(path.join(root, 'skills', 'VOXEL_SKILL.md'), path.join(site, 'hosted', 'VOXEL_SKILL.md'));
const presets = fs
  .readdirSync(path.join(root, 'presets'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'presets', f), 'utf8')));
fs.writeFileSync(path.join(site, 'hosted', 'presets.json'), JSON.stringify(presets));
fs.copyFileSync(path.join(root, 'hosting', 'sites', 'schema.ts'), path.join(site, 'db', 'schema.ts'));
config.capabilities = [...new Set([...(config.capabilities ?? []), 'mcp'])];
fs.writeFileSync(path.join(site, '.openai', 'hosting.json'), JSON.stringify(config, null, 2) + '\n');
console.log(JSON.stringify({ synced: true, site, project_id: config.project_id }));
