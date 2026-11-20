import { digest, CacheError } from './identity.js';

export function isCompleteEntry(entry) {
  return Boolean(entry && entry.schema === 2 &&
    typeof entry.scope === 'string' && typeof entry.key === 'string' &&
    typeof entry.parent === 'string' && (entry.parentRevision === null || typeof entry.parentRevision === 'string') &&
    typeof entry.revision === 'string' && Number.isSafeInteger(entry.generation) &&
    typeof entry.inputRef === 'string' && typeof entry.ref === 'string' && typeof entry.mutates === 'boolean' &&
    Object.hasOwn(entry, 'value') && Number.isFinite(entry.executionMs) &&
    Array.isArray(entry.dependencies) && Array.isArray(entry.producedResources) &&
    Array.isArray(entry.sharedInputs) && typeof entry.policyFingerprint === 'string' &&
    Number.isSafeInteger(entry.createdAt) && (entry.expiresAt === null || Number.isSafeInteger(entry.expiresAt)));
}

export function entryExpired(entry, now) {
  return entry.expiresAt !== null && entry.expiresAt <= now;
}

export class PrefixStore {
  constructor(backend, prune) {
    this.backend = backend;
    this.pending = Promise.resolve();
    this.prune = prune;
    this.observations = new Map();
    this.uncertain = new Map();
  }

  async get(scope, key) {
    const entry = await this.backend.getRecord(scope + '-' + key);
    if (entry && (entry.scope !== scope || entry.key !== key)) {
      throw new CacheError('CorruptCache', 'Invalid node identity');
    }
    return entry ?? null;
  }

  observe(scope, key) {
    const id = scope + '-' + key;
    const token = this.observations.get(id) ?? { pruneVersion: 0, writes: 0, users: 0 };
    token.users++;
    this.observations.set(id, token);
    const pruneVersion = token.pruneVersion;
    return {
      valid: () => token.pruneVersion === pruneVersion,
      writes: () => token.writes,
      release: () => {
        token.users--;
        if (token.users === 0) this.observations.delete(id);
      }
    };
  }

  async remove(entry) {
    const id = entry.scope + '-' + entry.key;
    const token = this.observations.get(id);
    if (token) token.pruneVersion++;
    await this.backend.removeRecord(id);
    this.uncertain.delete(id);
  }

  async publish(entry, { observed, observation, usable, validate, beforeCommit, onPublished }) {
    const id = entry.scope + '-' + entry.key;
    const check = async () => {
      const current = await this.get(entry.scope, entry.key);
      const matches = isCompleteEntry(current) && isCompleteEntry(observed) ?
        current.revision === observed.revision && current.generation === observed.generation :
        digest(current) === digest(observed);
      if (!observation.valid() || usable(current) || !matches) return { reason: 'conflict' };
      const reason = await validate();
      return reason ? { reason } : { current };
    };
    const initial = await this.transaction(check);
    if (initial.reason) return initial;
    const generation = isCompleteEntry(initial.current) ? initial.current.generation + 1 : 1;
    const next = { ...entry, generation };
    const staged = await this.backend.stageRecord?.(id, next);
    try {
      return await this.transaction(async () => {
        const final = await check();
        const reason = final.reason ?? beforeCommit();
        if (reason) return { reason };
        try {
          if (staged) await staged.commit();
          else await this.backend.putRecord(id, next);
        } catch (error) {
          // A lost commit acknowledgement may leave a manifest. Hide this
          // revision and remove only that revision if it is observable.
          this.uncertain.set(id, entry.revision);
          try {
            const actual = await this.get(entry.scope, entry.key);
            if (actual?.revision === entry.revision) await this.remove(actual);
            else this.uncertain.delete(id);
          } catch { /* Maintenance can retry the cleanup once the store responds. */ }
          throw error;
        }
        this.uncertain.delete(id);
        const token = this.observations.get(id);
        if (token) token.writes++;
        onPublished(next);
        return { entry: next };
      });
    } finally {
      await staged?.discard();
    }
  }

  transaction(operation) {
    const work = this.pending.then(operation);
    this.pending = work.catch(() => {});
    return work;
  }

  async entries(scope) {
    const entries = await this.backend.listRecords();
    return entries.filter(entry => entry && (!scope || entry.scope === scope));
  }

  failedCommit(entry) {
    return Boolean(entry.revision && this.uncertain.get(entry.scope + '-' + entry.key) === entry.revision);
  }
}

export function encodeRecord(value) {
  const data = Buffer.from(JSON.stringify(value));
  const hash = digest(value);
  const chunks = [];
  for (let i = 0; i < data.length; i += 12 * 1024) {
    chunks.push(data.subarray(i, i + 12 * 1024).toString('base64'));
  }
  return { manifest: { schema: 1, hash, chunks: chunks.length }, chunks };
}

export function decodeRecord(manifest, chunks) {
  if (manifest.schema !== 1 || !Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1 || chunks.length !== manifest.chunks) {
    throw new CacheError('CorruptCache', 'Invalid record manifest');
  }
  const value = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.trim(), 'base64'))).toString());
  if (digest(value) !== manifest.hash) throw new CacheError('CorruptCache', 'Record checksum mismatch');
  return value;
}
