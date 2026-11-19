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
  --tools PATH               module exporting registry (ToolRegistry)
  --host ADDRESS --port N    default 127.0.0.1:8088
  --ttl-ms N                 optional time-bucket lifetime
  Token: LAYERCACHE_TOKEN environment variable. Shell tools execute code.
  layercache doctor          print prerequisite checks without mutation
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['backend', 'project', 'seed-ref', 'sdk', 'root', 'seed', 'namespace', 'context', 'tools', 'host', 'port', 'ttl-ms'].map(k => [k, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }]])) });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (command === 'doctor') {
    console.log(JSON.stringify({ node: process.version, platform: process.platform, sdk: values.sdk ?? '@layerfs/agent', layerfs: Object.fromEntries(['HOME', 'STORE_PATH', 'IMAGE', 'VOLUME', 'DAEMON', 'WORKER_ENDPOINT'].map(k => [k, Boolean(process.env['LAYERFS_' + k])])), note: 'LayerFS 1.1.0 requires Linux or its official macOS/Windows worker. No automatic fallback.' }, null, 2)); return;
  }
  if (command !== 'serve' || positionals.length !== 1) throw new Error(help);
  const port = Number(values.port ?? 8088);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const root = resolve(values.root ?? '.layercache'), namespace = values.namespace ?? 'default';
  const registry = values.tools ? (await import(pathToFileURL(resolve(values.tools)).href)).registry : fileTools();
  const backendType = values.backend ?? 'layerfs';
  if (!['layerfs', 'local'].includes(backendType)) throw new Error('backend must be layerfs or local');
  const backend = backendType === 'local' ? await LocalBackend.open(root, values.seed) : await LayerFSBackend.open({ project: values.project, seedRef: values['seed-ref'] ?? 'main', index: namespace, lockPath: resolve(root, 'layerfs-owner.lock'), sdkModule: values.sdk ? pathToFileURL(resolve(values.sdk)).href : '@layerfs/agent' });
  let cache, endpoint;
  try {
    cache = new LayerCache({ backend, registry, baseRef: backend.baseRef, namespace, context: values.context ? JSON.parse(await readFile(values.context, 'utf8')) : {}, ttlMs: values['ttl-ms'] === undefined ? null : Number(values['ttl-ms']) });
    endpoint = await serve(cache, { port, host: values.host, token: process.env.LAYERCACHE_TOKEN });
  } catch (e) { await backend.close(); throw e; }
  console.log(JSON.stringify({ event: 'listening', url: endpoint.url, backend: backendType, baseRef: backend.baseRef }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; try { await endpoint.close(); await cache.close(); } catch (e) { console.error(e); process.exitCode = 1; } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(e => { console.error(JSON.stringify({ error: e.code ?? e.name, message: e.message })); process.exitCode = 1; });
