import { mkdtemp, mkdir, readFile, writeFile, readdir, cp, rename, rm, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheError } from '../identity.js';
import { acquireLock } from './lock.js';

const execAsync = promisify(execCallback);

export class LocalBackend {
  static async open(root, seed) {
    const backend = new LocalBackend(resolve(root));
    backend.release = await acquireLock(join(backend.root, 'owner.lock'));
    try {
      for (const dir of ['snapshots', 'records', 'work']) await mkdir(join(backend.root, dir), { recursive: true });
      if (seed) {
        const seedPath = resolve(seed);
        if (!relative(seedPath, backend.root).startsWith('..')) {
          throw new CacheError('InvalidInput', 'Local cache directory must be outside the seed directory');
        }
        backend.baseRef = await backend.capture(seedPath);
      } else {
        const empty = await mkdtemp(join(backend.root, 'work', 'empty-'));
        try { backend.baseRef = await backend.capture(empty); }
        finally { await rm(empty, { recursive: true, force: true }); }
      }
      return backend;
    } catch (error) {
      await backend.release();
      throw error;
    }
  }

  constructor(root) { this.root = root; }

  async capture(dir) {
    const hash = createHash('sha256');
    const scan = async (base, prefix = '') => {
      for (const name of (await readdir(base)).sort()) {
        const path = join(base, name);
        const rel = prefix + '/' + name;
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          throw new CacheError('Unsupported', 'Local backend supports ordinary files/directories only');
        }
        hash.update(JSON.stringify([rel, info.isDirectory() ? 'd' : 'f', info.mode & 0o777]));
        if (info.isDirectory()) await scan(path, rel);
        else {
          const bytes = await readFile(path);
          hash.update(String(bytes.length) + ':');
          hash.update(bytes);
        }
      }
    };
    await scan(dir);
    const ref = 'local-' + hash.digest('hex');
    const dest = join(this.root, 'snapshots', ref);
    try {
      await lstat(dest);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const staging = join(this.root, 'snapshots', '.tmp-' + randomUUID());
      await cp(dir, staging, { recursive: true });
      try { await rename(staging, dest); }
      catch (renameError) {
        await rm(staging, { recursive: true, force: true });
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(renameError.code)) throw renameError;
        await lstat(dest);
      }
    }
    return ref;
  }

  async fork(ref) {
    if (!/^local-[a-f0-9]{64}$/.test(ref)) throw new CacheError('InvalidInput', 'Invalid local snapshot reference');
    const dir = await mkdtemp(join(this.root, 'work', 'run-'));
    try {
      await cp(join(this.root, 'snapshots', ref), dir, { recursive: true });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    const pathOf = path => {
      if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') ||
          path.includes('\0') || path.split('/').includes('..')) {
        throw new CacheError('InvalidInput', 'Use absolute workspace paths without traversal');
      }
      const target = resolve(dir, '.' + path);
      const rel = relative(dir, target);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new CacheError('InvalidInput', 'Path escapes workspace');
      return target;
    };
    return {
      read: path => readFile(pathOf(path), 'utf8'),
      write: async (path, content) => {
        const target = pathOf(path);
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, content);
      },
      exec: async command => {
        try {
          const result = await execAsync(command, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          if (typeof error.code !== 'number') throw error;
          return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
        }
      },
      snapshot: () => this.capture(dir),
      close: () => rm(dir, { recursive: true, force: true })
    };
  }

  async getRecord(key) {
    try { return JSON.parse(await readFile(join(this.root, 'records', key + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  getResources() { return this.getRecord('resources'); }
  putResources(value) { return this.putRecord('resources', value); }

  async putRecord(key, value) {
    const staged = await this.stageRecord(key, value);
    try { await staged.commit(); }
    finally { await staged.discard(); }
  }

  async stageRecord(key, value) {
    const target = join(this.root, 'records', key + '.json');
    const tmp = target + '.' + randomUUID();
    const discard = () => rm(tmp, { force: true });
    try { await writeFile(tmp, JSON.stringify(value)); }
    catch (error) { await discard(); throw error; }
    let committed = false;
    return {
      commit: async () => { await rename(tmp, target); committed = true; },
      discard: async () => { if (!committed) await discard(); }
    };
  }

  async listRecords() {
    return Promise.all((await readdir(join(this.root, 'records')))
      .filter(name => /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name))
      .map(name => this.getRecord(name.slice(0, -5))));
  }

  async removeRecord(key) {
    await rm(join(this.root, 'records', key + '.json'), { force: true });
  }

  async listSnapshots() {
    return (await readdir(join(this.root, 'snapshots'))).filter(name => /^local-[a-f0-9]{64}$/.test(name));
  }

  async releaseSnapshot(ref) {
    if (!/^local-[a-f0-9]{64}$/.test(ref)) throw new CacheError('InvalidInput', 'Invalid local snapshot reference');
    if (!ref || ref === this.baseRef) return false;
    try {
      await rm(join(this.root, 'snapshots', ref), { recursive: true });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async close() { await this.release(); }
}
