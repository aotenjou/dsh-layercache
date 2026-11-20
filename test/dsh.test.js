import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { mount, caller, invoke } from './dsh-support.js';
import { CacheClient } from '../plugin/client.js';
import { Rollouts } from '../plugin/rollouts.js';
import { LayerCache, fileTools } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';
import { serve } from '../src/server.js';

const write = content => ({ name: 'file.write', arguments: { path: '/state', content } });
const append = content => ({ name: 'file.append', arguments: { path: '/state', content } });
const read = { name: 'file.read', arguments: { path: '/state' } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-layercache-'));
  const backend = await LocalBackend.open(root);
  const cache = new LayerCache({ backend, registry: fileTools(), baseRef: backend.baseRef });
  const service = await serve(cache, { port: 0 });
  t.after(async () => { await service.close(); await cache.close(); await rm(root, { recursive: true, force: true }); });
  return { cache, service };
}

test('real Cordis/dsh pipeline registers, branches, replays, logs metadata, and unloads', async t => {
  const { cache, service } = await fixture(t);
  const { ctx, fork } = await mount(service.url);
  t.after(() => ctx.fiber.dispose());
  const agent = caller('one');
  const run = (rollout, history) => invoke(ctx, agent, 'tvcache_run', { task_id: 'sample', rollout, history });
  const a = await run('A', [write('shared'), append('A'), read]);
  assert.equal(a.result.isError, false); assert.equal(a.value.value, 'sharedA'); assert.equal(a.value.executed, 3);
  assert.equal(a.result.meta.executed, 3);
  assert.equal(a.value.steps[2].publication, 'pending');
  assert.ok(!Object.hasOwn(a.value.steps[2], 'generation'));
  const b = await run('B', [write('shared'), append('B'), read]);
  assert.equal(b.value.value, 'sharedB'); assert.equal(b.value.cache_hits, 1); assert.equal(b.value.executed, 2);
  const replay = await run('replay', [write('shared'), append('A'), read]);
  assert.equal(replay.value.executed, 0); assert.equal(replay.value.cache_hits, 3);
  assert.match(ctx.tools.get('tvcache_run').presentResult({ task_id: 'sample', rollout: 'replay', history: [write('shared'), append('A'), read] }, replay.result)?.title ?? '', /3 hits/);
  const denied = await invoke(ctx, agent, 'tvcache_run', { task_id: 'other', rollout: 'shell', history: [{ name: 'shell', arguments: { command: 'echo denied' } }] });
  assert.equal(denied.result.isError, true);
  assert.equal(cache.stats().rollouts, 3, 'denied histories do not open sessions');
  await fork.dispose();
  assert.equal(ctx.tools.get('tvcache_run'), undefined); assert.equal(cache.stats().rollouts, 0);
});

test('incremental uncached effects execute once; labels belong to a dsh session', async t => {
  const { cache, service } = await fixture(t);
  const { ctx } = await mount(service.url);
  t.after(() => ctx.fiber.dispose());
  const a = caller('a'), b = caller('b');
  const history = [{ ...write('A'), cache: false }];
  const run = (agent, h) => invoke(ctx, agent, 'tvcache_run', { task_id: 'sample', rollout: 'same', history: h });
  assert.equal((await run(a, history)).value.executed, 1);
  history.push(append('B')); await run(a, history);
  history.push(read);
  const final = await run(a, history);
  assert.equal(final.value.value, 'AB'); assert.equal(final.value.executed, 1); assert.equal(final.value.continued, 2);
  assert.equal(cache.stats().executions, 3);
  assert.equal((await invoke(ctx, b, 'tvcache_close', { rollout: 'same' })).result.isError, true);
  assert.equal((await run(b, [write('independent'), read])).value.value, 'independent');
  await invoke(ctx, a, 'tvcache_close', { rollout: 'same' });
  assert.equal((await run(a, history)).result.isError, true);
  assert.equal(cache.stats().rollouts, 1);
});

test('dsh preflights candidates and reports undeclared tools on a growing history', async t => {
  const { service } = await fixture(t);
  const { ctx } = await mount(service.url);
  t.after(() => ctx.fiber.dispose());
  const agent = caller('preflight');
  const candidates = { task_id: 'sample', candidate_tools: ['file.write', 'missing'] };
  const prepared = await invoke(ctx, agent, 'tvcache_prepare', candidates);
  assert.equal(prepared.result.isError, false);
  assert.deepEqual(prepared.value.unknown_tools, ['missing']);
  const base = { ...candidates, rollout: 'a' };
  const first = await invoke(ctx, agent, 'tvcache_run', { ...base, history: [write('value')] });
  assert.deepEqual(first.value.preflight, prepared.value);
  const next = await invoke(ctx, agent, 'tvcache_run', { ...base, history: [write('value'), read] });
  assert.equal(next.value.value, 'value');
  assert.deepEqual(next.value.unknown_tools, ['file.read', 'missing']);
  assert.equal(next.value.continued, 1);
});

test('backend mismatch, missing owning session, bad arguments, and policy denial fail before mutation', async t => {
  const { cache, service } = await fixture(t);
  const client = new CacheClient({ endpoint: service.url, tokenEnv: 'LAYERCACHE_TEST_TOKEN', requestTimeoutMs: 1000 });
  await assert.rejects(client.check('layerfs'), { code: 'BackendMismatch' });
  const { ctx } = await mount(service.url);
  t.after(() => ctx.fiber.dispose());
  const args = { task_id: 'sample', rollout: 'a', history: [write('a')] };
  assert.equal((await invoke(ctx, undefined, 'tvcache_run', args)).result.isError, true);
  assert.equal((await invoke(ctx, caller('a'), 'tvcache_run', { ...args, history: 'bad' })).result.isError, true);
  const guard = ctx.tools.guard(() => 'deployment policy denied');
  assert.equal((await invoke(ctx, caller('a'), 'tvcache_run', args)).result.isError, true);
  guard();
  assert.equal(cache.stats().executions, 0); assert.equal(cache.stats().rollouts, 0);
});

test('one failed mutation response poisons its label instead of replaying', async t => {
  let runs = 0, opens = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume input before responding */ }
    if (req.url === '/v1/rollouts') { opens++; res.end(JSON.stringify({ rollout: 'opaque' })); }
    else if (req.url === '/v1/run') { runs++; res.destroy(); }
    else res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new CacheClient({ endpoint: `http://127.0.0.1:${server.address().port}`, tokenEnv: 'LAYERCACHE_TEST_TOKEN', requestTimeoutMs: 1000 });
  const rollouts = new Rollouts(client, { maxRollouts: 2, allowedTools: ['file.write'] });
  const args = { task_id: 'sample', rollout: 'one', history: [write('once')] };
  await assert.rejects(rollouts.run('owner', args), { code: 'TransportUnknown' });
  await assert.rejects(rollouts.run('owner', args), { code: 'RolloutUnavailable' });
  assert.equal(runs, 1); assert.equal(opens, 1);
  await rollouts.dispose();
});
