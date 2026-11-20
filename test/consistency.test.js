import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayerCache, fileTools, digest } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';

const read = { name: 'file.read', arguments: { path: '/value' } };
const append = { name: 'file.append', arguments: { path: '/value', content: '-next' } };
const gate = () => Promise.withResolvers();

async function fixture(t, registry, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'layercache-consistency-'));
  let current;
  const reopen = async () => {
    await current?.cache.close();
    const backend = await LocalBackend.open(dir);
    const cache = new LayerCache({ backend, registry, baseRef: backend.baseRef, cleanupIntervalMs: 0, ...options });
    await cache.ready;
    current = { cache, backend };
    return current;
  };
  t.after(async () => {
    await current?.cache.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ...await reopen(), reopen };
}

test('preflight tracks omitted and unknown tools and isolates independent random rollouts', async t => {
  let draws = 0;
  const registry = fileTools().register('sample', {
    version: '1', randomness: 'independent',
    execute: async env => {
      const value = String(++draws);
      await env.write('/value', value);
      return value;
    }
  }).register('unknown', { version: '1', mutates: false, execute: () => 'unknown' });
  const { cache } = await fixture(t, registry);
  const task = 'fixed';
  const candidates = ['sample', 'file.append', 'unknown', 'unregistered'];
  const preflight = cache.prepare(task, candidates);
  assert.equal(preflight.tools.find(tool => tool.name === 'sample').status, 'barrier');
  assert.equal(preflight.tools.find(tool => tool.name === 'unknown').randomness, 'unknown');
  assert.deepEqual(preflight.unknown_tools, ['unknown', 'unregistered']);
  const a = cache.openRollout(task, candidates);
  const b = cache.openRollout(task, candidates);
  const history = [{ name: 'sample' }];
  const results = await Promise.all([cache.run(task, history, a), cache.run(task, history, b)]);
  assert.deepEqual(results.map(result => result.value).sort(), ['1', '2']);
  const continued = await cache.run(task, [...history, append, read], a);
  assert.equal(continued.value, results[0].value + '-next');
  assert.deepEqual(continued.steps.map(step => step.source), ['rollout', 'execution', 'execution']);
  assert.ok(continued.unknown_tools.includes('file.read'));
  assert.equal(draws, 2);
  assert.equal((await cache.tree()).nodes.length, 0);

  const deterministic = [{ name: 'file.write', arguments: { path: '/value', content: 'fixed' } }];
  assert.equal((await cache.run(task, deterministic)).executed, 1);
  const omitted = await cache.run(task, [...deterministic, read], { candidateTools: ['file.write'] });
  assert.deepEqual(omitted.unknown_tools, ['file.read']);
  assert.deepEqual(omitted.steps.map(step => step.source), ['cache', 'execution']);
  await assert.rejects(cache.run(task, [...deterministic, { name: 'unregistered' }]), { code: 'InvalidInput' });
});

test('seeded and explicitly replayable tools restore the original observation and snapshot', async t => {
  let draws = 0;
  const execute = async (env, { seed }) => {
    const sample = String(seed ?? 'sample') + '-' + ++draws;
    await env.write('/value', sample);
    return sample;
  };
  const registry = fileTools()
    .register('seeded', { version: '1', randomness: 'seeded', replayVersion: 'rng-v1', execute })
    .register('replay', { version: '1', randomness: 'replayable', replayVersion: 'capture-v1', execute });
  const { cache } = await fixture(t, registry);
  for (const call of [{ name: 'seeded', arguments: { seed: 17 } }, { name: 'replay' }]) {
    const first = await cache.run('task', [call]);
    const second = await cache.run('task', [call, read]);
    assert.equal(second.value, first.value);
    assert.equal(second.ref, first.ref);
    assert.equal(second.steps[0].source, 'cache');
    assert.equal(second.steps[1].ref, second.steps[1].inputRef);
  }
  assert.equal(draws, 2);
  const one = await cache.run('task', [{ name: 'seeded' }]);
  const two = await cache.run('task', [{ name: 'seeded' }]);
  assert.notEqual(one.value, two.value);
});

