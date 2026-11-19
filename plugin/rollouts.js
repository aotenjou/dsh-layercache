import { CacheError, copy, requireString } from '../src/identity.js';

/** Session-owned rollout handles; failures and closed labels remain tombstones. */
export class Rollouts {
  constructor(client, { maxRollouts, allowedTools }) {
    this.client = client;
    this.maxRollouts = maxRollouts;
    this.allowed = new Set(allowedTools);
    this.states = new Map();
    this.closed = false;
  }
  key(owner, label) {
    return JSON.stringify([requireString(owner, 'dsh session'), requireString(label, 'rollout')]);
  }
  state(owner, label, task) {
    if (this.closed) throw new CacheError('Closed', 'Plugin is unloading');
    const key = this.key(owner, label);
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= this.maxRollouts) throw new CacheError('Capacity', 'Plugin rollout-label limit reached; reload only after all calls finish');
      state = { task: requireString(task, 'task_id'), pending: Promise.resolve(), handle: null, failure: null, closed: false };
      this.states.set(key, state);
    }
    if (state.task !== task) throw new CacheError('InvalidInput', 'A rollout label belongs to one task_id');
    return state;
  }
  run(owner, { task_id, rollout, history }, signal) {
    // Freeze and validate the complete history before opening any server session.
    const calls = copy(history);
    if (!Array.isArray(calls) || !calls.length) throw new CacheError('InvalidInput', 'history must contain at least one call');
    for (const call of calls) {
      if (!call || !this.allowed.has(call.name)) throw new CacheError('ToolDenied', `Tool is not in allowedTools: ${call?.name}`);
    }
    const state = this.state(owner, rollout, task_id);
    const work = state.pending.then(async () => {
      signal?.throwIfAborted();
      if (state.closed || state.failure) throw new CacheError('RolloutUnavailable', 'This rollout is closed or failed; inspect its effects and use a new label deliberately');
      try {
        if (!state.handle) {
          const opened = await this.client.request('/v1/rollouts', { task: task_id }, signal);
          state.handle = requireString(opened.rollout, 'server rollout');
        }
        const result = await this.client.request('/v1/run', { task: task_id, rollout: state.handle, history: calls }, signal);
        if (!Array.isArray(result.steps) || result.steps.length !== calls.length || typeof result.ref !== 'string' || !Number.isInteger(result.executed)) {
          throw new CacheError('ProtocolError', 'Invalid cache result; do not replay the request');
        }
        return { task_id, rollout, value: result.value, ref: result.ref, executed: result.executed,
          cache_hits: result.steps.filter(step => step.source === 'cache').length,
          continued: result.steps.filter(step => step.source === 'rollout').length };
      } catch (error) {
        state.failure = error.code ?? error.name;
        throw error;
      }
    });
    state.pending = work.then(() => {}, () => {});
    return work;
  }
  close(owner, label, signal) {
    const state = this.states.get(this.key(owner, label));
    if (!state) return Promise.reject(new CacheError('UnknownRollout', 'No rollout with this label belongs to the calling dsh session'));
    const work = state.pending.then(async () => {
      signal?.throwIfAborted();
      if (state.closed) return { rollout: label, closed: true };
      state.closed = true;
      if (state.handle) await this.client.request('/v1/rollouts/close', { rollout: state.handle }, signal);
      return { rollout: label, closed: true };
    });
    state.pending = work.then(() => {}, () => {});
    return work;
  }
  async dispose() {
    this.closed = true;
    // Drain accepted calls before closing their server sessions.
    await Promise.all([...this.states.values()].map(state => state.pending));
    const cleanup = [...this.states.values()].filter(state => !state.closed && state.handle).map(async state => {
      state.closed = true;
      await this.client.request('/v1/rollouts/close', { rollout: state.handle });
    });
    const results = await Promise.allSettled(cleanup);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Some server sessions could not be closed; inspect the service');
  }
}
