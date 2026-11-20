import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayerCache, fileTools } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';
import { serve } from '../src/server.js';

test('real HTTP run, authentication, tree, stats, prune, malformed requests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'layercache-http-'));
  const backend = await LocalBackend.open(dir);
  const cache = new LayerCache({ backend, registry: fileTools(), baseRef: backend.baseRef });
  const service = await serve(cache, { port: 0, token: 'test-secret' });
  t.after(async () => { await service.close(); await cache.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await fetch(service.url + '/health')).status, 401);
  const headers = { authorization: 'Bearer test-secret', 'content-type': 'application/json' };
  const run = async body => fetch(service.url + '/v1/run', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = { task: 't', history: [{ name: 'file.write', arguments: { path: '/x', content: 'hello' } }, { name: 'file.read', arguments: { path: '/x' } }] };
  const first = await (await run(data)).json();
  assert.equal(first.value, 'hello');
  assert.equal(first.steps[0].publication, 'pending');
  assert.equal(typeof first.steps[0].revision, 'string');
  assert.ok(!Object.hasOwn(first.steps[0], 'generation'));
  assert.equal((await (await run(data)).json()).hits, 2);
  await cache.drainPublications();
  assert.equal((await (await fetch(service.url + '/v1/tree?task=t', { headers })).json()).nodes.length, 2);
  const stats = await (await fetch(service.url + '/v1/stats', { headers })).json();
  assert.equal(stats.executions, 2);
  assert.equal(stats.publications.published, 2);
  assert.equal((await run({ task: 't', history: [] })).status, 400);
  assert.equal((await run({ task: 't', history: [{ name: 'file.read', arguments: null }] })).status, 400);
  assert.equal((await fetch(service.url + '/v1/run', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(service.url + '/missing', { headers })).status, 404);
  const prune = await fetch(service.url + '/v1/prune', { method: 'POST', headers, body: JSON.stringify({ before: Date.now() + 1000 }) });
  assert.equal((await prune.json()).removed, 2);
  const post = async (path, data) => fetch(service.url + path, { method: 'POST', headers, body: JSON.stringify(data) });
  const { rollout } = await (await post('/v1/rollouts', { task: 'session' })).json();
  assert.equal((await (await run({ ...data, task: 'session', rollout })).json()).value, 'hello');
  assert.equal((await (await post('/v1/rollouts/close', { rollout })).json()).closed, true);
  assert.equal((await run({ ...data, task: 'session', rollout })).status, 409);
});
test('oversized HTTP input gets a structured 413 response', async () => {
  const service = await serve({}, { port: 0, maxBodyBytes: 128 });
  try {
    const response = await fetch(service.url + '/v1/run', { method: 'POST', body: JSON.stringify({ task: 'large', payload: 'x'.repeat(65536) }) });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'TooLarge');
  } finally { await service.close(); }
});
