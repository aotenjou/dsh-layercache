# API reference

## HTTP

Default `http://127.0.0.1:8088`; JSON responses. If configured, every route requires
`Authorization: Bearer <LAYERCACHE_TOKEN>`. A token is mandatory beyond loopback.
The service is intended for trusted training infrastructure. It grants tool
execution authority, including shell if that tool is registered.

| Route | Request | Result |
| --- | --- | --- |
| `GET /health` | none | `status, backend, baseRef` |
| `GET /v1/tools` | none | tool names, versions, mutation/cacheability flags |
| `POST /v1/run` | `{task, history, rollout?}` | final value/ref, scope, step values, hits/executed |
| `POST /v1/rollouts` | `{task}` | `{rollout, task, scope}`; create an independent rollout session |
| `POST /v1/rollouts/close` | `{rollout}` | `{closed:true}`; drain and release the session |
| `GET /v1/stats` | none | process counters; reset on restart |
| `GET /v1/tree?task=...` | optional task filter | persistent graph records |
| `POST /v1/prune` | `{task?, before?}` | `{removed, reclaimedSnapshots:false}` |

`before` is a Unix millisecond timestamp, compared strictly to node creation time.
Omitting it uses current time. A tree's `parent` is the prior mutation-chain key;
scope + key identify a node. Expired scopes remain inspectable in an unfiltered tree.

```json
{
  "task": "dataset-v1/sample-42",
  "history": [
    {"name":"file.write","arguments":{"path":"/state.txt","content":"A"}},
    {"name":"file.read","arguments":{"path":"/state.txt"}}
  ]
}
```

Response fields: `{task, scope, value, ref, steps, hits, executed}`. Each step has
`{call, value, hit, source, ref, key, executionMs}`. `source` is `execution`, `cache`,
or `rollout`. A `hit` includes a previous step in the same rollout or an execution
coalesced with another request. Cache hit metrics count only shared-cache reuse;
rollout prefix retention does not add to `savedExecutionMs`. `executionMs` is original execution + snapshot
cleanup time, excluding record publication; `savedExecutionMs` sums that estimate,
not measured wall-clock savings.

An error is `{error:{code,message,detail?}}`: 400 for invalid inputs/declarations,
401 for authentication, 404 for unknown routes, 409 for rollout lifecycle/capacity,
413 for oversized requests, 500
for tool/runtime/backend failures. Default request-body limit is 8 MiB. The Node
service and clients hold JSON values in memory; this is not a streaming result API.
Tool code errors do not become successful cached observations.

## Node

```js
import { LayerCache, fileTools } from 'dsh-layercache/core';
import { LayerFSBackend } from 'dsh-layercache/layerfs';

const backend = await LayerFSBackend.open({
  project: 'agent-data', seedRef: 'main', index: 'experiment-v1',
  lockPath: '/private/layercache/owner.lock'
});
const cache = new LayerCache({
  backend, registry: fileTools(), baseRef: backend.baseRef,
  namespace: 'experiment-v1', context: { dataset: 'v1', image: 'sha256:...' }
});
try {
  const run = await cache.run('sample-42', [/* calls */]);
  console.log(run.value);
} finally { await cache.close(); }
```

`LayerFSBackend.open` optionally accepts `sdkModule` (module URL/specifier) or an
already open `client` for embedding. The backend owns/ultimately closes this client.
`LayerCache` methods: `run(task, history, {rollout}?)`, `openRollout(task)`,
`closeRollout(rollout)`, `scope(task)`, `tree(task?)`, `stats()`,
`store.prune({before?, scope?})`, `close()`. `close` waits for active runs and is
idempotent. `run` after close refuses `Closed`.

Use one rollout session per incremental trajectory, especially with noncacheable
tools: `const {rollout} = cache.openRollout(task)`, then submit growing histories
with `{rollout}` and finish with `await cache.closeRollout(rollout)`. Prefix calls
must be identical and history may only grow. Calls on one session are serialized;
independent sessions share immutable cache nodes but retain their own uncached
state. Failures prevent further session execution (`RolloutFailed`). Unknown IDs
after close/restart refuse `UnknownRollout`. Sessions live in service memory and
are explicitly released; `maxRollouts` defaults to 1024. Plain `run` without a
session starts an independent evaluation, re-executing any uncached prefixes.

`ToolRegistry.register(name, {version, mutates=true, cacheable=true, execute})`
returns the registry. Handlers are async `(env, arguments) => JSONValue`.
Environment methods are `read('/path')`, `write('/path', text)`, `exec(command)`.
Shell requires `mutates:true`, because arbitrary shell cannot be proved read-only.
Register tools before serving requests, and treat the registry as immutable after
startup. State lives only inside the environment's filesystem; retaining a handle
after the handler returns is unsupported.

`LocalBackend.open(root, seedDirectory?)` uses file copying and content hashing.
Keep root outside the seed. It supports ordinary directories/files, not symlinks,
and uses the host shell without isolation. It caps shell stdout/stderr at 16 MiB.
LayerFS shell uses the upstream runtime output mechanism and collects text JSON
in memory. Manage command deadlines explicitly inside the command, e.g.
`timeout 110 python tool.py`; background descendants must finish before commit.

## Python

`Client(url, token=None, timeout=300)` uses standard-library urllib and exposes
`run(task, history, rollout=None)`, `open_rollout(task)`, `close_rollout(rollout)`,
`health()`, `stats()`. Each call owns its HTTP connection.
`AsyncExecutor(task_id, client=None)` exposes `await execute(full_history)` and
`last_result`, and is an async context manager. It runs blocking HTTP on a worker
thread and serializes calls on one executor; separate rollouts use separate
executors. `AsyncExecutor` lazily creates a rollout, retains its `rollout_id`,
and releases it on `close()`/context exit. An executor cannot run after close.
`ToolCall(name, arguments={}, cache=True)` serializes the wire format.

`LayerCacheError.code` and `.detail` retain server errors. A transport failure
raises `TransportError` and is never automatically replayed: the server might
already have committed. Cancelling an asyncio wait does not cancel an already
running HTTP request or its shell process. Wait/reconcile server state before
issuing another effectful call.
