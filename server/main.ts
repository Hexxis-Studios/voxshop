import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { lockWorkspace } from './workspaceLock';
const root = path.resolve(process.env.VOXSHOP_ROOT ?? process.cwd());
const service = await createApp({
  root,
  dataDir: process.env.VOXSHOP_DATA_DIR,
  port: Number(process.env.VOXSHOP_PORT ?? 4269),
  clientPort: Number(process.env.VOXSHOP_CLIENT_PORT ?? 3000),
  multiplayerHost: process.env.VOXSHOP_MULTIPLAYER_HOST ?? '127.0.0.1',
  multiplayerPublicHost: process.env.VOXSHOP_MULTIPLAYER_PUBLIC_HOST,
  multiplayerPort: Number(process.env.VOXSHOP_MULTIPLAYER_PORT ?? 4270),
  multiplayerTlsCertFile: process.env.VOXSHOP_MULTIPLAYER_TLS_CERT_FILE,
  multiplayerTlsKeyFile: process.env.VOXSHOP_MULTIPLAYER_TLS_KEY_FILE,
});
const unlock = await lockWorkspace(service.dataDir);
const server = service.app.listen(service.port, '127.0.0.1', async (error?: Error) => {
  // Express 5 invokes this callback on listen errors too; the error handler below releases the lock.
  if (error) return;
  try {
    await service.multiplayer.listen();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('VoxShop did not bind a TCP port.');
    const url = `http://127.0.0.1:${address.port}`;
    await fs.writeFile(
      path.join(service.dataDir, 'access.json'),
      JSON.stringify({ url, token: service.token }),
      { mode: 0o600 },
    );
    console.log(`VoxShop: ${url} (local access only)`);
    console.log(`VoxShop multiplayer: ${service.multiplayer.websocketUrl}`);
  } catch (startupError) {
    console.error(startupError instanceof Error ? startupError.message : startupError);
    server.close();
    server.closeAllConnections();
    await service.multiplayer.close();
    await unlock();
    process.exitCode = 1;
  }
});
server.on('error', async (error) => {
  console.error(error.message);
  await service.multiplayer.close();
  await unlock();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    server.close();
    server.closeAllConnections();
    await service.multiplayer.close();
    await unlock();
    process.exit(0);
  });
