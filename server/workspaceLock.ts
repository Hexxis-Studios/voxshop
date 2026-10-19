import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function lockWorkspace(directory: string) {
  const filename = path.join(directory, 'broker.lock'),
    nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(filename, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (current.nonce === nonce) await fs.unlink(filename);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let old: { pid: number };
      try {
        old = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (!Number.isInteger(old.pid) || old.pid < 1) throw new Error('Invalid broker lock.');
      } catch {
        throw new Error(
          'The workspace broker lock cannot be read. Check for another running VoxShop before moving broker.lock aside.',
        );
      }
      try {
        process.kill(old.pid, 0);
        throw new Error(
          'This workspace is already open in another VoxShop service. Use that service or close it first.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await fs.unlink(filename).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  throw new Error('Could not acquire workspace lock.');
}
