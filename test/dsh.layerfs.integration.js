import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayerCache, fileTools } from '../src/index.js';
import { LayerFSBackend } from '../src/backends/layerfs.js';
import { serve } from '../src/server.js';
import { mount, caller, invoke } from './dsh-support.js';

test('dsh tool pipeline -> HTTP -> real LayerFS Store/FUSE: divergence, replay, uncached session', {
  skip: process.env.LAYERCACHE_TEST_SHELL !== '1' && 'Use test-layerfs-docker.py --dsh',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-layercache-real-'));
  const source = join(root, 'seed');
  await mkdir(source); await writeFile(join(source, 'state.txt'), 'seed');
  process.env.LAYERFS_HOME = join(root, 'home');
  await mkdir(process.env.LAYERFS_HOME, { mode: 0o700 });
  let cache, service, ctx;
  try {
    const sdkModule = process.env.LAYERCACHE_TEST_SDK;
    const { LayerFS } = await import(sdkModule);
    const initial = await LayerFS.init('dsh-layercache', source); await initial.close();
    const backend = await LayerFSBackend.open({ project: 'dsh-layercache', lockPath: join(root, 'owner.lock'), sdkModule });
    cache = new LayerCache({ backend, registry: fileTools({ cacheShell: true }), baseRef: backend.baseRef });
    service = await serve(cache, { port: 0 });
    ({ ctx } = await mount(service.url, { backend: 'layerfs', allowedTools: ['shell', 'file.read'] }));
    const agent = caller('real-dsh-session');
    const shell = command => ({ name: 'shell', arguments: { command } });
    const prefix = shell("printf '%s' shared > state.txt; cat state.txt");
    const history = suffix => [prefix, shell(`printf '%s' ${suffix} >> state.txt; cat state.txt`)];
    const run = async (label, calls, task_id = 'same-sample') => {
      const result = await invoke(ctx, agent, 'tvcache_run', { task_id, rollout: label, history: calls });
      assert.equal(result.result.isError, false, JSON.stringify(result.result));
      return result.value;
    };
    assert.equal((await run('A', history('A'))).value.stdout, 'sharedA');
    const b = await run('B', history('B'));
    assert.equal(b.value.stdout, 'sharedB'); assert.equal(b.cache_hits, 1);
    assert.equal((await run('replay', history('A'))).executed, 0);
    const calls = [{ ...shell("printf '%s' once >> state.txt"), cache: false }];
    await run('uncached', calls, 'uncached');
    calls.push({ name: 'file.read', arguments: { path: '/state.txt' } });
    const continued = await run('uncached', calls, 'uncached');
    assert.equal(continued.value, 'seedonce'); assert.equal(continued.continued, 1); assert.equal(continued.executed, 1);
    assert.equal((await backend.client.project.list_sandboxes()).items.length, 0);
    await ctx.fiber.dispose(); ctx = null;
    assert.equal(cache.stats().rollouts, 0);
  } finally {
    if (ctx) await ctx.fiber.dispose();
    if (service) await service.close();
    if (cache) await cache.close();
    await rm(root, { recursive: true, force: true });
  }
});
