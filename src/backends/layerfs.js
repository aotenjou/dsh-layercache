import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { digest, CacheError } from '../identity.js';
import { encodeRecord, decodeRecord } from '../store.js';
import { acquireLock } from './lock.js';

const ROOT = '/.layercache-v1';
const recordKey = key => {
  if (!/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(key)) throw new CacheError('InvalidInput', 'Invalid record key');
  return key;
};
function pathOf(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) throw new CacheError('InvalidInput', 'Use absolute workspace paths without traversal');
  return path;
}
export class LayerFSBackend {
  static async open({ project, seedRef = 'main', index = 'default', lockPath, client, sdkModule = '@layerfs/agent' }) {
    if (!lockPath) throw new CacheError('InvalidInput', 'lockPath is required; use the same local lock for every owner of a project/index');
    const release = await acquireLock(lockPath);
    let lf;
    try {
      lf = client ?? await (await import(sdkModule)).LayerFS.open(project);
      const backend = new LayerFSBackend(lf, release);
      backend.index = 'lc-index-' + digest(index).slice(0, 32);
      try { await lf.branch.fork(backend.index, seedRef); }
      catch (e) { if (e.code !== 'NameTaken') throw e; }
      await lf.fs.mkdir(backend.index, ROOT + '/nodes', 'LayerCache: initialize index');
      await lf.fs.mkdir(backend.index, ROOT + '/blobs', 'LayerCache: initialize blobs');
      // Pin even a mutable seed Branch/main to an immutable Commit/Layer once.
      const pinned = await lf.branch.fork('lc-base-' + randomUUID().replaceAll('-', ''), seedRef);
      backend.baseRef = pinned.head ?? pinned.base;
      if (!backend.baseRef) throw new CacheError('InvalidState', 'LayerFS returned no immutable base reference');
      return backend;
    } catch (e) { try { if (lf && !client) await lf.close(); } finally { await release(); } throw e; }
  }
  constructor(client, release) { this.client = client; this.release = release; }
  async readText(ref, path) {
    let text = '', line = 1;
    for (;;) {
      const page = await this.client.fs.read(ref, path, line);
      if (page.lineTruncated) throw new CacheError('TooLarge', 'LayerFS fs.read cannot return a line longer than 48 KiB; use a shell tool to process this file');
      text += page.text;
      if (!page.truncated) return text;
      if (!page.nextLine || page.nextLine <= line) throw new CacheError('CorruptCache', 'Non-advancing LayerFS text page');
      line = page.nextLine;
    }
  }
  async fork(ref) {
    const lf = this.client, branch = 'lc-run-' + randomUUID().replaceAll('-', '');
    const forked = await lf.branch.fork(branch, ref);
    let head = forked.head ?? forked.base;
    const backend = this;
    return {
      read: p => backend.readText(head, pathOf(p)),
      write: async (p, content) => {
        pathOf(p);
        // mkdir and write together so a failed write publishes no partial state.
        const result = await lf.fs.apply(branch, [{ op: 'mkdir', path: posix.dirname(p) }, { op: 'write', path: p, content }], 'LayerCache tool file write');
        head = result.head ?? head;
      },
      exec: async command => {
        const { sandbox } = await lf.sandbox.create();
        let ws, failure;
        try {
          ws = await lf.workspace.mount(sandbox, branch);
          const result = await lf.workspace.exec(ws, command, 'LayerCache tool execution');
          const committed = await lf.workspace.commit(ws, `LayerCache shell exit ${result.exitCode}`);
          head = committed.head ?? head;
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        } catch (e) { failure = e; throw e; }
        finally {
          const errors = [];
          if (ws) { try { await lf.workspace.unmount(ws, Boolean(failure)); } catch (e) { errors.push(e); } }
          try { await lf.sandbox.close(sandbox); } catch (e) { errors.push(e); }
          if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'LayerFS execution/cleanup failed; inspect Workspaces before further execution');
        }
      },
      snapshot: async () => head,
      // Branches/Commits stay as history; LayerFS 1.1 has no public branch-delete API.
      close: async () => {}
    };
  }
  async getRecord(key) {
    recordKey(key);
    let text;
    try { text = await this.readText(this.index, `${ROOT}/nodes/${key}`); }
    catch (e) { if (e.code === 'NoSuchPath') return null; throw e; }
    const manifest = JSON.parse(text), chunks = [];
    if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.hash) || !Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1) throw new CacheError('CorruptCache', 'Invalid LayerFS cache manifest');
    for (let i = 0; i < manifest.chunks; i++) chunks.push(await this.readText(this.index, `${ROOT}/blobs/${manifest.hash}-${i}`));
    return decodeRecord(manifest, chunks);
  }
  async putRecord(key, value) {
    recordKey(key);
    const { manifest, chunks } = encodeRecord(value);
    for (let i = 0; i < chunks.length; i++) await this.client.fs.write(this.index, `${ROOT}/blobs/${manifest.hash}-${i}`, chunks[i], 'LayerCache result chunk');
    await this.client.fs.write(this.index, `${ROOT}/nodes/${key}`, JSON.stringify(manifest), 'LayerCache publish cache node');
  }
  async listRecords() {
    const keys = [];
    for (let pos = 0; ; ) {
      const page = await this.client.fs.list(this.index, ROOT + '/nodes', 1000, pos);
      keys.push(...page.items.map(i => i.name));
      if (!page.hasMore) break;
      if (!page.items.length) throw new CacheError('CorruptCache', 'Non-advancing LayerFS directory page');
      pos = page.nextPagePos ?? pos + page.items.length;
    }
    return Promise.all(keys.map(k => this.getRecord(k)));
  }
  async removeRecord(key) { await this.client.fs.rm(this.index, `${ROOT}/nodes/${recordKey(key)}`, 'LayerCache expire node'); }
  async close() { try { await this.client.close(); } finally { await this.release(); } }
}
