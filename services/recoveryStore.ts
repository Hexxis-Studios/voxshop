import type { ModelDocument } from './modelDocument';
export type DraftRecovery = {
  projectId: string;
  baseRevision: number;
  assetId: string | null;
  document: ModelDocument;
  updatedAt: number;
};
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('voxshop-recovery', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'projectId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('Recovery database is blocked by another tab. Close older VoxShop tabs and retry.'));
  });
}
export async function readRecovery(projectId: string): Promise<DraftRecovery | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('drafts').objectStore('drafts').get(projectId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
export async function writeRecovery(value: DraftRecovery) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite'),
        store = tx.objectStore('drafts'),
        read = store.get(value.projectId);
      read.onsuccess = () => {
        if (!read.result || read.result.updatedAt <= value.updatedAt) store.put(value);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function clearRecovery(projectId: string, updatedAt?: number) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite'),
        store = tx.objectStore('drafts'),
        read = store.get(projectId);
      read.onsuccess = () => {
        if (updatedAt === undefined || read.result?.updatedAt === updatedAt) store.delete(projectId);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