test('shared resource refresh prevents stale descendants even when the filesystem hash is equal', async t => {
  let writes = 0;
  const registry = fileTools().register('sync', {
    version: '1', randomness: 'none', resources: { requires: ['catalog'] },
    execute: async env => {
      writes++;
      await env.write('/value', 'same');
      return env.resources.get('catalog').version;
    }
  });
  let now = 1000;
  const { cache, reopen } = await fixture(t, registry, {
    clock: () => now, resources: [{ name: 'catalog', version: 'v1', expiresAt: 1010 }]
  });
  const calls = [{ name: 'sync' }, read];
  const first = await cache.run('fixed', calls);
  assert.equal((await cache.run('fixed', calls)).hits, 2);
  await cache.drainPublications();
  const session = cache.openRollout('fixed');
  await cache.run('fixed', [{ name: 'sync' }], session);
  now = 1010;
  await assert.rejects(cache.run('fixed', calls), {
    code: 'ResourceExpired',
    detail: { name: 'catalog', version: 'v1', expiresAt: 1010, shared: true, phase: 'beforeExecution' }
  });
  await cache.refreshResources([{ name: 'catalog', version: 'v2', expiresAt: 1020 }]);
  const fresh = await cache.run('fixed', calls);
  assert.equal(fresh.scope, first.scope);
  assert.equal(fresh.ref, first.ref);
  assert.equal(fresh.steps[0].value, 'v2');
  assert.equal(fresh.hits, 0);
  assert.equal(fresh.steps[0].publication, 'pending');
  assert.equal(fresh.steps[0].generation, undefined);
  await cache.drainPublications();
  assert.equal((await cache.run('fixed', calls)).steps[0].generation, 2);
  assert.equal((await cache.run('fixed', calls, session)).steps[0].value, 'v1');
  assert.equal(writes, 2);
  const { cache: restarted } = await reopen();
  assert.equal((await restarted.run('fixed', calls)).hits, 2);
  assert.equal(restarted.resourceState()[0].version, 'v2');
});

test('expired live external resource can be refreshed before retrying the same rollout', async t => {
  let now = 100;
  const registry = fileTools().register('external', {
    version: '1', randomness: 'none', mutates: false, resources: { requires: ['cursor'] },
    execute: env => env.resources.get('cursor').version
  });
  const { cache } = await fixture(t, registry, {
    clock: () => now, resources: [{ name: 'cursor', version: 'a', expiresAt: 110 }]
  });
  const session = cache.openRollout('task');
  const history = [{ name: 'external' }];
  assert.equal((await cache.run('task', history, session)).value, 'a');
  now = 110;
  history.push({ name: 'external' });
  await assert.rejects(cache.run('task', history, session), { code: 'ResourceExpired' });
  await cache.refreshResources([{ name: 'cursor', version: 'b' }]);
  const result = await cache.run('task', history, session);
  assert.equal(result.steps[0].source, 'rollout');
  assert.equal(result.value, 'b');
});

test('TTL invalidates descendants at the boundary and preserves active rollout snapshots', async t => {
  let now = 100;
  let writes = 0;
  const registry = fileTools().register('temporary', {
    version: '1', randomness: 'replayable', replayVersion: '1', checkpointTtlMs: 10,
    execute: async env => { const value = String(++writes); await env.write('/value', value); return value; }
  });
  const { cache, backend, reopen } = await fixture(t, registry, { clock: () => now });
  const session = cache.openRollout('task');
  const history = [{ name: 'temporary' }, append];
  const old = await cache.run('task', history, session);
  await cache.drainPublications();
  now = 109;
  assert.equal((await cache.run('task', history)).hits, 2);
  now = 110;
  assert.equal((await cache.cleanupExpired()).removed, 2);
  assert.ok((await backend.listSnapshots()).includes(old.ref));
  const next = await cache.run('task', history);
  assert.equal(next.hits, 0);
  assert.equal(next.value.written, 5);
  assert.notEqual(next.ref, old.ref);
  const continued = await cache.run('task', [...history, read], session);
  assert.equal(continued.value, '1-next');
  assert.equal(continued.steps[2].source, 'execution');
  await cache.closeRollout(session.rollout);
  assert.ok(!(await backend.listSnapshots()).includes(old.ref));
  const { cache: restarted } = await reopen();
  now = 120;
  // Open after the deadline to exercise startup cleanup as well as live cleanup.
  const { cache: startup } = await reopenWithoutExpiredSweep(restarted, reopen, now);
  assert.equal((await startup.tree()).nodes.length, 0);
  assert.equal(startup.stats().cleaned, 2);
});

async function reopenWithoutExpiredSweep(cache, reopen, timestamp) {
  cache.clock = () => timestamp - 1;
  return reopen();
}

