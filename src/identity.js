import { createHash } from 'node:crypto';

// Reject values JSON would silently drop/coerce: identity must describe execution.
export function canonical(value) {
  const parents = new Set();
  const encode = item => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (item && typeof item === 'object') {
      if (parents.has(item)) throw new TypeError('Cyclic JSON data');
      parents.add(item);
      try {
        if (Array.isArray(item)) return '[' + Array.from({ length: item.length }, (_, i) => encode(item[i])).join(',') + ']';
        if (Object.getPrototypeOf(item) === Object.prototype) return '{' + Object.keys(item).sort().map(k => JSON.stringify(k) + ':' + encode(item[k])).join(',') + '}';
      } finally { parents.delete(item); }
    }
    throw new TypeError('Expected finite JSON data (no undefined, bigint, functions, or class instances)');
  };
  return encode(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const copy = value => JSON.parse(canonical(value));
export class CacheError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'CacheError'; this.code = code; this.detail = detail; }
}
export function requireString(value, name) {
  if (typeof value !== 'string' || !value.length) throw new CacheError('InvalidInput', `${name} must be a nonempty string`);
  return value;
}
