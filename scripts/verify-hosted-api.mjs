import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const site = path.resolve(process.argv[2] ?? '.voxshop/sites/voxshop');
const { Miniflare } = await import(
  pathToFileURL(path.join(site, 'node_modules/miniflare/dist/src/index.js'))
);
const output = path.resolve('.voxshop/sites/backend-check');
await build({
  entryPoints: [
    path.join(site, 'engine/hosting/sites/api.ts'),
    path.join(site, 'engine/hosting/sites/mcp.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: output,
  plugins: [
    {
      name: 'raw-assets',
      setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.resolve(path.dirname(args.importer), args.path.replace(/\?raw$/, '')),
          namespace: 'raw',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
          contents: fs.readFileSync(args.path, 'utf8'),
          loader: 'text',
        }));
      },
    },
  ],
});
const { route } = await import(pathToFileURL(path.join(output, 'api.js')));
const { mcp } = await import(pathToFileURL(path.join(output, 'mcp.js')));
const runtime = new Miniflare({
  modules: true,
  script: 'export default{fetch(){return new Response("fixture")}}',
  compatibilityDate: '2026-05-15',
  d1Databases: ['DB'],
  r2Buckets: ['BUCKET'],
});
const originalFetch = globalThis.fetch;
try {
  const env = { DB: await runtime.getD1Database('DB'), BUCKET: await runtime.getR2Bucket('BUCKET') };
  const migration = fs
    .readdirSync(path.join(site, 'drizzle'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migration)
    await env.DB.exec(
      fs
        .readFileSync(path.join(site, 'drizzle', file), 'utf8')
        .replace(/--> statement-breakpoint/g, '')
        .replace(/\n/g, ' '),
    );
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (url.origin !== 'http://127.0.0.1:5183') return originalFetch(input, init);
    if (url.pathname === '/mcp') return mcp(request, env);
    return route(request, env);
  };
  process.env.VOXSHOP_API_FIXTURE = '1';
  process.argv[2] = 'http://127.0.0.1:5183';
  await import('./verify-sites.mjs');
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.VOXSHOP_API_FIXTURE;
  await runtime.dispose();
}
