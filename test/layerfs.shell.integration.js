import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayerCache, fileTools } from '../src/index.js';
import { LayerFSBackend } from '../src/backends/layerfs.js';

test('real Docker/FUSE Workspace: shell commit, branch divergence, cache hit, cleanup', { skip: process.env.LAYERCACHE_TEST_SHELL !== '1' && 'Use scripts/test-layerfs-docker.py with a built SDK/daemon' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'layercache-shell-'));
  const source = join(root, 'source');
  await mkdir(source); await writeFile(join(source, 'state.txt'), 'seed');
  process.env.LAYERFS_HOME = join(root, 'home');
  await mkdir(process.env.LAYERFS_HOME, { mode: 0o700 });
  const sdkModule = process.env.LAYERCACHE_TEST_SDK;
  const { LayerFS } = await import(sdkModule);
  let cache;
  try {
    const initial = await LayerFS.init('layercache-shell', source);
    await initial.close();
    const backend = await LayerFSBackend.open({ project: 'layercache-shell', lockPath: join(root, 'owner.lock'), sdkModule });
    cache = new LayerCache({ backend, registry: fileTools(), baseRef: backend.baseRef });
    const prefix = { name: 'shell', arguments: { command: "printf '%s' shared > state.txt; cat state.txt" } };
    const branch = suffix => [prefix, { name: 'shell', arguments: { command: `printf '%s' ${suffix} >> state.txt; cat state.txt` } }];
    assert.equal((await cache.run('task', branch('A'))).value.stdout, 'sharedA');
    const second = await cache.run('task', branch('B'));
    assert.equal(second.value.stdout, 'sharedB'); assert.equal(second.hits, 1);
    assert.equal((await cache.run('task', branch('A'))).executed, 0);
    const before = (await cache.tree()).nodes.length;
    await assert.rejects(cache.run('failure', [{ name: 'shell', arguments: { command: 'echo failed > failed.txt; exit 7' } }]), { code: 'ToolFailed' });
    assert.equal((await cache.tree()).nodes.length, before);
    assert.equal((await backend.client.project.list_sandboxes()).items.length, 0);
    const result = await cache.run('task', [...branch('A'), { name: 'file.read', arguments: { path: '/state.txt' } }]);
    assert.equal(result.value, 'sharedA'); assert.equal(result.hits, 2);
    const session = cache.openRollout('uncached-shell');
    const calls = [{ name: 'shell', arguments: { command: "printf '%s' once >> state.txt" }, cache: false }];
    await cache.run('uncached-shell', calls, session);
    calls.push({ name: 'file.read', arguments: { path: '/state.txt' } });
    const continued = await cache.run('uncached-shell', calls, session);
    assert.equal(continued.value, 'seedonce');
    assert.equal(continued.steps[0].source, 'rollout');
    assert.equal(continued.executed, 1);
    await cache.closeRollout(session.rollout);
  } finally { if (cache) await cache.close(); await rm(root, { recursive: true, force: true }); }
});
