import { mkdtemp, mkdir, readFile, writeFile, readdir, cp, rename, rm, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheError } from '../identity.js';
import { acquireLock } from './lock.js';

const execAsync = promisify(execCallback);
// Development/reference backend: copies directories, never pretends to be LayerFS.
export class LocalBackend {
  static async open(root, seed) {
    const backend = new LocalBackend(resolve(root));
    backend.release = await acquireLock(join(backend.root, 'owner.lock'));
    try {
      for (const dir of ['snapshots', 'records', 'work']) await mkdir(join(backend.root, dir), { recursive: true });
      if (seed) {
        const seedPath = resolve(seed);
        if (!relative(seedPath, backend.root).startsWith('..')) throw new CacheError('InvalidInput', 'Local cache directory must be outside the seed directory');
        backend.baseRef = await backend.capture(seedPath);
      } else {
        const empty = await mkdtemp(join(backend.root, 'work', 'empty-'));
        try { backend.baseRef = await backend.capture(empty); } finally { await rm(empty, { recursive: true, force: true }); }
      }
      return backend;
    } catch (e) { await backend.release(); throw e; }
  }
  constructor(root) { this.root = root; }
  async capture(dir) {
    const hash = createHash('sha256');
    const scan = async (base, prefix = '') => {
      for (const name of (await readdir(base)).sort()) {
        const path = join(base, name), rel = prefix + '/' + name, info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new CacheError('Unsupported', 'Local backend supports ordinary files/directories only');
        hash.update(JSON.stringify([rel, info.isDirectory() ? 'd' : 'f', info.mode & 0o777]));
        if (info.isDirectory()) await scan(path, rel);
        else { const bytes = await readFile(path); hash.update(String(bytes.length) + ':'); hash.update(bytes); }
      }
    };
    await scan(dir);
    const ref = 'local-' + hash.digest('hex'), dest = join(this.root, 'snapshots', ref);
    try { await lstat(dest); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const staging = join(this.root, 'snapshots', '.tmp-' + randomUUID());
      await cp(dir, staging, { recursive: true });
      try { await rename(staging, dest); } catch (err) { await rm(staging, { recursive: true, force: true }); if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(err.code)) throw err; await lstat(dest); }
    }
    return ref;
  }
  async fork(ref) {
    if (!/^local-[a-f0-9]{64}$/.test(ref)) throw new CacheError('InvalidInput', 'Invalid local snapshot reference');
    const dir = await mkdtemp(join(this.root, 'work', 'run-'));
    try { await cp(join(this.root, 'snapshots', ref), dir, { recursive: true }); } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
    const pathOf = p => {
      if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.split('/').includes('..')) throw new CacheError('InvalidInput', 'Use absolute workspace paths without traversal');
      const target = resolve(dir, '.' + p), rel = relative(dir, target);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new CacheError('InvalidInput', 'Path escapes workspace');
      return target;
    };
    return {
      read: p => readFile(pathOf(p), 'utf8'),
      write: async (p, content) => { const target = pathOf(p); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content); },
      exec: async command => {
        try { const r = await execAsync(command, { cwd: dir, maxBuffer: 16 * 1024 * 1024 }); return { exitCode: 0, stdout: r.stdout, stderr: r.stderr }; }
        catch (e) { if (typeof e.code !== 'number') throw e; return { exitCode: e.code, stdout: e.stdout, stderr: e.stderr }; }
      },
      snapshot: () => this.capture(dir),
      close: () => rm(dir, { recursive: true, force: true })
    };
  }
  async getRecord(key) { try { return JSON.parse(await readFile(join(this.root, 'records', key + '.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async putRecord(key, value) { const target = join(this.root, 'records', key + '.json'), tmp = target + '.' + randomUUID(); await writeFile(tmp, JSON.stringify(value)); await rename(tmp, target); }
  async listRecords() { return Promise.all((await readdir(join(this.root, 'records'))).filter(n => n.endsWith('.json')).map(n => this.getRecord(n.slice(0, -5)))); }
  async removeRecord(key) { await rm(join(this.root, 'records', key + '.json'), { force: true }); }
  async close() { await this.release(); }
}