test('inflight joins before lookup and rechecks an expired result before accepting it', async t => {
  let now = 100;
  let executions = 0;
  const registry = fileTools().register('draw', {
    version: '1', randomness: 'replayable', replayVersion: '1', checkpointTtlMs: 5,
    execute: async env => {
      const result = String(++executions);
      await env.write('/value', result);
      return result;
    }
  });
  const { cache, backend } = await fixture(t, registry, { clock: () => now });
  const history = [{ name: 'draw' }];
  const firstLookup = gate(), finishLookup = gate();
  const originalGet = backend.getRecord.bind(backend);
  let lookups = 0;
  backend.getRecord = async key => {
    if (++lookups === 1) {
      firstLookup.resolve();
      await finishLookup.promise;
    }
    return originalGet(key);
  };
  const first = cache.run('t', history);
  await firstLookup.promise;
  const second = cache.run('t', history);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 1);
  finishLookup.resolve();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.value), ['1', '1']);
  assert.equal(executions, 1);
  assert.equal(cache.stats().coalesced, 1);
  await cache.drainPublications();

  const validating = gate(), validate = gate();
  const originalUsable = cache.usable.bind(cache);
  const originalParent = cache.liveParent.bind(cache);
  let found = false;
  cache.usable = (entry, input) => {
    const result = originalUsable(entry, input);
    if (result && !found) found = true;
    return result;
  };
  let paused = false;
  cache.liveParent = async state => {
    if (found && !paused) {
      paused = true;
      validating.resolve();
      await validate.promise;
    }
    return originalParent(state);
  };
  const delayed = cache.run('t', history);
  await validating.promise;
  now = 105;
  validate.resolve();
  const renewed = await delayed;
  assert.equal(renewed.value, '2');
  assert.equal(renewed.steps[0].publication, 'pending');
  await cache.drainPublications();
  assert.equal((await cache.run('t', history)).steps[0].generation, 2);
  assert.equal((await cache.run('t', [...history, read])).value, '2');
});

test('conditional publication rejects a late execution from the old resource version', async t => {
  const started = gate(), finish = gate();
  const registry = fileTools().register('work', {
    version: '1', randomness: 'none', resources: { requires: ['version'] },
    execute: async env => {
      const version = env.resources.get('version').version;
      if (version === 'old') { started.resolve(); await finish.promise; }
      await env.write('/value', version);
      return version;
    }
  });
  const { cache } = await fixture(t, registry, { resources: [{ name: 'version', version: 'old' }] });
  const history = [{ name: 'work' }];
  const late = assert.rejects(cache.run('task', history), { code: 'ResourceChanged' });
  await started.promise;
  await cache.refreshResources([{ name: 'version', version: 'new' }]);
  const winner = await cache.run('task', history);
  finish.resolve();
  await late;
  assert.equal((await cache.run('task', [...history, read])).value, 'new');
  await cache.drainPublications();
  assert.equal((await cache.tree()).nodes.find(node => node.key === winner.steps[0].key).ref, winner.ref);
});

test('a newer publication wins while the old publisher is paused before the write queue', async t => {
  const publishing = gate(), finish = gate();
  const registry = fileTools().register('work', {
    version: '1', randomness: 'none', resources: { requires: ['catalog'] },
    execute: async env => {
      const version = env.resources.get('catalog').version;
      await env.write('/value', version);
      return version;
    }
  });
  const { cache, backend } = await fixture(t, registry, { resources: [{ name: 'catalog', version: 'old' }] });
  const stage = backend.stageRecord.bind(backend);
  backend.stageRecord = async (key, entry) => {
    const staged = await stage(key, entry);
    if (entry.value === 'old') { publishing.resolve(); await finish.promise; }
    return staged;
  };
  const history = [{ name: 'work' }];
  const accepted = await cache.run('task', history);
  assert.equal(accepted.value, 'old');
  assert.equal(accepted.steps[0].publication, 'pending');
  await publishing.promise;
  await cache.refreshResources([{ name: 'catalog', version: 'new' }]);
  const fresh = await cache.run('task', history);
  finish.resolve();
  await cache.drainPublications();
  const [stored] = (await cache.tree()).nodes;
  assert.equal(stored.value, 'new');
  assert.equal(stored.ref, fresh.ref);
  assert.equal(stored.revision, fresh.steps[0].revision);
});

