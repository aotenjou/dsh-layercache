import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mount, caller, invoke } from './dsh-support.js';
import { LayerCache, fileTools } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';
import { serve } from '../src/server.js';

const write = content => ({ name: 'file.write', arguments: { path: '/shared', content } });
const read = { name: 'file.read', arguments: { path: '/shared' } };

test('multiple dsh clients share deterministic prefixes and keep rollout ownership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-layercache-multi-client-'));
  const backend = await LocalBackend.open(root);
  const cache = new LayerCache({ backend, registry: fileTools(), baseRef: backend.baseRef });
  const service = await serve(cache, { port: 0 });
  const { ctx } = await mount(service.url, { allowedTools: ['file.write', 'file.read'] });
  t.after(async () => {
    await ctx.fiber.dispose();
    await service.close();
    await cache.close();
    await rm(root, { recursive: true, force: true });
  });

  const history = [write('shared'), read];
  const clients = ['client-a', 'client-b', 'client-c', 'client-d'];
  const results = await Promise.all(clients.map((id, index) => invoke(
    ctx, caller(id), 'tvcache_run', { task_id: 'multi', rollout: `rollout-${index}`, history }
  )));
  assert.deepEqual(results.map(result => result.value.value), ['shared', 'shared', 'shared', 'shared']);
  assert.ok(results.some(result => result.value.cache_hits > 0));

  await invoke(ctx, caller('owner'), 'tvcache_run', {
    task_id: 'ownership', rollout: 'owned', history: [write('owner')]
  });
  const rejected = await invoke(ctx, caller('other'), 'tvcache_close', { rollout: 'owned' });
  assert.equal(rejected.result.isError, true);
  const closed = await invoke(ctx, caller('owner'), 'tvcache_close', { rollout: 'owned' });
  assert.equal(closed.result.isError, false);
});
