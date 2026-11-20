#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { LayerCache, fileTools } from './index.js';
import { LocalBackend } from './backends/local.js';
import { LayerFSBackend } from './backends/layerfs.js';
import { serve } from './server.js';

const help = `LayerCache 0.1.0 — stateful tool prefix cache
Usage: layercache serve [options]
  --backend layerfs|local     default: layerfs
  --project NAME             existing LayerFS project
  --seed-ref REF             LayerFS seed branch/commit/layer (default main)
  --sdk PATH                 optional @layerfs/agent entry file
  --root PATH                local cache/owner-lock directory (default .layercache)
  --seed PATH                seed directory for local development backend
  --namespace NAME           cache index namespace (default default)
  --context PATH             JSON file: dataset, environment/image versions, etc.
  --resources PATH           JSON file containing initial external resources
  --tools PATH               module exporting registry (ToolRegistry)
  --host ADDRESS --port N    default 127.0.0.1:8088
  --ttl-ms N                 default checkpoint lifetime for newly written nodes
  --cleanup-interval-ms N    expired-node cleanup interval, 0 disables background cleanup
  --publication-capacity N   maximum outstanding cache writes (default 256)
  --publication-timeout-ms N time limit before record commit starts (default 60000)
  Token: LAYERCACHE_TOKEN environment variable. Shell tools execute code.
  layercache doctor          print prerequisite checks without mutation
`;

async function main() {
  const optionNames = ['backend', 'project', 'seed-ref', 'sdk', 'root', 'seed', 'namespace', 'context', 'resources', 'tools', 'host', 'port',
    'ttl-ms', 'cleanup-interval-ms', 'publication-capacity', 'publication-timeout-ms'];
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(optionNames.map(key => [key, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }]]))
  });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (command === 'doctor') {
    console.log(JSON.stringify({
      node: process.version,
      platform: process.platform,
      sdk: values.sdk ?? '@layerfs/agent',
      layerfs: Object.fromEntries(['HOME', 'STORE_PATH', 'IMAGE', 'VOLUME', 'DAEMON', 'WORKER_ENDPOINT'].map(key => [key, Boolean(process.env['LAYERFS_' + key])])),
      note: 'LayerFS 1.1.0 requires Linux or its official macOS/Windows worker. No automatic fallback.'
    }, null, 2));
    return;
  }
  if (command !== 'serve' || positionals.length !== 1) throw new Error(help);
  const port = Number(values.port ?? 8088);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const ttlMs = values['ttl-ms'] === undefined ? null : Number(values['ttl-ms']);
  const cleanupIntervalMs = values['cleanup-interval-ms'] === undefined ? 60_000 : Number(values['cleanup-interval-ms']);
  const root = resolve(values.root ?? '.layercache');
  const namespace = values.namespace ?? 'default';
  const registry = values.tools
    ? (await import(pathToFileURL(resolve(values.tools)).href)).registry
    : fileTools();
  const backendType = values.backend ?? 'layerfs';
  if (!['layerfs', 'local'].includes(backendType)) throw new Error('backend must be layerfs or local');
  const backend = backendType === 'local'
    ? await LocalBackend.open(root, values.seed)
    : await LayerFSBackend.open({
        project: values.project,
        seedRef: values['seed-ref'] ?? 'main',
        index: namespace,
        lockPath: resolve(root, 'layerfs-owner.lock'),
        sdkModule: values.sdk ? pathToFileURL(resolve(values.sdk)).href : '@layerfs/agent'
      });
  let cache;
  let endpoint;
  try {
    const context = values.context ? JSON.parse(await readFile(values.context, 'utf8')) : {};
    const resources = values.resources ? JSON.parse(await readFile(values.resources, 'utf8')) : [];
    cache = new LayerCache({
      backend,
      registry,
      baseRef: backend.baseRef,
      namespace,
      context,
      ttlMs,
      cleanupIntervalMs,
      publicationCapacity: Number(values['publication-capacity'] ?? 256),
      publicationTimeoutMs: Number(values['publication-timeout-ms'] ?? 60_000),
      resources
    });
    endpoint = await serve(cache, { port, host: values.host, token: process.env.LAYERCACHE_TOKEN });
  } catch (error) {
    if (cache) await cache.close();
    else await backend.close();
    throw error;
  }
  console.log(JSON.stringify({ event: 'listening', url: endpoint.url, backend: backendType, baseRef: backend.baseRef }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await endpoint.close();
      await cache.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.code ?? error.name, message: error.message }));
  process.exitCode = 1;
});
