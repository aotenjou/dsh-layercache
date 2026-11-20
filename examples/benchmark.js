// Synthetic tool latency is explicit; these numbers are not LayerFS speed claims.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayerCache, ToolRegistry } from '../src/index.js';
import { LocalBackend } from '../src/backends/local.js';

const latencyMs = Number(process.env.TOOL_LATENCY_MS ?? 20);
const registry = () => new ToolRegistry().register('step', {
  randomness: 'none',
  version: '1',
  execute: async (env, { value }) => {
    await new Promise(r => setTimeout(r, latencyMs));
    await env.write('/state.txt', value);
    return value;
  }
});
const rollouts = [['load', 'analyze', 'A'], ['load', 'analyze', 'B'], ['load', 'analyze', 'A'], ['load', 'analyze', 'B']];
const results = [];
for (const cached of [false, true]) {
  const root = await mkdtemp(join(tmpdir(), 'layercache-bench-'));
  const backend = await LocalBackend.open(root);
  const cache = new LayerCache({ backend, registry: registry(), baseRef: backend.baseRef });
  const start = performance.now();
  try {
    for (const values of rollouts) {
      const result = await cache.run('same-task', values.map(value => ({ name: 'step', arguments: { value }, cache: cached })));
      assert.equal(result.value, values.at(-1));
    }
    results.push({ backend: 'local-directory-copy', cached, latencyMs, elapsedMs: performance.now() - start, ...cache.stats() });
  } finally { await cache.close(); await rm(root, { recursive: true, force: true }); }
}
assert.equal(results[0].executions, 12); assert.equal(results[1].executions, 4);
console.log(JSON.stringify({ synthetic: true, rollouts: rollouts.length, results }, null, 2));
