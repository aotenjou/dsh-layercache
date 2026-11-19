import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayerFSBackend } from '../src/backends/layerfs.js';
import { LayerCache, ToolRegistry } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('LayerFS shell commits even a nonzero exit, then unmounts and closes', async () => {
  const calls = [];
  const client = {
    branch: { fork: async () => ({ head: 'old' }) },
    sandbox: { create: async () => { calls.push('create'); return { sandbox: '1' }; }, close: async () => calls.push('close') },
    workspace: {
      mount: async () => { calls.push('mount'); return { sandbox: '1', path: '/workspaces/1' }; },
      exec: async () => { calls.push('exec'); return { exitCode: 3, stdout: '', stderr: 'failure' }; },
      commit: async () => { calls.push('commit'); return { head: 'new' }; },
      unmount: async () => calls.push('unmount')
    }
  };
  const backend = new LayerFSBackend(client, async () => {}), env = await backend.fork('old');
  assert.equal((await env.exec('exit 3')).exitCode, 3);
  assert.equal(await env.snapshot(), 'new');
  assert.deepEqual(calls, ['create', 'mount', 'exec', 'commit', 'unmount', 'close']);
});
test('LayerFS refuses uncertain exec without repeating it and still attempts cleanup', async () => {
  const calls = [];
  const client = {
    branch: { fork: async () => ({ head: 'old' }) },
    sandbox: { create: async () => ({ sandbox: '1' }), close: async () => calls.push('close') },
    workspace: { mount: async () => ({ sandbox: '1', path: '/workspaces/1' }), exec: async () => { calls.push('exec'); throw Object.assign(new Error('lost reply'), { code: 'Unknown' }); }, unmount: async (ws, discard) => calls.push(['unmount', discard]) }
  };
  const env = await new LayerFSBackend(client, async () => {}).fork('old');
  await assert.rejects(env.exec('cmd'), { code: 'Unknown' });
  assert.deepEqual(calls, ['exec', ['unmount', true], 'close']);
});
test('readText pages complete lines and rejects silently truncated long lines', async () => {
  let page = 0;
  const backend = new LayerFSBackend({ fs: { read: async () => ++page === 1 ? { text: 'A\n', truncated: true, nextLine: 2 } : { text: 'B', truncated: false } } });
  assert.equal(await backend.readText('ref', '/x'), 'A\nB');
  backend.client.fs.read = async () => ({ text: 'prefix', lineTruncated: true });
  await assert.rejects(backend.readText('ref', '/x'), { code: 'TooLarge' });
});
test('close drains even noncacheable execution before releasing the backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'layercache-close-'));
  const backend = await LocalBackend.open(root);
  let finish;
  const registry = new ToolRegistry().register('wait', { version: '1', cacheable: false, execute: async () => { await new Promise(r => { finish = r; }); return 'ok'; } });
  const cache = new LayerCache({ backend, registry, baseRef: backend.baseRef });
  const work = cache.run('task', [{ name: 'wait' }]);
  while (!finish) await new Promise(r => setTimeout(r, 1));
  let closed = false;
  const closing = cache.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 5)); assert.equal(closed, false);
  finish(); assert.equal((await work).value, 'ok'); await closing;
  await assert.rejects(cache.run('task', [{ name: 'wait' }]), { code: 'Closed' });
  await rm(root, { recursive: true, force: true });
});
test('time buckets invalidate a whole state chain and allow fresh records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'layercache-ttl-'));
  const backend = await LocalBackend.open(root);
  const registry = new ToolRegistry().register('value', { version: '1', mutates: false, execute: async () => 'ok' });
  const cache = new LayerCache({ backend, registry, baseRef: backend.baseRef, ttlMs: 1000 });
  const now = Date.now;
  try {
    Date.now = () => 10000;
    assert.equal((await cache.run('t', [{ name: 'value' }])).hits, 0);
    assert.equal((await cache.run('t', [{ name: 'value' }])).hits, 1);
    Date.now = () => 11000;
    assert.equal((await cache.run('t', [{ name: 'value' }])).hits, 0);
    assert.equal((await cache.run('t', [{ name: 'value' }])).hits, 1);
  } finally { Date.now = now; await cache.close(); await rm(root, { recursive: true, force: true }); }
});
