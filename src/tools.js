import { canonical, digest, requireString, copy, CacheError } from './identity.js';

export class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(name, { version, mutates = true, cacheable = true, execute }) {
    requireString(name, 'tool name'); requireString(version, 'tool version');
    if (this.tools.has(name) || typeof execute !== 'function' || typeof mutates !== 'boolean' || typeof cacheable !== 'boolean') throw new CacheError('InvalidInput', `Invalid/duplicate tool: ${name}`);
    this.tools.set(name, { name, version, mutates, cacheable, execute }); return this;
  }
  fingerprint() { return digest([...this.tools.values()].map(({ name, version, mutates, cacheable }) => ({ name, version, mutates, cacheable })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
  describe() { return [...this.tools.values()].map(({ name, version, mutates, cacheable }) => ({ name, version, mutates, cacheable })); }
  resolve(call) {
    if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).some(k => !['name', 'arguments', 'cache'].includes(k))) throw new CacheError('InvalidInput', 'A call is { name, arguments?, cache? }');
    const tool = this.tools.get(call.name);
    if (!tool) throw new CacheError('InvalidInput', `Unknown tool: ${call.name}`);
    const args = call.arguments === undefined ? {} : call.arguments;
    try { canonical(args); } catch (e) { throw new CacheError('InvalidInput', e.message); }
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new CacheError('InvalidInput', 'arguments must be an object');
    if (call.cache !== undefined && typeof call.cache !== 'boolean') throw new CacheError('InvalidInput', 'cache must be boolean');
    return { tool, call: { name: call.name, arguments: copy(args), cache: call.cache ?? true } };
  }
}

export function fileTools() {
  return new ToolRegistry()
    .register('file.write', { version: '1', execute: async (env, { path, content }) => { requireString(path, 'path'); if (typeof content !== 'string') throw new CacheError('InvalidInput', 'content must be a string'); await env.write(path, content); return { written: Buffer.byteLength(content) }; } })
    .register('file.read', { version: '1', mutates: false, execute: (env, { path }) => env.read(requireString(path, 'path')) })
    .register('file.append', { version: '1', execute: async (env, { path, content }) => { if (typeof content !== 'string') throw new CacheError('InvalidInput', 'content must be a string'); const old = await env.read(requireString(path, 'path')); await env.write(path, old + content); return { written: Buffer.byteLength(content) }; } })
    .register('shell', { version: '1', execute: async (env, { command }) => {
      const result = await env.exec(requireString(command, 'command'));
      if (result.exitCode !== 0) throw new CacheError('ToolFailed', `Command exited ${result.exitCode}`, result);
      return result;
    } });
}
