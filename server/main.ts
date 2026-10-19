import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { lockWorkspace } from './workspaceLock';
const root = path.resolve(process.env.VOXSHOP_ROOT ?? process.cwd());
const service = await createApp({
  root,
  dataDir: process.env.VOXSHOP_DATA_DIR,
  port: Number(process.env.VOXSHOP_PORT ?? 4269),
});
const unlock = await lockWorkspace(service.dataDir);
const server = service.app.listen(service.port, '127.0.0.1', async () => {
  await fs.writeFile(
    path.join(service.dataDir, 'access.json'),
    JSON.stringify({ url: `http://127.0.0.1:${service.port}`, token: service.token }),
    { mode: 0o600 },
  );
  console.log(`VoxShop: http://localhost:${service.port} (local access only)`);
});
server.on('error', async (error) => {
  console.error(error.message);
  await unlock();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    server.close();
    server.closeAllConnections();
    await unlock();
    process.exit(0);
  });
