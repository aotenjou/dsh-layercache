import { randomUUID } from 'node:crypto';
import { PrefixStore, entryExpired, isCompleteEntry } from './store.js';
import { copy, digest, requireString, CacheError } from './identity.js';
import { checkResources, dependencyList, resourceCatalog, resourceOutputs } from './resources.js';

function deadline(...values) {
  return values.reduce((earliest, value) => value === null ? earliest : Math.min(value, earliest ?? Infinity), null);
}

export class LayerCache {
  constructor({
    backend, registry, baseRef, namespace = 'default', context = {}, ttlMs = null,
    checkpointTtlMs = ttlMs, cleanupIntervalMs = 60_000, resources = [],
    maxRollouts = 1024, publicationCapacity = 256, publicationTimeoutMs = 60_000,
    clock = () => Date.now()
  }) {
    this.backend = backend;
    this.registry = registry;
    this.baseRef = requireString(baseRef, 'baseRef');
    this.namespace = requireString(namespace, 'namespace');
    this.context = copy(context);
    if (checkpointTtlMs !== null && (!Number.isSafeInteger(checkpointTtlMs) || checkpointTtlMs <= 0)) {
      throw new CacheError('InvalidInput', 'checkpointTtlMs must be a positive integer or null');
    }
    if (!Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs < 0 || cleanupIntervalMs > 2 ** 31 - 1) {
      throw new CacheError('InvalidInput', 'Invalid cleanupIntervalMs');
    }
    if (!Number.isSafeInteger(maxRollouts) || maxRollouts < 1) {
      throw new CacheError('InvalidInput', 'maxRollouts must be a positive integer');
    }
    for (const [name, value] of Object.entries({ publicationCapacity, publicationTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new CacheError('InvalidInput', name + ' must be a positive integer');
    }
    this.ttlMs = checkpointTtlMs;
    this.clock = clock;
    this.resources = resourceCatalog(resources);
    this.store = new PrefixStore(backend, options => this.prune(options));
    this.inflight = new Map();
    this.publications = new Map();
    this.publicationCapacity = publicationCapacity;
    this.publicationTimeoutMs = publicationTimeoutMs;
    this.publicationStats = { published: 0, skipped: 0, failed: 0, cancelled: 0, timedOut: 0, lastFailure: null };
    this.active = new Set();
    this.rollouts = new Map();
    this.maxRollouts = maxRollouts;
    this.executing = 0;
    this.maintenance = null;
    this.closed = false;
    this.metrics = { requests: 0, hits: 0, misses: 0, executions: 0, coalesced: 0, savedExecutionMs: 0, cleaned: 0, cleanupFailures: 0 };
    this.ready = this.initialize();
    this.ready.catch(() => {});
    this.cleanupTimer = cleanupIntervalMs ? setInterval(() => {
      this.cleanupExpired().catch(() => { this.metrics.cleanupFailures++; });
    }, cleanupIntervalMs) : null;
    this.cleanupTimer?.unref();
  }

  async initialize() {
    const saved = await this.backend.getResources?.();
    if (saved !== null && saved !== undefined) {
      for (const [name, resource] of resourceCatalog(saved)) this.resources.set(name, resource);
    }
    await this.cleanupExpired();
  }

  scope(task) {
    return digest({
      schema: 1, namespace: this.namespace, task: requireString(task, 'task'),
      baseRef: this.baseRef, tools: this.registry.fingerprint(), context: this.context
    });
  }

  prepare(task, candidateTools = [...this.registry.tools.keys()]) {
    const scope = this.scope(task);
    const tools = this.registry.preflight(candidateTools);
    return { task, scope, tools, unknown_tools: tools.filter(tool => tool.status === 'unknown').map(tool => tool.name) };
  }

  newState(task, candidateTools) {
    const preflight = this.prepare(task, candidateTools);
    return {
      task, scope: preflight.scope, preflight,
      candidates: new Set(preflight.tools.map(tool => tool.name)),
      unknown: new Set(preflight.unknown_tools),
      steps: [], ref: this.baseRef, parent: null, reusable: true,
      produced: new Map(), refs: new Set(),
      pending: Promise.resolve(), accepting: true, failure: null
    };
  }

  openRollout(task, candidateTools) {
    if (this.closed) throw new CacheError('Closed', 'Cache is closed');
    if (this.rollouts.size >= this.maxRollouts) {
      throw new CacheError('Capacity', 'Close an existing rollout before opening another');
    }
    const state = this.newState(task, candidateTools);
    const rollout = randomUUID();
    this.rollouts.set(rollout, state);
    return { rollout, task, scope: state.scope, preflight: state.preflight };
  }

  closeRollout(rollout) {
    const state = this.rollouts.get(rollout);
    if (!state) return Promise.reject(new CacheError('UnknownRollout', 'Rollout is absent or the service restarted'));
    if (state.closing) return state.closing;
    state.accepting = false;
    state.closing = this.track(state.pending.then(async () => {
      this.rollouts.delete(rollout);
      if (state.refs.size && this.backend.releaseSnapshot) await this.cleanupExpired();
    }));
    return state.closing;
  }

  track(work) {
    this.active.add(work);
    work.then(() => this.active.delete(work), () => this.active.delete(work));
    return work;
  }

  run(task, history, { rollout, candidateTools } = {}) {
    if (this.closed) return Promise.reject(new CacheError('Closed', 'Cache is closed'));
    try {
      const state = rollout === undefined ? this.newState(task, candidateTools) : this.rollouts.get(rollout);
      if (!state?.accepting) throw new CacheError('UnknownRollout', 'Rollout is absent, closed or the service restarted');
      if (state.task !== task) throw new CacheError('InvalidInput', 'Rollout belongs to a different task');
      if (rollout !== undefined && candidateTools !== undefined &&
          digest(this.prepare(task, candidateTools).tools) !== digest(state.preflight.tools)) {
        throw new CacheError('InvalidInput', 'candidate_tools must be fixed when a rollout starts');
      }
      if (!Array.isArray(history) || !history.length) {
        throw new CacheError('InvalidInput', 'history must contain at least one call');
      }
      const calls = history.map(call => this.registry.resolve(call));
      const work = state.pending.then(() => this.runHistory(state, calls));
      state.pending = work.catch(() => {});
      return this.track(work);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async runHistory(state, calls) {
    await this.ready;
    while (this.maintenance) await this.maintenance;
    if (state.failure) {
      throw new CacheError('RolloutFailed', 'A previous tool execution failed; inspect its effects before opening a new rollout', { cause: state.failure });
    }
    if (calls.length < state.steps.length ||
        state.steps.some((step, index) => digest(step.call) !== digest(calls[index].call))) {
      throw new CacheError('InvalidInput', 'A rollout history may only append calls; use a separate rollout for divergence');
    }
    this.executing++;
    try {
      this.metrics.requests++;
      const steps = state.steps.map(step => ({ ...copy(step), hit: true, source: 'rollout' }));
      for (const resolved of calls.slice(steps.length)) {
        steps.push(await this.runStep(state, resolved));
      }
      return {
        task: state.task, scope: state.scope, value: steps.at(-1).value, ref: state.ref,
        steps, hits: steps.filter(step => step.hit).length, executed: steps.filter(step => !step.hit).length,
        unknown_tools: [...state.unknown].sort()
      };
    } finally {
      this.executing--;
      if (!this.executing) this.resolveDrain?.();
    }
  }

  dependencies(state, names) {
    return dependencyList({
      get: name => this.resources.get(name) ?? state.produced.get(name)
    }, names).map(resource => ({ ...resource, shared: this.resources.has(resource.name) }));
  }

  dependenciesValid(expected, state) {
    return expected.every(resource => {
      const current = this.resources.get(resource.name) ?? state.produced.get(resource.name);
      return current && current.version === resource.version && current.expiresAt === resource.expiresAt &&
        this.resources.has(resource.name) === resource.shared &&
        (current.expiresAt === null || current.expiresAt > this.clock());
    });
  }

  async liveParent(state) {
    if (!state.parent) return true;
    const { parent } = state;
    const pending = this.publications.get(parent.revision);
    if (pending && pending.entry.scope === state.scope && pending.entry.key === parent.key) {
      const reason = this.publicationInvalid(pending);
      if (reason) {
        this.cancelPublication(pending, reason);
        return false;
      }
      return true;
    }
    if (entryExpired(parent, this.clock()) || !this.sharedInputsValid(parent.sharedInputs)) return false;
    const current = await this.store.get(state.scope, parent.key);
    return current?.revision === parent.revision && !this.store.failedCommit(current) && !entryExpired(parent, this.clock()) &&
      this.sharedInputsValid(parent.sharedInputs);
  }

  sharedInputsValid(inputs) {
    return inputs.every(resource => {
      const current = this.resources.get(resource.name);
      return current && current.version === resource.version && current.expiresAt === resource.expiresAt &&
        (current.expiresAt === null || current.expiresAt > this.clock());
    });
  }

  async runStep(state, { tool, call, replayable }) {
    if (!state.candidates.has(call.name)) {
      state.candidates.add(call.name);
      state.unknown.add(call.name);
    }
    if (tool.randomness === 'unknown') state.unknown.add(call.name);
    const dependencies = this.dependencies(state, tool.resources.requires);
    checkResources(dependencies, this.clock(), 'beforeExecution');

    const inputRef = state.ref;
    const parent = state.parent?.key ?? 'root';
    const parentRevision = state.parent?.revision ?? null;
    const policyFingerprint = digest({
      version: tool.version, mutates: tool.mutates, randomness: tool.randomness,
      replayVersion: tool.replayVersion ?? null, effects: tool.effects, resources: tool.resources,
      ttlMs: this.ttlMs, checkpointTtlMs: tool.checkpointTtlMs
    });
    const key = digest({ schema: 2, parent, inputRef, call: { name: call.name, arguments: call.arguments }, version: tool.version });
    const input = { state, key, parent, parentRevision, inputRef, tool, call, dependencies, policyFingerprint };
    let result;
    const mayShare = state.reusable && !state.unknown.has(call.name) && tool.cacheable &&
      call.cache && replayable && tool.effects !== 'execution-required';
    try {
      result = mayShare ? await this.sharedStep(input) : { entry: await this.execute(input), hit: false, shared: false };
    } catch (error) {
      if (error.detail?.phase !== 'beforeExecution') {
        state.failure = { code: error.code ?? 'ToolError', message: error.message };
      }
      throw error;
    }

    const { entry, hit, shared, publication = 'skipped' } = result;
    state.reusable = shared;
    for (const resource of entry.producedResources) state.produced.set(resource.name, resource);
    if (tool.mutates) {
      state.ref = entry.ref;
      state.parent = entry;
    }
    state.refs.add(entry.ref);
    const step = {
      call: copy(call), value: copy(entry.value), hit, source: hit ? 'cache' : 'execution',
      ref: state.ref, key, executionMs: entry.executionMs, inputRef, expiresAt: entry.expiresAt,
      dependencies: copy(entry.dependencies), producedResources: copy(entry.producedResources), publication,
      ...(publication !== 'skipped' && { revision: entry.revision }),
      ...(publication === 'published' && { generation: entry.generation })
    };
    state.steps.push(copy(step));
    if (hit) {
      this.metrics.hits++;
      if (!result.coalesced) this.metrics.savedExecutionMs += entry.executionMs;
    } else {
      this.metrics.misses++;
    }
    return step;
  }

  usable(entry, input) {
    return isCompleteEntry(entry) && !this.store.failedCommit(entry) && entry.scope === input.state.scope &&
      entry.key === input.key && entry.parent === input.parent && entry.parentRevision === input.parentRevision &&
      entry.inputRef === input.inputRef && entry.policyFingerprint === input.policyFingerprint &&
      entry.mutates === input.tool.mutates && (entry.mutates || entry.ref === input.inputRef) &&
      !entryExpired(entry, this.clock()) && digest(entry.dependencies) === digest(input.dependencies) &&
      this.dependenciesValid(entry.dependencies, input.state) && this.sharedInputsValid(entry.sharedInputs);
  }

  async sharedStep(input) {
    const { state, key, inputRef, parentRevision, policyFingerprint } = input;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { dependencies } = input;
      const id = digest([state.scope, key, inputRef, parentRevision, dependencies, policyFingerprint]);
      // Start asynchronously so even a synchronous backend lookup sees the registered flight.
      let flight = this.inflight.get(id);
      const joined = Boolean(flight);
      if (!flight) {
        flight = Promise.resolve().then(() => this.lookupOrExecute(input));
        this.inflight.set(id, flight);
        const clear = () => { if (this.inflight.get(id) === flight) this.inflight.delete(id); };
        flight.then(clear, clear);
      }
      const result = await flight;
      if ((result.job || result.hit || result.joinable) && await this.liveParent(state)) {
        const job = result.job;
        const reason = job && !job.published && this.publicationInvalid(job);
        if (reason) this.cancelPublication(job, reason);
        const entry = job?.published ?? result.entry;
        const shared = job ? !reason : result.hit;
        if ((shared || result.joinable) && this.usable(entry, input)) {
          if (joined) this.metrics.coalesced++;
          let publication = 'skipped';
          if (shared) publication = job && !job.published ? 'pending' : 'published';
          return { entry, shared, publication, hit: result.hit || joined, coalesced: joined && !result.hit };
        }
      }
      if (!joined && result.executed) return { entry: result.entry, hit: false, shared: false };

      const current = this.dependencies(state, input.tool.resources.requires);
      checkResources(current, this.clock(), 'beforeExecution');
      input = { ...input, dependencies: current };
      if (!await this.liveParent(state)) {
        return { entry: await this.execute(input), hit: false, shared: false };
      }
    }
    throw new CacheError('CheckpointExpired', 'A reusable checkpoint expired before it could be accepted');
  }

  async lookupOrExecute(input) {
    const { state, key } = input;
    if (!await this.liveParent(state)) return {};
    const observation = this.store.observe(state.scope, key);
    let job;
    try {
      let existing;
      for (;;) {
        const pending = this.pendingMatch(input);
        if (pending) return { entry: pending.entry, hit: true, job: pending };
        const writes = observation.writes();
        existing = await this.store.get(state.scope, key);
        if (this.usable(existing, input)) return { entry: existing, hit: true };
        const queued = this.pendingMatch(input);
        if (queued) return { entry: queued.entry, hit: true, job: queued };
        if (writes === observation.writes()) break;
      }
      const entry = await this.execute(input);
      if (entryExpired(entry, this.clock()) || !observation.valid() || !await this.liveParent(state) ||
          !this.usable(entry, input)) return { entry, executed: true };
      job = this.enqueuePublication(entry, existing, observation, {
        ...input, state: { scope: state.scope, parent: state.parent, produced: new Map(state.produced) }
      });
      return { entry, hit: false, executed: true, job, joinable: !job };
    } finally {
      if (!job) observation.release();
    }
  }

  pendingMatch(input) {
    for (const job of this.publications.values()) {
      const { entry } = job;
      if (entry.scope !== input.state.scope || entry.key !== input.key) continue;
      const reason = this.publicationInvalid(job);
      if (reason) this.cancelPublication(job, reason);
      else if (this.usable(entry, input)) return job;
    }
    return null;
  }

  enqueuePublication(entry, observed, observation, input) {
    // A cancelled writer can still own an outstanding backend operation.
    const cancelledWriter = this.writing?.cancelled ? 1 : 0;
    if (this.publications.size + cancelledWriter >= this.publicationCapacity) {
      this.publicationStats.skipped++;
      return null;
    }
    const job = { entry, observed, observation, input, deadline: this.clock() + this.publicationTimeoutMs };
    this.publications.set(entry.revision, job);
    this.schedulePublications();
    return job;
  }

  schedulePublications() {
    this.publicationWorker ??= new Promise(resolve => setImmediate(resolve)).then(() => this.publishQueued())
      .finally(() => {
        this.publicationWorker = null;
        if (this.publications.size) this.schedulePublications();
      });
  }

  publicationInvalid(job) {
    const { entry, input } = job;
    if (job.cancelled) return job.cancelled;
    if (!job.committing && this.clock() >= job.deadline) return 'timeout';
    if (entryExpired(entry, this.clock()) || !this.dependenciesValid(entry.dependencies, input.state) ||
        !this.sharedInputsValid(entry.sharedInputs)) return 'stale';
    if (!job.observation.valid()) return 'conflict';
    const parent = this.publications.get(entry.parentRevision);
    return parent && this.publicationInvalid(parent) ? 'parent' : null;
  }

  cancelPublication(job, reason) {
    if (job.cancelled || job.published || job.committing) return;
    job.cancelled = reason;
    this.publications.delete(job.entry.revision);
    if (this.writing !== job) job.observation.release();
    if (reason === 'timeout') this.publicationStats.timedOut++;
    else if (reason !== 'failure') this.publicationStats.cancelled++;
    for (const child of this.publications.values()) {
      if (child.entry.parentRevision === job.entry.revision) this.cancelPublication(child, 'parent');
    }
  }

  async publishQueued() {
    for (const job of this.publications.values()) {
      const { entry, observed, observation, input } = job;
      this.writing = job;
      try {
        const result = await this.store.publish(entry, {
          observed,
          observation,
          usable: current => this.usable(current, input),
          validate: async () => {
            const reason = this.publicationInvalid(job);
            if (reason) return reason;
            const parent = input.state.parent;
            if (!parent) return null;
            const durable = await this.store.get(entry.scope, parent.key);
            const parentMatches = durable?.revision === entry.parentRevision &&
              durable.ref === entry.inputRef && !this.store.failedCommit(durable);
            return parentMatches ? null : 'parent';
          },
          beforeCommit: () => {
            const reason = this.publicationInvalid(job);
            if (!reason) job.committing = true;
            return reason;
          },
          onPublished: published => {
            job.published = published;
            this.publicationStats.published++;
          }
        });
        if (result.reason) this.cancelPublication(job, result.reason);
      } catch (error) {
        job.committing = false;
        this.publicationStats.failed++;
        this.publicationStats.lastFailure = { scope: entry.scope, key: entry.key, revision: entry.revision,
          code: error.code ?? error.name };
        this.cancelPublication(job, 'failure');
      } finally {
        this.publications.delete(entry.revision);
        observation.release();
        this.writing = null;
      }
    }
  }

  async drainPublications() {
    while (this.publicationWorker) await this.publicationWorker;
  }

  async execute(input) {
    const { state, key, parent, parentRevision, inputRef, tool, call, dependencies, policyFingerprint } = input;
    const current = this.dependencies(state, tool.resources.requires);
    checkResources(current, this.clock(), 'beforeExecution');
    if (digest(current) !== digest(dependencies)) {
      throw new CacheError('ResourceChanged', 'Resource versions changed before execution', { phase: 'beforeExecution' });
    }
    const env = await this.backend.fork(inputRef);
    const started = performance.now();
    const output = resourceOutputs(tool.resources, dependencies);
    let value, ref, producedResources;
    try {
      value = copy(await tool.execute(this.environment(env, tool, dependencies, output), copy(call.arguments)));
      producedResources = output.finish();
      ref = await env.snapshot();
      if (!tool.mutates && ref !== inputRef) {
        throw new CacheError('ReadOnlyViolation', 'Read-only tool changed the filesystem checkpoint');
      }
      this.metrics.executions++;
    } finally {
      await env.close();
    }
    const createdAt = this.clock();
    checkResources([...dependencies, ...producedResources], createdAt, 'afterExecution');
    if (!this.dependenciesValid(dependencies, state)) {
      throw new CacheError('ResourceChanged', 'Resource versions changed during execution', { phase: 'afterExecution' });
    }
    const inheritedInputs = state.parent?.sharedInputs ?? [];
    const sharedInputs = [...new Map([...inheritedInputs, ...dependencies.filter(resource => resource.shared)]
      .map(resource => [resource.name, resource])).values()];
    return {
      schema: 2, scope: state.scope, key, parent, parentRevision, revision: randomUUID(), generation: 0,
      call, mutates: tool.mutates, value, inputRef, ref, dependencies, producedResources,
      sharedInputs, policyFingerprint, executionMs: performance.now() - started, createdAt,
      expiresAt: deadline(
        state.parent?.expiresAt ?? null,
        this.ttlMs === null ? null : createdAt + this.ttlMs,
        tool.checkpointTtlMs === null ? null : createdAt + tool.checkpointTtlMs,
        ...dependencies.map(resource => resource.expiresAt),
        ...producedResources.map(resource => resource.expiresAt)
      )
    };
  }

  environment(env, tool, dependencies, output) {
    const assertWrite = () => {
      if (!tool.mutates) throw new CacheError('ReadOnlyViolation', 'Read-only tool attempted a write or shell command');
    };
    return Object.freeze({
      read: path => env.read(path),
      write: (path, content) => { assertWrite(); return env.write(path, content); },
      exec: command => { assertWrite(); return env.exec(command); },
      resources: Object.freeze({
        get: name => {
          const resource = dependencies.find(item => item.name === name);
          if (!resource) throw new CacheError('UndeclaredResourceDependency', 'Tool did not declare resource ' + name, { name });
          checkResources([resource], this.clock(), 'execution');
          const { shared, ...info } = resource;
          return info;
        },
        publish: (name, value) => { assertWrite(); output.publish(name, value); }
      })
    });
  }

  refreshResources(values) {
    if (this.closed) return Promise.reject(new CacheError('Closed', 'Cache is closed'));
    if (!Array.isArray(values)) throw new CacheError('InvalidInput', 'resources must be an array');
    const next = resourceCatalog(values);
    return this.track(this.ready.then(() => this.store.transaction(async () => {
      checkResources([...next.values()], this.clock(), 'refresh');
      const resources = new Map([...this.resources, ...next]);
      await this.backend.putResources?.([...resources.values()]);
      this.resources = resources;
      for (const job of this.publications.values()) {
        const reason = this.publicationInvalid(job);
        if (reason) this.cancelPublication(job, reason);
      }
      return { resources: this.resourceState() };
    })));
  }

  resourceState() {
    return [...this.resources.values()].map(copy).sort((a, b) => a.name.localeCompare(b.name));
  }

  cleanupExpired() {
    if (this.sweep) return this.sweep;
    return this.maintain(entries => {
      const now = this.clock();
      return this.invalidRecords(entries, entry => this.store.failedCommit(entry) ||
        (isCompleteEntry(entry) && entryExpired(entry, now)));
    }).then(result => { this.metrics.cleaned += result.removed; return result; });
  }

  async prune({ before = this.clock(), scope } = {}) {
    if (this.closed) throw new CacheError('Closed', 'Cache is closed');
    await this.ready;
    while (this.sweep) await this.sweep;
    const matches = entry => (!scope || entry.scope === scope) &&
      (entry.createdAt === undefined || entry.createdAt < before);
    return this.maintain(entries => this.invalidRecords(entries, matches), matches);
  }

  invalidRecords(entries, shouldRemove) {
    const entriesByKey = new Map(entries.filter(isCompleteEntry).map(entry => [entry.scope + '-' + entry.key, entry]));
    const valid = new Map();
    const invalidLineage = entry => {
      if (valid.has(entry)) return !valid.get(entry);
      valid.set(entry, false);
      const parent = entriesByKey.get(entry.scope + '-' + entry.parent);
      const dead = shouldRemove(entry) || (isCompleteEntry(entry) && entry.parent !== 'root' &&
        (!parent || parent.revision !== entry.parentRevision || parent.ref !== entry.inputRef || invalidLineage(parent)));
      valid.set(entry, !dead);
      return dead;
    };
    return entries.filter(invalidLineage);
  }

  maintain(select, prunePending) {
    const work = this.store.transaction(async () => {
      // Start blocking runs only once the transaction owns the store. A
      // running history can finish while maintenance holds this transaction.
      this.maintenance = work;
      if (this.executing) await new Promise(resolve => { this.resolveDrain = resolve; });
      const entries = await this.store.entries();
      const remove = new Set(select(entries));
      const removedRevisions = new Set([...remove].map(entry => entry.revision));
      for (const job of this.publications.values()) {
        const reason = (prunePending?.(job.entry) || removedRevisions.has(job.entry.parentRevision)) ?
          'pruned' : this.publicationInvalid(job);
        if (reason) this.cancelPublication(job, reason);
      }
      let removed = 0;
      for (const entry of remove) {
        await this.store.remove(entry);
        removed++;
      }
      const remaining = entries.filter(entry => !remove.has(entry));
      let reclaimedSnapshotCount = 0;
      if (this.backend.listSnapshots && this.backend.releaseSnapshot) {
        const refs = new Set([this.baseRef, this.backend.baseRef]);
        for (const entry of remaining) {
          refs.add(entry.ref);
          refs.add(entry.inputRef);
        }
        for (const state of this.rollouts.values()) for (const ref of state.refs) refs.add(ref);
        for (const job of [...this.publications.values(), ...(this.writing ? [this.writing] : [])]) {
          refs.add(job.entry.ref);
          refs.add(job.entry.inputRef);
        }
        for (const ref of await this.backend.listSnapshots()) {
          if (!refs.has(ref) && await this.backend.releaseSnapshot(ref)) reclaimedSnapshotCount++;
        }
      }
      const reclaimedChunks = await this.backend.cleanupBlobs?.() ?? 0;
      return { removed, reclaimedSnapshots: reclaimedSnapshotCount > 0, reclaimedSnapshotCount, reclaimedChunks };
    });
    this.sweep = work;
    const clear = () => {
      this.sweep = null;
      this.maintenance = null;
      this.resolveDrain = null;
    };
    work.then(clear, clear);
    return work;
  }

  async tree(task) {
    await this.ready;
    return this.store.transaction(async () => ({
      schema: 2, nodes: await this.store.entries(task ? this.scope(task) : undefined)
    }));
  }

  stats() {
    return { ...this.metrics, inflight: this.inflight.size, rollouts: this.rollouts.size,
      publications: { ...this.publicationStats, pending: this.publications.size } };
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.cleanupTimer);
    this.closing = (async () => {
      try {
        await Promise.allSettled([...this.active]);
        await this.ready.catch(() => {});
        await this.drainPublications();
        await this.store.pending;
        this.rollouts.clear();
        await this.cleanupExpired();
      } finally {
        await this.backend.close();
      }
    })();
    return this.closing;
  }
}
