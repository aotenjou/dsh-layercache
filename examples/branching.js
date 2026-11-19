import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { LayerCache, fileTools } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';

const root = await mkdtemp(join(tmpdir(), 'layercache-demo-'));
const backend = await LocalBackend.open(root);
const cache = new LayerCache({ backend, registry: fileTools(), baseRef: backend.baseRef });
const history = suffix => [
  { name: 'file.write', arguments: { path: '/answer.txt', content: 'shared-prefix' } },
  { name: 'file.append', arguments: { path: '/answer.txt', content: suffix } },
  { name: 'file.read', arguments: { path: '/answer.txt' } }
];
try {
  for (const [label, suffix] of [['rollout A', '-A'], ['rollout B', '-B'], ['replay A', '-A']]) {
    const result = await cache.run('question-42', history(suffix));
    assert.equal(result.value, 'shared-prefix' + suffix);
    console.log(JSON.stringify({ label, value: result.value, hits: result.hits, executed: result.executed }));
  }
  console.log(JSON.stringify(cache.stats()));
} finally { await cache.close(); await rm(root, { recursive: true, force: true }); }
