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
  const root = await mkdtemp(join(process.env.LAYERCACHE_TEST_STORE_DIR ?? tmpdir(), 'layercache-real-'));
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
  const registry = () => fileTools().register('large', { version: '1', mutates: false, randomness: 'none', execute: async () => '\u4e2d\u6587'.repeat(40000) });
  const history = content => [{ name: 'file.append', arguments: { path: '/state.txt', content } }, { name: 'file.read', arguments: { path: '/state.txt' } }];
  try {
    const backend = await LayerFSBackend.open(options);
    cache = new LayerCache({ backend, registry: registry(), baseRef: backend.baseRef });
    const originalBase = cache.baseRef;
    const put = backend.client.fs.write;
    const chunk = Promise.withResolvers(), allowChunk = Promise.withResolvers();
    const manifest = Promise.withResolvers(), allowManifest = Promise.withResolvers();
    backend.client.fs.write = async (...args) => {
      if (args[3] === 'LayerCache result chunk') {
        const result = await put(...args);
        chunk.resolve();
        await allowChunk.promise;
        return result;
      }
      if (args[3] === 'LayerCache publish cache record') {
        manifest.resolve();
        await allowManifest.promise;
      }
      return put(...args);
    };
    try {
      const a = await cache.run('t', history('-A').slice(0, 1));
      assert.equal(a.steps[0].publication, 'pending');
      await chunk.promise;
      assert.equal((await cache.tree('t')).nodes.length, 0);
      assert.equal((await cache.cleanupExpired()).reclaimedChunks, 0);
      const b = await cache.run('t', history('-A'));
      assert.equal(b.steps[1].inputRef, a.ref);
      assert.equal(b.value, 'seed-A');
      allowChunk.resolve();
      await manifest.promise;
      const replay = await cache.run('t', history('-A'));
      assert.equal(replay.hits, 2);
      assert.equal(replay.steps[0].revision, a.steps[0].revision);
    } finally {
      allowChunk.resolve();
      allowManifest.resolve();
      await cache.drainPublications();
      backend.client.fs.write = put;
    }
    assert.equal((await cache.run('t', history('-B'))).value, 'seed-B');
    assert.equal((await cache.run('t', history('-A'))).executed, 0);
    const large = await cache.run('t', [{ name: 'large' }]);
    assert.equal(large.value.length, 80000);
    await cache.close(); cache = null;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { LayerCache, fileTools } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
      import { LayerFSBackend } from ${JSON.stringify(new URL('../src/backends/layerfs.js', import.meta.url).href)};
      const backend = await LayerFSBackend.open(${JSON.stringify(options)});
      const registry = fileTools().register('large', {version:'1', mutates:false, randomness:'none', execute:async () => '\\u4e2d\\u6587'.repeat(40000)});
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
    await cache.drainPublications();
    assert.equal((await cache.tree('t')).nodes.length, 5);
    const pruned = await cache.store.prune({ before: Date.now() + 1 });
    assert.equal(pruned.removed, 5);
    assert.equal(pruned.reclaimedSnapshots, false);
    assert.ok(pruned.reclaimedChunks >= 5);
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
    let now = 100;
    await cache.close();
    const withTtl = await LayerFSBackend.open(options);
    cache = new LayerCache({ backend: withTtl, registry: registry(), baseRef: withTtl.baseRef, ttlMs: 10, clock: () => now });
    const active = cache.openRollout('ttl');
    const chain = history('-ttl');
    const old = await cache.run('ttl', chain, active);
    await cache.drainPublications();
    now = 110;
    assert.equal((await cache.cleanupExpired()).removed, 2);
    const continued = await cache.run('ttl', [...chain, { name: 'file.append', arguments: { path: '/state.txt', content: '-next' } }], active);
    assert.equal(continued.steps[2].inputRef, old.ref);
    assert.equal(continued.steps[2].source, 'execution');
    assert.equal((await cache.run('ttl', chain)).hits, 0);
    await cache.closeRollout(active.rollout);
  } finally { if (cache) await cache.close(); await rm(root, { recursive: true, force: true }); }
});