test('a producer cache hit restores its resource version to subsequent tools', async t => {
  const registry = fileTools().register('produce', {
    version: '1', randomness: 'replayable', replayVersion: '1', resources: { produces: ['artifact'] },
    execute: async env => {
      await env.write('/value', 'payload');
      env.resources.publish('artifact', { version: 'one', expiresAt: 110 });
      return 'created';
    }
  }).register('consume', {
    version: '1', randomness: 'none', mutates: false, resources: { requires: ['artifact'] },
    execute: async env => [env.resources.get('artifact').version, await env.read('/value')]
  });
  const { cache } = await fixture(t, registry, { clock: () => 100 });
  await cache.run('t', [{ name: 'produce' }]);
  const resumed = await cache.run('t', [{ name: 'produce' }, { name: 'consume' }]);
  assert.equal(resumed.steps[0].source, 'cache');
  assert.deepEqual(resumed.value, ['one', 'payload']);
  await assert.rejects(cache.run('other', [{ name: 'consume' }]), { code: 'ResourceUnavailable' });
});

test('legacy records remain inspectable and prunable without serving their values', async t => {
  const registry = fileTools().register('get', {
    version: '1', randomness: 'none', mutates: false, execute: () => 'fresh'
  });
  const { cache, backend } = await fixture(t, registry);
  const scope = cache.scope('task');
  const key = digest({ parent: 'root', call: { name: 'get', arguments: {} }, version: '1' });
  await backend.putRecord(scope + '-' + key, {
    schema: 1, scope, key, parent: 'root', value: 'legacy', ref: backend.baseRef, createdAt: 1
  });
  assert.equal((await cache.tree()).nodes[0].schema, 1);
  const result = await cache.run('task', [{ name: 'get' }]);
  assert.equal(result.value, 'fresh');
  assert.equal(result.hits, 0);
  assert.equal((await cache.tree()).nodes.filter(node => node.schema === 1).length, 1);
  assert.equal((await cache.prune({ before: 2 })).removed, 1);
});

const write = { name: 'file.write', arguments: { path: '/value', content: 'start' } };

test('tool responses, single flight and child execution proceed during staged and manifest writes', async t => {
  const { cache, backend, reopen } = await fixture(t, fileTools());
  const entered = gate(), releaseStage = gate(), committing = gate(), releaseCommit = gate();
  const stage = backend.stageRecord.bind(backend);
  const committed = [];
  backend.stageRecord = async (key, entry) => {
    const record = await stage(key, entry);
    if (entry.parent === 'root') {
      entered.resolve();
      await releaseStage.promise;
    }
    return { ...record, commit: async () => {
      if (entry.parent === 'root') {
        committing.resolve();
        await releaseCommit.promise;
      }
      await record.commit();
      committed.push(entry);
    } };
  };
  try {
    const session = cache.openRollout('t');
    const [a, joined] = await Promise.all([cache.run('t', [write], session), cache.run('t', [write])]);
    assert.equal(a.steps[0].publication, 'pending');
    assert.equal(joined.steps[0].revision, a.steps[0].revision);
    assert.equal(joined.hits, 1);
    assert.ok(!Object.hasOwn(a.steps[0], 'generation'));
    await entered.promise;
    assert.equal((await cache.tree('t')).nodes.length, 0);
    releaseStage.resolve();
    await committing.promise;
    const b = await cache.run('t', [write, append, read], session);
    assert.equal(b.steps[1].inputRef, a.ref);
    assert.equal(b.steps[1].publication, 'pending');
    assert.equal(b.steps[2].ref, b.steps[1].ref);
    assert.equal(b.value, 'start-next');
    const pendingHit = await cache.run('t', [write, append, read]);
    assert.equal(pendingHit.hits, 3);
    assert.equal(pendingHit.steps[1].publication, 'pending');
    assert.equal(cache.stats().executions, 3);
    assert.deepEqual(committed, []);
    releaseCommit.resolve();
    await cache.drainPublications();
    assert.deepEqual(committed.map(node => node.parentRevision), [null, committed[0].revision, committed[1].revision]);
    const restarted = (await reopen()).cache;
    const persistedHit = await restarted.run('t', [write, append, read]);
    assert.equal(persistedHit.hits, 3);
    assert.equal(persistedHit.value, b.value);
    assert.ok(persistedHit.steps.every(step => step.publication === 'published' && step.generation === 1));
  } finally {
    releaseStage.resolve();
    releaseCommit.resolve();
  }
});

