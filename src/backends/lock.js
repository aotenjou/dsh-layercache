import { open, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CacheError } from '../identity.js';

// No timeout-based stealing: a slow live owner must keep its authority.
export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new CacheError('CacheLocked', `Cache already has an owner: ${path}. After a crash, verify that the recorded process is gone before removing this file.`); throw e; }
  await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let released = false;
  return async () => { if (!released) { await file.close(); await unlink(path); released = true; } };
}
