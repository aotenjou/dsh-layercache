import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LayerCache, ToolRegistry, fileTools, canonical } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';
import { encodeRecord, decodeRecord } from '../src/store.js';

const write = (content = 'A') => ({ name: 'file.write', arguments: { path: '/state.txt', content } });
const append = content => ({ name: 'file.append', arguments: { path: '/state.txt', content } });
const read = { name: 'file.read', arguments: { path: '/state.txt' } };
async function fixture(t, registry = fileTools(), options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'layercache-test-'));
  const backend = await LocalBackend.open(dir);
  const cache = new LayerCache({ backend, registry, baseRef: backend.baseRef, ...options });
  t.after(async () => { await cache.close(); await rm(dir, { recursive: true, force: true }); });
  return { cache, dir, backend };
}

test('prefix hits restore files; divergent rollouts remain isolated', async t => {
  const { cache } = await fixture(t);
  const first = await cache.run('task', [write(), append('B'), read]);
  const fork = await cache.run('task', [write(), append('C'), read]);
  assert.equal(first.value, 'AB'); assert.equal(fork.value, 'AC'); assert.equal(fork.hits, 1);
  const replay = await cache.run('task', [write(), append('B'), read]);
  assert.equal(replay.value, 'AB'); assert.equal(replay.executed, 0);
  const env = await cache.backend.fork(first.ref);
  try { assert.equal(await env.read('/state.txt'), 'AB'); } finally { await env.close(); }
});
test('read-only calls do not extend the state chain', async t => {
  const { cache } = await fixture(t);
  await cache.run('task', [write(), read, append('B')]);
  assert.equal((await cache.run('task', [write(), append('B')])).executed, 0);
});
test('canonical object order; strict JSON; null results are valid hits', async t => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  for (const value of [undefined, NaN, Infinity, new Date(), { a: undefined }]) assert.throws(() => canonical(value));
  const registry = new ToolRegistry().register('null', { version: '1', mutates: false, execute: async () => null });
  const { cache } = await fixture(t, registry);
  await cache.run('t', [{ name: 'null', arguments: { b: 2, a: 1 } }]);
  assert.equal((await cache.run('t', [{ name: 'null', arguments: { a: 1, b: 2 } }])).hits, 1);
});
test('task, context, tool version, and base snapshot separate cache identities', async t => {
  const { cache, backend } = await fixture(t);
  await cache.run('a', [write()]);
  assert.equal((await cache.run('b', [write()])).hits, 0);
  const changed = new LayerCache({ backend, registry: fileTools(), baseRef: backend.baseRef, context: { dataset: 'v2' } });
  assert.equal((await changed.run('a', [write()])).hits, 0);
  const registry = fileTools(); registry.tools.get('file.write').version = '2';
  assert.notEqual(changed.scope('a'), new LayerCache({ backend, registry, baseRef: backend.baseRef }).scope('a'));
  assert.notEqual(cache.scope('a'), new LayerCache({ backend, registry: fileTools(), baseRef: 'other' }).scope('a'));
});
test('concurrent identical prefixes execute once', async t => {
  let count = 0;
  const registry = new ToolRegistry().register('slow', { version: '1', execute: async env => { count++; await new Promise(r => setTimeout(r, 30)); await env.write('/x', 'ok'); return count; } });
  const { cache } = await fixture(t, registry);
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.run('t', [{ name: 'slow' }])));
  assert.equal(count, 1); assert.ok(results.every(r => r.value === 1));
});
test('failed tool publishes no cache node and leaves the old snapshot intact', async t => {
  const registry = fileTools().register('fail', { version: '1', execute: async env => { await env.write('/state.txt', 'bad'); throw new Error('failure'); } });
  const { cache } = await fixture(t, registry);
  const initial = await cache.run('t', [write()]);
  await assert.rejects(cache.run('t', [write(), { name: 'fail' }]), /failure/);
  assert.equal((await cache.tree('t')).nodes.length, 1);
  const env = await cache.backend.fork(initial.ref);
  try { assert.equal(await env.read('/state.txt'), 'A'); } finally { await env.close(); }
});
test('uncached calls create a barrier for descendant reuse', async t => {
  let count = 0;
  const registry = fileTools().register('random', { version: '1', cacheable: false, execute: async env => { const value = String(++count); await env.write('/state.txt', value); return value; } });
  const { cache } = await fixture(t, registry);
  assert.equal((await cache.run('t', [{ name: 'random' }, append('B'), read])).value, '1B');
  assert.equal((await cache.run('t', [{ name: 'random' }, append('B'), read])).value, '2B');
  assert.equal((await cache.tree()).nodes.length, 0);
});
test('read-only handlers cannot mutate state', async t => {
  const registry = new ToolRegistry().register('lie', { version: '1', mutates: false, execute: env => env.write('/x', 'bad') });
  const { cache } = await fixture(t, registry);
  await assert.rejects(cache.run('t', [{ name: 'lie' }]), { code: 'ReadOnlyViolation' });
});
test('restart keeps the tree and immutable environment state', async t => {
  const { cache, dir } = await fixture(t);
  const original = await cache.run('t', [write(), append('B'), read]);
  await cache.close();
  const backend = await LocalBackend.open(dir);
  const restarted = new LayerCache({ backend, registry: fileTools(), baseRef: backend.baseRef });
  try { const result = await restarted.run('t', [write(), append('B'), read]); assert.equal(result.hits, 3); assert.equal(result.ref, original.ref); }
  finally { await restarted.close(); }
});
test('one index owner; prune removes reuse records without claiming storage GC', async t => {
  const { cache, dir } = await fixture(t);
  await assert.rejects(LocalBackend.open(dir), { code: 'CacheLocked' });
  await cache.run('t', [write(), append('B')]);
  const pruned = await cache.store.prune({ before: Date.now() + 1 });
  assert.equal(pruned.removed, 2); assert.equal(pruned.reclaimedSnapshots, false);
  assert.equal((await cache.run('t', [write(), append('B')])).hits, 0);
});
test('chunk encoding preserves large UTF-8/null payloads and detects corruption', () => {
  const value = { value: '\u4e2d\u6587\n'.repeat(100000), null: null };
  const { manifest, chunks } = encodeRecord(value);
  assert.ok(chunks.length > 2); assert.ok(chunks.every(c => Buffer.byteLength(c) <= 16384));
  assert.deepEqual(decodeRecord(manifest, chunks), value);
  assert.throws(() => decodeRecord({ ...manifest, hash: 'wrong' }, chunks), { code: 'CorruptCache' });
});
test('invalid later calls are rejected before earlier side effects', async t => {
  const { cache } = await fixture(t);
  await assert.rejects(cache.run('t', [write(), { name: 'missing' }]), { code: 'InvalidInput' });
  assert.equal(cache.stats().executions, 0);
});
test('rollout sessions retain noncacheable effects across growing histories', async t => {
  let draws = 0;
  const registry = fileTools().register('draw', { version: '1', cacheable: false, execute: async env => { const value = String(++draws); await env.write('/state.txt', value); return value; } });
  const { cache } = await fixture(t, registry);
  const session = cache.openRollout('t');
  const calls = [{ name: 'draw' }];
  assert.equal((await cache.run('t', calls, session)).value, '1');
  calls.push(append('B'));
  assert.deepEqual((await cache.run('t', calls, session)).steps.map(s => s.source), ['rollout', 'execution']);
  calls.push(read);
  assert.equal((await cache.run('t', calls, session)).value, '1B');
  assert.equal(draws, 1); assert.equal(cache.stats().executions, 3);
  await cache.closeRollout(session.rollout);
  const second = cache.openRollout('t');
  assert.equal((await cache.run('t', calls, second)).value, '2B');
  assert.equal((await cache.tree()).nodes.length, 0);
  await cache.closeRollout(second.rollout);
});
test('rollout history is append-only, serialized, isolated by task and explicitly closed', async t => {
  const { cache } = await fixture(t);
  const session = cache.openRollout('t');
  await Promise.all([cache.run('t', [write()], session), cache.run('t', [write(), append('B')], session)]);
  await assert.rejects(cache.run('other', [write(), append('B')], session), { code: 'InvalidInput' });
  await assert.rejects(cache.run('t', [write('different')], session), { code: 'InvalidInput' });
  await assert.rejects(cache.run('t', [write()], session), { code: 'InvalidInput' });
  assert.equal((await cache.run('t', [write(), append('B'), read], session)).value, 'AB');
  await cache.closeRollout(session.rollout);
  await assert.rejects(cache.run('t', [write()], session), { code: 'UnknownRollout' });
  assert.equal(cache.stats().rollouts, 0);
});
test('a failed rollout refuses later execution instead of replaying uncertain effects', async t => {
  let effects = 0;
  const registry = new ToolRegistry().register('effect', { version: '1', cacheable: false, execute: async () => { effects++; throw new Error('uncertain'); } });
  const { cache } = await fixture(t, registry);
  const session = cache.openRollout('t');
  await assert.rejects(cache.run('t', [{ name: 'effect' }], session), /uncertain/);
  await assert.rejects(cache.run('t', [{ name: 'effect' }], session), { code: 'RolloutFailed' });
  assert.equal(effects, 1);
});
test('rollout admission is bounded and releasing a rollout frees capacity', async t => {
  const { cache } = await fixture(t, fileTools(), { maxRollouts: 1 });
  const session = cache.openRollout('t');
  assert.throws(() => cache.openRollout('t'), { code: 'Capacity' });
  await cache.closeRollout(session.rollout);
  assert.ok(cache.openRollout('t').rollout);
});
