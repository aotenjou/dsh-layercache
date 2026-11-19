import { digest, CacheError } from './identity.js';

// One live cache service owns this index. Content chunks precede the atomic manifest.
// Chunks stay below LayerFS's 65,519-byte request and 48 KiB text-read windows.
export class PrefixStore {
  constructor(backend) { this.backend = backend; this.pending = Promise.resolve(); }
  async get(scope, key) {
    const entry = await this.backend.getRecord(`${scope}-${key}`);
    if (!entry) return null;
    if (entry.schema !== 1 || entry.scope !== scope || entry.key !== key) throw new CacheError('CorruptCache', 'Invalid node identity');
    return entry;
  }
  async put(entry) {
    const work = this.pending.then(async () => {
      const existing = await this.get(entry.scope, entry.key);
      if (existing) return existing;
      await this.backend.putRecord(`${entry.scope}-${entry.key}`, entry);
      return entry;
    });
    this.pending = work.catch(() => {});
    return work;
  }
  async entries(scope) {
    const entries = await this.backend.listRecords();
    return entries.filter(e => e && (!scope || e.scope === scope));
  }
  async prune({ before = Date.now(), scope } = {}) {
    const work = this.pending.then(async () => {
      let removed = 0;
      for (const entry of await this.entries(scope)) {
        if (entry.createdAt < before) { await this.backend.removeRecord(`${entry.scope}-${entry.key}`); removed++; }
      }
      return { removed, reclaimedSnapshots: false };
    });
    this.pending = work.catch(() => {});
    return work;
  }
}

export function encodeRecord(value) {
  const data = Buffer.from(JSON.stringify(value));
  const hash = digest(value);
  const chunks = [];
  for (let i = 0; i < data.length; i += 12 * 1024) chunks.push(data.subarray(i, i + 12 * 1024).toString('base64'));
  return { manifest: { schema: 1, hash, chunks: chunks.length }, chunks };
}
export function decodeRecord(manifest, chunks) {
  if (manifest.schema !== 1 || !Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1 || chunks.length !== manifest.chunks) throw new CacheError('CorruptCache', 'Invalid record manifest');
  const value = JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c.trim(), 'base64'))).toString());
  if (digest(value) !== manifest.hash) throw new CacheError('CorruptCache', 'Record checksum mismatch');
  return value;
}