for (const failure of ['ttl', 'timeout', 'failure', 'prune']) {
  test(`a parent cancelled by ${failure} leaves accepted history usable and drops pending descendants`, async t => {
    let now = 100;
    const { cache, backend } = await fixture(t, fileTools(), {
      clock: () => now, ttlMs: failure === 'ttl' ? 10 : null, publicationTimeoutMs: 20
    });
    const entered = gate(), finish = gate();
    const stage = backend.stageRecord.bind(backend);
    let stages = 0;
    backend.stageRecord = async (key, entry) => {
      const record = await stage(key, entry);
      if (++stages === 1) {
        entered.resolve();
        await finish.promise;
        if (failure === 'failure') {
          await record.discard();
          throw Object.assign(new Error('test write failure'), { code: 'TestWrite' });
        }
      }
      return record;
    };
    const session = cache.openRollout('t');
    let original;
    try {
      original = await cache.run('t', [write, append], session);
      await entered.promise;
      assert.equal(cache.stats().publications.pending, 2);
      if (failure === 'prune') await cache.prune({ scope: original.scope, before: now + 1 });
      if (failure === 'ttl') now = 110;
      if (failure === 'timeout') now = 120;
      assert.ok((await backend.listSnapshots()).includes(original.ref));
    } finally {
      finish.resolve();
    }
    await cache.drainPublications();
    assert.equal(stages, 1);
    assert.equal((await cache.tree('t')).nodes.length, 0);
    const stats = cache.stats().publications;
    assert.equal(stats.pending, 0);
    assert.equal(stats.failed, Number(failure === 'failure'));
    assert.equal(stats.timedOut, Number(failure === 'timeout'));
    if (failure === 'failure') assert.equal(stats.lastFailure.code, 'TestWrite');
    const continued = await cache.run('t', [write, append, read], session);
    assert.equal(continued.value, 'start-next');
    assert.equal(continued.steps[2].inputRef, original.ref);
    assert.deepEqual(continued.steps.map(step => step.source), ['rollout', 'rollout', 'execution']);
    await cache.closeRollout(session.rollout);
    assert.ok(!(await backend.listSnapshots()).includes(original.ref));
  });
}

test('a full queue skips publication and close drains a blocked commit', async t => {
  const { cache, backend } = await fixture(t, fileTools(), { publicationCapacity: 1 });
  const entered = gate(), finish = gate();
  const stage = backend.stageRecord.bind(backend);
  backend.stageRecord = async (key, entry) => {
    const record = await stage(key, entry);
    return { ...record, commit: async () => {
      entered.resolve();
      await finish.promise;
      await record.commit();
    } };
  };
  try {
    const result = await cache.run('first', [write]);
    await entered.promise;
    const [miss, joined] = await Promise.all([cache.run('other', [write]), cache.run('other', [write])]);
    assert.equal(miss.steps[0].publication, 'skipped');
    assert.equal(joined.steps[0].publication, 'skipped');
    assert.equal(joined.hits, 1);
    assert.equal(cache.stats().executions, 2);
    assert.equal(cache.stats().publications.skipped, 1);
    let closed = false;
    const closing = cache.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    await assert.rejects(cache.run('third', [write]), { code: 'Closed' });
    finish.resolve();
    await closing;
    const stored = await backend.getRecord(result.scope + '-' + result.steps[0].key);
    assert.equal(stored.revision, result.steps[0].revision);
  } finally {
    finish.resolve();
  }
});

test('pruning the observed generation fences a replacement already staged', async t => {
  let now = 100;
  const { cache, backend } = await fixture(t, fileTools(), { clock: () => now, ttlMs: 10 });
  const first = await cache.run('t', [write]);
  await cache.drainPublications();
  const entered = gate(), finish = gate();
  const stage = backend.stageRecord.bind(backend);
  backend.stageRecord = async (key, entry) => {
    const record = await stage(key, entry);
    if (entry.generation === 2) {
      entered.resolve();
      await finish.promise;
    }
    return record;
  };
  let expired;
  try {
    now = 110;
    expired = await cache.run('t', [write]);
    assert.equal(expired.steps[0].publication, 'pending');
    await entered.promise;
    // Only the old manifest matches this cutoff. Its pending replacement
    // must still lose the conditional replacement.
    assert.equal((await cache.prune({ before: 105, scope: first.scope })).removed, 1);
  } finally {
    finish.resolve();
  }
  await cache.drainPublications();
  assert.equal((await cache.tree('t')).nodes.length, 0);
  const fresh = await cache.run('t', [write]);
  assert.notEqual(fresh.steps[0].revision, expired.steps[0].revision);
  await cache.drainPublications();
  assert.equal((await cache.tree('t')).nodes[0].revision, fresh.steps[0].revision);
});
