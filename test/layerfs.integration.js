import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LayerCache, fileTools } from '../src/index.js';
import { LayerFSBackend } from '../src/backends/layerfs.js';

const sdkModule = process.env.LAYERCACHE_TEST_SDK;
test('real LayerFS Store: branching, large results, persisted trie, reopen, pruning', { skip: !sdkModule && 'Set LAYERCACHE_TEST_SDK to the built LayerFS SDK module URL (Linux)' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'layercache-real-'));
  const source = join(root, 'source');
  await mkdir(source); await writeFile(join(source, 'state.txt'), 'seed');
  Object.assign(process.env, { LAYERFS_HOME: join(root, 'home'), LAYERFS_STORE_PATH: join(root, 'store', 'store.sqlite'), LAYERFS_IMAGE: 'sha256:' + '0'.repeat(64), LAYERFS_DAEMON: '/unused', LAYERFS_VOLUME: 'unused' });
  await mkdir(process.env.LAYERFS_HOME, { mode: 0o700 });
  await mkdir(join(root, 'store'));
  const { LayerFS } = await import(sdkModule);
  const initial = await LayerFS.init('layercache-test', source);
  await initial.close();
  const options = { project: 'layercache-test', lockPath: join(root, 'owner.lock'), sdkModule };
  let cache;
  const registry = () => fileTools().register('large', { version: '1', mutates: false, execute: async () => '\u4e2d\u6587'.repeat(40000) });
  const history = content => [{ name: 'file.append', arguments: { path: '/state.txt', content } }, { name: 'file.read', arguments: { path: '/state.txt' } }];
  try {
    const backend = await LayerFSBackend.open(options);
    cache = new LayerCache({ backend, registry: registry(), baseRef: backend.baseRef });
    const originalBase = cache.baseRef;
    assert.equal((await cache.run('t', history('-A'))).value, 'seed-A');
    assert.equal((await cache.run('t', history('-B'))).value, 'seed-B');
    assert.equal((await cache.run('t', history('-A'))).executed, 0);
    const large = await cache.run('t', [{ name: 'large' }]);
    assert.equal(large.value.length, 80000);
    await cache.close(); cache = null;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { LayerCache, fileTools } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
      import { LayerFSBackend } from ${JSON.stringify(new URL('../src/backends/layerfs.js', import.meta.url).href)};
      const backend = await LayerFSBackend.open(${JSON.stringify(options)});
      const registry = fileTools().register('large', {version:'1', mutates:false, execute:async () => '\\u4e2d\\u6587'.repeat(40000)});
      const cache = new LayerCache({backend, registry, baseRef:backend.baseRef});
      try { const result = await cache.run('t', ${JSON.stringify(history('-A'))}); console.log(JSON.stringify({hits:result.hits, value:result.value})); }
      finally { await cache.close(); }
    `], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { hits: 2, value: 'seed-A' });
    const reopened = await LayerFSBackend.open(options);
    cache = new LayerCache({ backend: reopened, registry: registry(), baseRef: reopened.baseRef });
    assert.equal(cache.baseRef, originalBase);
    assert.equal((await cache.run('t', history('-A'))).hits, 2);
    assert.equal((await cache.run('t', [{ name: 'large' }])).value, large.value);
    assert.equal((await cache.tree('t')).nodes.length, 5);
    const pruned = await cache.store.prune({ before: Date.now() + 1 });
    assert.equal(pruned.removed, 5);
    assert.equal((await cache.tree('t')).nodes.length, 0);
    const session = cache.openRollout('uncached');
    const uncached = [{ name: 'file.append', arguments: { path: '/state.txt', content: '-once' }, cache: false }];
    const before = cache.stats().executions;
    await cache.run('uncached', uncached, session);
    uncached.push({ name: 'file.read', arguments: { path: '/state.txt' } });
    const result = await cache.run('uncached', uncached, session);
    assert.equal(result.value, 'seed-once');
    assert.equal(result.steps[0].source, 'rollout');
    assert.equal(cache.stats().executions - before, 2);
    await cache.closeRollout(session.rollout);
  } finally { if (cache) await cache.close(); await rm(root, { recursive: true, force: true }); }
});
