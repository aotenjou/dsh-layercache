import { randomUUID } from 'node:crypto';
import { PrefixStore } from './store.js';
import { copy, digest, requireString, CacheError } from './identity.js';

export class LayerCache {
  constructor({ backend, registry, baseRef, namespace = 'default', context = {}, ttlMs = null, maxRollouts = 1024 }) {
    this.backend = backend; this.registry = registry; this.baseRef = requireString(baseRef, 'baseRef');
    this.namespace = requireString(namespace, 'namespace'); this.context = copy(context);
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) throw new CacheError('InvalidInput', 'ttlMs must be positive');
    if (!Number.isSafeInteger(maxRollouts) || maxRollouts < 1) throw new CacheError('InvalidInput', 'maxRollouts must be a positive integer');
    this.ttlMs = ttlMs; this.store = new PrefixStore(backend); this.inflight = new Map();
    this.active = new Set(); this.closed = false;
    this.rollouts = new Map(); this.maxRollouts = maxRollouts;
    this.metrics = { requests: 0, hits: 0, misses: 0, executions: 0, coalesced: 0, savedExecutionMs: 0 };
  }
  scope(task) { return digest({ schema: 1, namespace: this.namespace, task: requireString(task, 'task'), baseRef: this.baseRef, tools: this.registry.fingerprint(), context: this.context, epoch: this.ttlMs ? Math.floor(Date.now() / this.ttlMs) : null }); }
  openRollout(task) {
    if (this.closed) throw new CacheError('Closed', 'Cache is closed');
    if (this.rollouts.size >= this.maxRollouts) throw new CacheError('Capacity', 'Close an existing rollout before opening another');
    const scope = this.scope(task), rollout = randomUUID();
    this.rollouts.set(rollout, { task, scope, steps: [], stateKey: 'root', ref: this.baseRef, reusable: true, pending: Promise.resolve(), accepting: true, failure: null });
    return { rollout, task, scope };
  }
  async closeRollout(rollout) {
    const state = this.rollouts.get(rollout);
    if (!state) throw new CacheError('UnknownRollout', 'Rollout is absent or the service restarted; do not automatically replay external effects');
    state.accepting = false;
    await state.pending;
    this.rollouts.delete(rollout);
  }
  run(task, history, { rollout } = {}) {
    if (this.closed) return Promise.reject(new CacheError('Closed', 'Cache is closed'));
    let work;
    if (rollout === undefined) work = this._run(task, history);
    else {
      const state = this.rollouts.get(rollout);
      if (!state || !state.accepting) return Promise.reject(new CacheError('UnknownRollout', 'Rollout is absent/closed or the service restarted; do not automatically replay external effects'));
      let frozen;
      try { frozen = copy(history); } catch (e) { return Promise.reject(new CacheError('InvalidInput', e.message)); }
      work = state.pending.then(() => this._run(task, frozen, state));
      state.pending = work.catch(() => {});
    }
    this.active.add(work);
    work.then(() => this.active.delete(work), () => this.active.delete(work));
    return work;
  }
  async _run(task, history, session) {
    if (!Array.isArray(history) || history.length === 0) throw new CacheError('InvalidInput', 'history must contain at least one call');
    // Validate the whole request before executing anything.
    const calls = history.map(c => this.registry.resolve(c));
    if (session?.failure) throw new CacheError('RolloutFailed', 'A previous tool execution failed; inspect its effects before opening a new rollout', { cause: session.failure });
    if (session && task !== session.task) throw new CacheError('InvalidInput', 'Rollout belongs to a different task');
    if (session && (calls.length < session.steps.length || session.steps.some((s, i) => digest(s.call) !== digest(calls[i].call)))) throw new CacheError('InvalidInput', 'A rollout history may only append calls; use a separate rollout for divergence');
    const scope = session?.scope ?? this.scope(task);
    let stateKey = session?.stateKey ?? 'root', ref = session?.ref ?? this.baseRef, reusable = session?.reusable ?? true;
    const steps = session ? session.steps.map(s => ({ ...copy(s), hit: true, source: 'rollout' })) : [];
    this.metrics.requests++;
    for (const { tool, call } of calls.slice(steps.length)) {
      reusable = reusable && tool.cacheable && call.cache;
      const key = digest({ parent: stateKey, call: { name: call.name, arguments: call.arguments }, version: tool.version });
      let entry, hit = false;
      if (reusable) {
        entry = await this.store.get(scope, key);
        if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
          // Expiry invalidates the remainder: new execution may produce a new state.
          reusable = false; entry = null;
        }
      }
      if (entry) { hit = true; this.metrics.hits++; this.metrics.savedExecutionMs += entry.executionMs; }
      else if (reusable && this.inflight.has(`${scope}:${key}`)) {
        try { entry = await this.inflight.get(`${scope}:${key}`); }
        catch (error) { if (session) session.failure = { code: error.code ?? 'ToolError', message: error.message }; throw error; }
        hit = true; this.metrics.hits++; this.metrics.coalesced++;
      } else {
        this.metrics.misses++;
        const work = this.execute({ scope, key, parent: stateKey, ref, tool, call, reusable });
        if (reusable) this.inflight.set(`${scope}:${key}`, work);
        try { entry = await work; }
        catch (error) { if (session) session.failure = { code: error.code ?? 'ToolError', message: error.message }; throw error; }
        finally { if (reusable) this.inflight.delete(`${scope}:${key}`); }
      }
      ref = entry.ref;
      const step = { call: copy(call), value: copy(entry.value), hit, source: hit ? 'cache' : 'execution', ref, key, executionMs: entry.executionMs };
      steps.push(step);
      // Read-only calls are leaves off the mutation chain, as in TVCache.
      if (tool.mutates) stateKey = reusable ? key : randomUUID();
      if (session) { session.steps.push(copy(step)); Object.assign(session, { stateKey, ref, reusable }); }
    }
    return { task, scope, value: steps.at(-1).value, ref, steps, hits: steps.filter(s => s.hit).length, executed: steps.filter(s => !s.hit).length };
  }
  async execute({ scope, key, parent, ref, tool, call, reusable }) {
    const env = await this.backend.fork(ref);
    const started = performance.now();
    let value, nextRef;
    try {
      value = copy(await tool.execute(this.environment(env, tool.mutates), copy(call.arguments)));
      nextRef = await env.snapshot();
      if (!tool.mutates && nextRef !== ref) throw new CacheError('ReadOnlyViolation', `${tool.name} changed filesystem state`);
      this.metrics.executions++;
    } finally { await env.close(); }
    const createdAt = Date.now();
    const entry = { schema: 1, scope, key, parent, call, mutates: tool.mutates, value, ref: nextRef, executionMs: performance.now() - started, createdAt, expiresAt: this.ttlMs ? createdAt + this.ttlMs : null };
    return reusable ? this.store.put(entry) : entry;
  }
  environment(env, mutates) {
    const assertWrite = () => { if (!mutates) throw new CacheError('ReadOnlyViolation', 'Read-only tool attempted a write or shell command'); };
    return Object.freeze({ read: path => env.read(path), write: (path, content) => { assertWrite(); return env.write(path, content); }, exec: command => { assertWrite(); return env.exec(command); } });
  }
  async tree(task) {
    const scope = task ? this.scope(task) : undefined;
    return { schema: 1, nodes: await this.store.entries(scope) };
  }
  stats() { return { ...this.metrics, inflight: this.inflight.size, rollouts: this.rollouts.size }; }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => { await Promise.allSettled([...this.active]); await this.store.pending; this.rollouts.clear(); await this.backend.close(); })();
    return this.closing;
  }
}
