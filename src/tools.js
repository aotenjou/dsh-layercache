import { canonical, digest, requireString, copy, CacheError } from './identity.js';
import { resourceDeclaration } from './resources.js';

const RANDOMNESS = new Set(['none', 'seeded', 'replayable', 'independent', 'unknown']);
const EFFECTS = new Set(['none', 'execution-required', 'replayable']);

export class ToolRegistry {
  constructor() { this.tools = new Map(); }

  register(name, {
    version,
    mutates = true,
    cacheable = true,
    randomness = 'unknown',
    replayVersion,
    effects = 'none',
    resources,
    checkpointTtlMs = null,
    execute
  }) {
    requireString(name, 'tool name');
    requireString(version, 'tool version');
    if (this.tools.has(name) || typeof execute !== 'function' || typeof mutates !== 'boolean' || typeof cacheable !== 'boolean') {
      throw new CacheError('InvalidInput', `Invalid/duplicate tool: ${name}`);
    }
    if (!RANDOMNESS.has(randomness) || !EFFECTS.has(effects)) {
      throw new CacheError('InvalidInput', `Invalid randomness or effects policy for ${name}`);
    }
    if (randomness === 'seeded' || randomness === 'replayable') requireString(replayVersion, 'replayVersion');
    else if (replayVersion !== undefined) throw new CacheError('InvalidInput', 'replayVersion requires seeded or replayable randomness');
    if (checkpointTtlMs !== null && (!Number.isSafeInteger(checkpointTtlMs) || checkpointTtlMs <= 0)) {
      throw new CacheError('InvalidInput', 'checkpointTtlMs must be a positive integer or null');
    }
    const resourceSpec = resourceDeclaration(resources);
    if (!mutates && (effects !== 'none' || resourceSpec.produces.length)) {
      throw new CacheError('InvalidInput', 'Tools with effects or resource outputs must declare mutates: true');
    }
    this.tools.set(name, {
      name, version, mutates, cacheable, randomness, replayVersion, effects,
      resources: resourceSpec, checkpointTtlMs, execute
    });
    return this;
  }

  fingerprint() {
    return digest([...this.tools.values()]
      .map(({ name, version, mutates, cacheable }) => ({ name, version, mutates, cacheable }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  describe() {
    return [...this.tools.values()].map(({ name, version, mutates, cacheable, randomness, replayVersion, effects, resources, checkpointTtlMs }) => ({
      name, version, mutates, cacheable, randomness,
      ...(replayVersion !== undefined && { replayVersion }),
      ...(effects !== 'none' && { effects }),
      ...(resources.requires.length || resources.produces.length ? { resources } : {}),
      ...(checkpointTtlMs !== null && { checkpointTtlMs })
    }));
  }

  preflight(candidateTools = []) {
    if (!Array.isArray(candidateTools)) throw new CacheError('InvalidInput', 'candidate_tools must be an array');
    const names = [...new Set(candidateTools.map(name => requireString(name, 'candidate tool')))].sort();
    return names.map(name => {
      const tool = this.tools.get(name);
      if (!tool) return { name, status: 'unknown', reason: 'not_registered' };
      return {
        name,
        status: tool.randomness === 'unknown' ? 'unknown'
          : !tool.cacheable || tool.effects === 'execution-required' ? 'barrier'
          : tool.randomness === 'seeded' ? 'cacheable_if_seeded'
          : ['none', 'replayable'].includes(tool.randomness) ? 'cacheable' : 'barrier',
        randomness: tool.randomness,
        effects: tool.effects,
        cacheable: tool.cacheable
      };
    });
  }

  resolve(call) {
    if (!call || typeof call !== 'object' || Array.isArray(call) ||
        Object.keys(call).some(k => !['name', 'arguments', 'cache'].includes(k))) {
      throw new CacheError('InvalidInput', 'A call is { name, arguments?, cache? }');
    }
    const tool = this.tools.get(call.name);
    if (!tool) throw new CacheError('InvalidInput', `Unknown tool: ${call.name}`);
    const args = call.arguments === undefined ? {} : call.arguments;
    try { canonical(args); } catch (e) { throw new CacheError('InvalidInput', e.message); }
    if (!args || Array.isArray(args) || typeof args !== 'object') {
      throw new CacheError('InvalidInput', 'arguments must be an object');
    }
    if (call.cache !== undefined && typeof call.cache !== 'boolean') {
      throw new CacheError('InvalidInput', 'cache must be boolean');
    }
    const seed = Object.hasOwn(args, 'seed') ? args.seed : undefined;
    if (tool.randomness === 'seeded' && seed !== undefined &&
        !Number.isSafeInteger(seed) && !(typeof seed === 'string' && seed.length)) {
      throw new CacheError('InvalidInput', 'A replay seed must be a safe integer or nonempty string');
    }
    const replayable = tool.randomness === 'none' || tool.randomness === 'replayable' ||
      (tool.randomness === 'seeded' && seed !== undefined && tool.replayVersion !== undefined);
    return {
      tool,
      replayable,
      call: { name: call.name, arguments: copy(args), cache: call.cache ?? true }
    };
  }
}

export function fileTools({ cacheShell = false } = {}) {
  return new ToolRegistry()
    .register('file.write', {
      version: '1',
      randomness: 'none',
      execute: async (env, { path, content }) => {
        requireString(path, 'path');
        if (typeof content !== 'string') throw new CacheError('InvalidInput', 'content must be a string');
        await env.write(path, content);
        return { written: Buffer.byteLength(content) };
      }
    })
    .register('file.read', {
      version: '1',
      mutates: false,
      randomness: 'none',
      execute: (env, { path }) => env.read(requireString(path, 'path'))
    })
    .register('file.append', {
      version: '1',
      randomness: 'none',
      execute: async (env, { path, content }) => {
        if (typeof content !== 'string') throw new CacheError('InvalidInput', 'content must be a string');
        const old = await env.read(requireString(path, 'path'));
        await env.write(path, old + content);
        return { written: Buffer.byteLength(content) };
      }
    })
    .register('shell', {
      version: '1',
      randomness: 'none',
      effects: cacheShell === true ? 'replayable' : 'execution-required',
      execute: async (env, { command }) => {
        const result = await env.exec(requireString(command, 'command'));
        if (result.exitCode !== 0) throw new CacheError('ToolFailed', `Command exited ${result.exitCode}`, result);
        return result;
      }
    });
}
